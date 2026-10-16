import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * 课堂精练 across profiles: CC and Poki can share one knowledge repo and one
 * skill library. A run holds a host-wide lock per target repository —
 * identified by its normalised remote, not by any local path — so two bots
 * never read, draft and publish against the same repository at once. A dead
 * holder's lock goes stale on its own (proper-lockfile's mtime refresh).
 */

export interface DreamLockHolder {
  profile: string;
  batch: string;
  pid: number;
  since: number;
}

export interface HeldDreamLocks {
  release(): Promise<void>;
}

const STALE_MS = 120_000;
const UPDATE_MS = 30_000;

/**
 * `git@github.com:Org/Repo.git`, `ssh://git@github.com/org/repo`,
 * `https://user:token@github.com/org/repo.git` → `github.com/org/repo`.
 * Anything else (a local path) is kept as is, minus a trailing `.git` / `/`.
 */
export function canonicalRepoId(url: string): string {
  const trimmed = url.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes('://')) return tidy(`${scp[1]}/${scp[2]}`);
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'file:') return tidy(decodeURIComponent(parsed.pathname), false);
    return tidy(`${parsed.hostname}${parsed.pathname}`);
  } catch {
    return tidy(trimmed, false);
  }
}

function tidy(id: string, lower = true): string {
  const out = id.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+/g, '/');
  return lower ? out.toLowerCase() : out;
}

/**
 * Take every repository's lock or none. On conflict, says who holds it; the
 * caller defers rather than waits.
 */
export async function acquireDreamLocks(
  lockDir: string,
  repoUrls: readonly string[],
  holder: Omit<DreamLockHolder, 'pid' | 'since'>,
): Promise<HeldDreamLocks | { error: string }> {
  const ids = [...new Set(repoUrls.map(canonicalRepoId))].sort();
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  const held: Array<{ file: string; release: () => Promise<void> }> = [];
  const releaseAll = async () => {
    for (const lock of held.splice(0).reverse()) {
      await unlink(`${lock.file}.holder.json`).catch(() => undefined);
      await lock.release().catch(() => undefined);
    }
  };
  for (const id of ids) {
    const file = join(lockDir, `dream-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`);
    await writeFile(file, '', { flag: 'a', mode: 0o600 });
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(file, {
        realpath: false,
        stale: STALE_MS,
        update: UPDATE_MS,
        retries: 0,
        // Losing the lock mid-run must not crash the daemon (the default throws).
        onCompromised: (err) => log.warn('dream', 'lock-compromised', { repo: id, err: String(err) }),
      });
    } catch {
      const other = await readHolder(file);
      await releaseAll();
      return {
        error: other
          ? `profile ${other.profile} 正在整理同一个仓库（批次 ${other.batch}），稍后再试`
          : '另一个 bot 正在整理同一个仓库，稍后再试',
      };
    }
    held.push({ file, release });
    const meta: DreamLockHolder = { ...holder, pid: process.pid, since: Date.now() };
    await writeFileAtomic(`${file}.holder.json`, `${JSON.stringify(meta)}\n`, { mode: 0o600 }).catch(() => undefined);
  }
  return { release: releaseAll };
}

async function readHolder(file: string): Promise<DreamLockHolder | undefined> {
  try {
    const parsed = JSON.parse(await readFile(`${file}.holder.json`, 'utf8')) as Partial<DreamLockHolder>;
    return typeof parsed.profile === 'string' && typeof parsed.batch === 'string' ? (parsed as DreamLockHolder) : undefined;
  } catch {
    return undefined;
  }
}
