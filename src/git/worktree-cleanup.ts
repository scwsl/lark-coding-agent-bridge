import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { WorkspaceStore } from '../workspace/store';
import { log } from '../core/logger';
import { git, isSafeRef } from './exec';
import { listWorktrees, removeWorktree } from './worktree';

export interface CleanupInput {
  store: WorkspaceStore;
  /** Undefined disables cleanup. */
  idleDays: number | undefined;
  now?: number;
  isEnabled?: () => boolean;
  /** Re-read immediately before removal; errors abort the pass. */
  protectedPaths: () => Promise<string[]>;
}

function inside(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Only recorded bridge-owned trees, with Git and reference checks on every removal. */
export async function cleanupWorktrees(input: CleanupInput): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  if (input.idleDays === undefined || !Number.isFinite(input.idleDays) || input.idleDays < 1 || input.isEnabled?.() === false) return { removed };
  const now = input.now ?? Date.now();
  for (const candidate of input.store.listManagedWorktrees()) {
    if (input.isEnabled?.() === false) break;
    if (!Number.isFinite(candidate.lastUsedAt) || now - candidate.lastUsedAt < input.idleDays * 86400000) continue;
    if (!isAbsolute(candidate.path) || !isAbsolute(candidate.repoRoot) || !isSafeRef(candidate.branch)) continue;
    const trees = await listWorktrees(candidate.repoRoot);
    if ('error' in trees) continue;
    const tree = trees.find(e => e.path === candidate.path);
    const main = trees.find(e => e.main);
    if (!tree || !main || tree.main || tree.locked || tree.detached || tree.branch !== candidate.branch || !main.branch || tree.branch === main.branch) continue;
    const remoteHead = await git(main.path, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    const defaultBranch = remoteHead.ok && remoteHead.stdout.trim().startsWith('refs/remotes/origin/')
      ? remoteHead.stdout.trim().slice('refs/remotes/origin/'.length)
      : (await git(main.path, ['show-ref', '--verify', '--quiet', 'refs/heads/main'])).ok ? 'main' : 'master';
    if (!isSafeRef(defaultBranch) || candidate.branch === defaultBranch) continue;
    // Branch tips are pinned for the ancestry check and compare-and-delete.
    const tip = await git(main.path, ['rev-parse', `refs/heads/${candidate.branch}`]);
    const target = await git(main.path, ['rev-parse', `refs/heads/${defaultBranch}`]);
    if (!tip.ok || !target.ok || !/^[a-f0-9]{40,64}\s*$/.test(tip.stdout) || !/^[a-f0-9]{40,64}\s*$/.test(target.stdout)) continue;
    const merged = await git(main.path, ['merge-base', '--is-ancestor', tip.stdout.trim(), target.stdout.trim()]);
    if (!merged.ok) continue;
    const status = await git(tree.path, ['status', '--porcelain', '--untracked-files=all', '--ignored']);
    if (!status.ok || status.truncated || status.stdout.trim()) continue;
    const canonical = await realpath(tree.path);
    const protectedNow = [ ...Object.values(input.store.listCwds()), ...Object.values(input.store.listNamed()), ...await input.protectedPaths() ];
    let used = false;
    for (const path of protectedNow) if (inside(await realpath(path).catch(() => resolve(path)), canonical)) { used = true; break; }
    if (used) { input.store.touchWorktree(candidate.path, now); continue; }
    if (input.isEnabled?.() === false) break;
    // No --force: Git checks the working tree again and refuses locked/dirty trees.
    const result = await removeWorktree(main.path, tree.path);
    if ('error' in result) { log.warn('worktree', 'cleanup-skipped', { path: tree.path, reason: result.error }); continue; }
    if (candidate.ownedBranch === true) {
      // Refuse to delete a tip moved since the verified merge check.
      const deleted = await git(main.path, ['update-ref', '-d', `refs/heads/${candidate.branch}`, tip.stdout.trim()]);
      if (!deleted.ok) log.warn('worktree', 'cleanup-branch-kept', { branch: candidate.branch });
    }
    input.store.forgetWorktree(candidate.path);
    removed.push(candidate.path);
    log.info('worktree', 'auto-cleaned', { path: candidate.path, branch: candidate.branch });
  }
  await input.store.flush();
  return { removed };
}

function objectRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid protection data');
  return input as Record<string, unknown>;
}

/** Protect references across all profiles, including offline profiles and scheduled jobs. */
export async function protectedWorkspacePaths(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  const config = JSON.parse(await readFile(join(rootDir, 'config.json'), 'utf8')) as { profiles: Record<string, { workspaces?: { default?: string } }> };
  for (const cfg of Object.values(config.profiles)) if (cfg.workspaces?.default) out.push(cfg.workspaces.default);
  for (const dir of await readdir(join(rootDir, 'profiles'), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const profileDir = join(rootDir, 'profiles', dir.name);
    for (const file of ['workspaces.json', 'jobs.json', 'runs.json']) {
      let raw: Record<string, unknown>;
      try { raw = objectRecord(JSON.parse(await readFile(join(profileDir, file), 'utf8'))); }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; throw err; }
      if (file === 'workspaces.json') {
        for (const item of Object.values(objectRecord(raw.chats ?? {}))) {
          const cwd = objectRecord(item).cwd;
          if (typeof cwd !== 'string') throw new Error('invalid workspace cwd');
          out.push(cwd);
        }
        for (const cwd of Object.values(objectRecord(raw.named ?? {}))) {
          if (typeof cwd !== 'string') throw new Error('invalid named workspace');
          out.push(cwd);
        }
      } else if (file === 'jobs.json') {
        for (const item of Object.values(objectRecord(raw.jobs ?? {}))) {
          const cwd = objectRecord(item).cwd;
          if (cwd !== undefined && typeof cwd !== 'string') throw new Error('invalid job cwd');
          if (typeof cwd === 'string') out.push(cwd);
        }
      } else if (Object.keys(raw).length > 0) {
        // Other daemons' live processes may have changed their cwd. Defer this pass.
        throw new Error('profile has pending run records');
      }
    }
  }
  return out;
}

export function startWorktreeCleanup(input: Omit<CleanupInput, 'idleDays'> & { idleDays: () => number | undefined }): { stop(): Promise<void> } {
  let stopped = false;
  let running: Promise<unknown> | undefined;
  const tick = () => {
    if (stopped || running || input.idleDays() === undefined) return;
    running = cleanupWorktrees({ ...input, idleDays: input.idleDays(), isEnabled: () => !stopped && input.idleDays() !== undefined })
      .catch(err => log.warn('worktree', 'cleanup-deferred', { reason: String(err) }))
      .finally(() => { running = undefined; });
  };
  const timer = setInterval(tick, 3600000);
  timer.unref();
  return { stop: async () => { stopped = true; clearInterval(timer); await running; } };
}
