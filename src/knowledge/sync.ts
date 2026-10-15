import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { git, isGitError } from '../git/exec';
import { readRepoStatus, type GitRepoStatus } from '../git/status';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { KnowledgeStore } from './store';

/**
 * Git synchronisation for the knowledge directory.
 *
 * The directory is an ordinary git repository, so "sync between machines and
 * profiles" is just commit + pull --rebase + push. Nothing here invents a
 * protocol: the point is that the same content can be reviewed as a diff and
 * edited outside the bridge.
 *
 * Every git operation on one directory — `/knowledge bind|unbind|sync` and the
 * automatic sync (`auto-sync.ts`) — goes through {@link serialized}, so two of
 * them never race on the index or a half-done rebase.
 */

export interface SyncOutcome {
  committed: number;
  pulled: boolean;
  pushed: boolean;
  /** Non-fatal explanation, e.g. "no remote configured". */
  note?: string;
}

const SYNC_TIMEOUT_MS = 60_000;

/**
 * Memory files are append-only line lists, so two bots appending to the same
 * file at once is not a real conflict: `merge=union` keeps both sides' lines.
 * The trade-off is that a removal racing an append on the other side can come
 * back; that is preferable to a sync that stops until someone resolves it.
 * Without a slash `MEMORY.md` matches at any depth, which also covers memory
 * indexes kept under `notes/`.
 */
export const MEMORY_MERGE_ATTRIBUTES = ['MEMORY.md merge=union', 'chats/*.md merge=union'] as const;

/** Tail of the per-directory queue; see {@link serialized}. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Run `task` after whatever git operation is already running in this
 * directory, so a manual `/knowledge sync` that arrives during an automatic
 * one waits for it and then does its own full round (its commit has to
 * include whatever was written meanwhile). Keyed by path, not by store
 * object: a reconnect builds a new store for the same directory while the old
 * one's sync may still be finishing.
 */
function serialized<T>(store: KnowledgeStore, task: () => Promise<T>): Promise<T> {
  const key = resolve(store.dir);
  const run = (queues.get(key) ?? Promise.resolve()).then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

export async function knowledgeRepoStatus(
  store: KnowledgeStore,
): Promise<GitRepoStatus | undefined> {
  return readRepoStatus(store.dir).catch(() => undefined);
}

export async function knowledgeRemoteUrl(store: KnowledgeStore): Promise<string | undefined> {
  const result = await git(store.dir, ['remote', 'get-url', 'origin']);
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

/**
 * Point the knowledge directory at a remote, creating the repository if needed
 * and taking whatever is already on the remote.
 *
 * Existing local content is preserved: the remote history is merged in with
 * `--allow-unrelated-histories`, because "I already wrote notes here and now I
 * want them on my other machine too" is the normal way into this feature.
 */
export function bindKnowledgeRemote(
  store: KnowledgeStore,
  url: string,
): Promise<{ ok: true; note?: string } | { error: string }> {
  return serialized(store, () => bindRemote(store, url));
}

async function bindRemote(
  store: KnowledgeStore,
  url: string,
): Promise<{ ok: true; note?: string } | { error: string }> {
  if (!isPlausibleGitUrl(url)) return { error: `看起来不像 git 仓库地址：${url}` };
  await store.ensure();

  // A directory that merely sits inside some other repository (a dotfiles
  // repo in $HOME, say) gets its own; otherwise `origin` below would rewire
  // the outer one.
  if (!(await ownRepoStatus(store))) {
    const init = await git(store.dir, ['init', '--initial-branch=main']);
    if (!init.ok) return { error: init.stderr || 'git init 失败' };
  }

  const setUrl = await git(store.dir, ['remote', 'set-url', 'origin', url]);
  if (!setUrl.ok) {
    const add = await git(store.dir, ['remote', 'add', 'origin', url]);
    if (!add.ok) return { error: add.stderr || '设置 origin 失败' };
  }

  // Before the merge below, so memory files both sides already have are
  // unioned instead of conflicting.
  await commitMergeAttributes(store);
  await commitAll(store, 'knowledge: bind remote');
  const fetch = await git(store.dir, ['fetch', 'origin'], { timeoutMs: SYNC_TIMEOUT_MS });
  if (!fetch.ok) {
    return { error: `连不上远端：${fetch.stderr || 'git fetch 失败'}` };
  }

  const remoteBranch = await defaultRemoteBranch(store);
  if (!remoteBranch) {
    // Empty remote: nothing to merge, the first push will seed it.
    return { ok: true, note: '远端还是空的，下次 sync 会把本地内容推上去。' };
  }
  const merge = await git(
    store.dir,
    ['merge', '--allow-unrelated-histories', '--no-edit', `origin/${remoteBranch}`],
    { timeoutMs: SYNC_TIMEOUT_MS },
  );
  if (!merge.ok) {
    return { error: `合并远端内容失败（可能有冲突，需要在 ${store.dir} 手动处理）：${merge.stderr}` };
  }
  return { ok: true };
}

export function unbindKnowledgeRemote(
  store: KnowledgeStore,
): Promise<{ ok: true } | { error: string }> {
  return serialized(store, async () => {
    const result = await git(store.dir, ['remote', 'remove', 'origin']);
    if (!result.ok) return { error: result.stderr || '没有配置 origin' };
    return { ok: true as const };
  });
}

/**
 * Commit local edits, take the remote's, then publish. Queued behind any other
 * git operation on the same directory (see {@link serialized}).
 */
export function syncKnowledge(store: KnowledgeStore): Promise<SyncOutcome | { error: string }> {
  return serialized(store, () => runSync(store));
}

/**
 * Whether the directory is a repository of its own with an `origin` — the
 * only state in which an automatic sync has anything to do.
 */
export async function knowledgeSyncConfigured(store: KnowledgeStore): Promise<boolean> {
  return Boolean((await ownRepoStatus(store)) && (await knowledgeRemoteUrl(store)));
}

async function runSync(store: KnowledgeStore): Promise<SyncOutcome | { error: string }> {
  const status = await ownRepoStatus(store);
  if (!status) return { error: '知识目录还不是 git 仓库，先用 `/knowledge bind <仓库地址>`。' };
  // Committing on top of an unfinished merge / rebase would record conflict
  // markers, and aborting it could throw away someone's manual resolution.
  const unfinished = await unfinishedOperation(store);
  if (unfinished) {
    return { error: `知识目录里有未完成的 ${unfinished}，先在 ${store.dir} 处理完（或 \`git ${unfinished} --abort\`）再同步。` };
  }

  // Its own commit, ahead of the memory edits: a rebase only honours
  // attributes already in the working tree, so `.gitattributes` arriving in
  // the same commit as a conflicting append would not apply to it.
  await commitMergeAttributes(store);
  const committed = await commitAll(store, `knowledge: sync ${new Date().toISOString()}`);
  const remote = await knowledgeRemoteUrl(store);
  if (!remote) {
    return { committed, pulled: false, pushed: false, note: '没有配置远端，只做了本地提交。' };
  }

  const branch = status.branch ?? 'main';
  let pulled = false;
  // Two bots bound to one remote often sync at the same moment (both restart
  // together); the loser's push is rejected as non-fast-forward, and one more
  // pull + push settles it instead of failing the whole round.
  for (let attempt = 1; ; attempt += 1) {
    // A remote that does not have this branch yet (freshly created repo) has
    // nothing to pull; asking anyway fails with "couldn't find remote ref".
    if (await hasRemoteBranch(store, branch)) {
      // `--autostash`: a memory written after the commit above would
      // otherwise make the rebase refuse to start.
      const pull = await git(store.dir, ['pull', '--rebase', '--autostash', 'origin', branch], {
        timeoutMs: SYNC_TIMEOUT_MS,
      });
      if (!pull.ok) {
        // A rebase that stopped halfway leaves the directory mid-operation; say
        // so rather than pushing a half-merged state.
        await git(store.dir, ['rebase', '--abort']);
        return { error: `拉取失败（已回滚）：${pull.stderr || 'git pull 失败'}` };
      }
      pulled = true;
    }

    // `-u` so the branch gets an upstream on the very first push, which is what
    // makes `/knowledge` able to show ↑/↓ afterwards.
    const push = await git(store.dir, ['push', '-u', 'origin', branch], { timeoutMs: SYNC_TIMEOUT_MS });
    if (push.ok) break;
    if (attempt < 2 && isRejectedPush(push.stderr)) continue;
    return { error: `推送失败：${push.stderr || 'git push 失败'}` };
  }

  log.info('knowledge', 'synced', { committed, branch, pulled });
  return { committed, pulled, pushed: true };
}

/**
 * Make sure `.gitattributes` asks for union merges of the memory files,
 * appending whatever lines are missing and leaving the rest of the file alone.
 * Returns whether the file changed.
 */
export async function ensureMemoryMergeAttributes(store: KnowledgeStore): Promise<boolean> {
  const file = join(store.dir, '.gitattributes');
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const present = new Set(current.split('\n').map((line) => line.trim().replace(/\s+/g, ' ')));
  const missing = MEMORY_MERGE_ATTRIBUTES.filter((line) => !present.has(line));
  if (missing.length === 0) return false;
  const separator = current && !current.endsWith('\n') ? '\n' : '';
  await writeFileAtomic(file, `${current}${separator}${missing.join('\n')}\n`, { mode: 0o600 });
  return true;
}

/** {@link ensureMemoryMergeAttributes}, committed on its own when it is new or changed. */
async function commitMergeAttributes(store: KnowledgeStore): Promise<void> {
  try {
    await ensureMemoryMergeAttributes(store);
  } catch (err) {
    log.warn('knowledge', 'gitattributes-failed', { err: String(err) });
    return;
  }
  const add = await git(store.dir, ['add', '--', '.gitattributes']);
  if (!add.ok) return;
  const staged = await git(store.dir, ['diff', '--cached', '--name-only', '--', '.gitattributes']);
  if (!staged.ok || !staged.stdout.trim()) return;
  await ensureIdentity(store);
  // `--` + path: only this file, whatever else happens to be staged.
  await git(store.dir, ['commit', '-m', 'knowledge: union merge for memory files', '--', '.gitattributes']);
}

/** Stage and commit everything; returns the number of files in the commit. */
async function commitAll(store: KnowledgeStore, message: string): Promise<number> {
  const add = await git(store.dir, ['add', '-A']);
  if (!add.ok) return 0;
  const staged = await git(store.dir, ['diff', '--cached', '--name-only']);
  const count = staged.ok ? staged.stdout.split('\n').filter(Boolean).length : 0;
  if (count === 0) return 0;

  await ensureIdentity(store);
  const commit = await git(store.dir, ['commit', '-m', message]);
  return commit.ok ? count : 0;
}

/**
 * A knowledge repo is bridge-owned; identity is set locally so it works on a
 * machine with no global git identity at all.
 */
async function ensureIdentity(store: KnowledgeStore): Promise<void> {
  await git(store.dir, ['config', 'user.name', 'lark-channel-bridge']);
  await git(store.dir, ['config', 'user.email', 'bridge@localhost']);
}

/**
 * Repository status when the knowledge directory is the root of its own
 * repository; `undefined` when it is not a repository, or only a
 * subdirectory of an unrelated one — committing with `add -A` there would
 * sweep up the outer repository's changes.
 */
export async function ownRepoStatus(store: KnowledgeStore): Promise<GitRepoStatus | undefined> {
  const status = await readRepoStatus(store.dir).catch(() => undefined);
  if (!status) return undefined;
  // Empty prefix = the directory is the top level. Asking git avoids comparing
  // paths across symlinks, `/private` on macOS and drive-letter spellings.
  const prefix = await git(store.dir, ['rev-parse', '--show-prefix']);
  return prefix.ok && prefix.stdout.trim() === '' ? status : undefined;
}

/** `merge` / `rebase` / `cherry-pick` left half-done in the directory, if any. */
async function unfinishedOperation(store: KnowledgeStore): Promise<string | undefined> {
  const gitDir = await git(store.dir, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir.ok) return undefined;
  const dir = gitDir.stdout.trim();
  const markers: Array<[string, string]> = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ];
  for (const [marker, operation] of markers) {
    if (await stat(join(dir, marker)).then(() => true, () => false)) return operation;
  }
  return undefined;
}

/**
 * Someone else pushed between our pull and our push: either before it started
 * (`[rejected] … (fetch first)`) or while it was running (the remote cannot
 * move the ref from the value we were shown). Exported for tests.
 */
export function isRejectedPush(stderr: string): boolean {
  return /\[rejected\]|non-fast-forward|fetch first|cannot lock ref|failed to update ref/i.test(stderr);
}

async function hasRemoteBranch(store: KnowledgeStore, branch: string): Promise<boolean> {
  const heads = await git(store.dir, ['ls-remote', '--heads', 'origin', branch], {
    timeoutMs: SYNC_TIMEOUT_MS,
  });
  return heads.ok && heads.stdout.trim().length > 0;
}

async function defaultRemoteBranch(store: KnowledgeStore): Promise<string | undefined> {
  const heads = await git(store.dir, ['ls-remote', '--heads', 'origin'], {
    timeoutMs: SYNC_TIMEOUT_MS,
  });
  if (!heads.ok || !heads.stdout.trim()) return undefined;
  const names = heads.stdout
    .split('\n')
    .map((line) => line.split('refs/heads/')[1]?.trim())
    .filter((name): name is string => Boolean(name));
  return names.includes('main') ? 'main' : names[0];
}

export function isPlausibleGitUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.startsWith('-')) return false;
  return (
    /^https?:\/\/\S+$/.test(trimmed) ||
    /^git@[^:]+:\S+$/.test(trimmed) ||
    /^ssh:\/\/\S+$/.test(trimmed) ||
    trimmed.startsWith('/')
  );
}

export { isGitError };
