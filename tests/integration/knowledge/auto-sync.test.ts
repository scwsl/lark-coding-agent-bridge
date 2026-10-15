import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { git, isGitError } from '../../../src/git/exec';
import {
  DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MINUTES,
  getKnowledgeSyncIntervalMinutes,
  KnowledgeAutoSync,
  summarizeSyncError,
} from '../../../src/knowledge/auto-sync';
import { KnowledgeStore } from '../../../src/knowledge/store';
import { bindKnowledgeRemote, syncKnowledge } from '../../../src/knowledge/sync';

/** Real git against a local bare repository, timers driven by calling `tick()` directly. */

// Several real git rounds per test; the 5s default is too tight when the whole
// suite runs in parallel.
const GIT_TIMEOUT_MS = 30_000;

let root: string;
let remote: string;
let store: KnowledgeStore;
let sent: Array<{ to: string; text: string }>;
let owner: string | undefined;
let interval: number;
const loops: KnowledgeAutoSync[] = [];

function autoSync(opts: { startDelayMs?: number } = {}): KnowledgeAutoSync {
  const loop = new KnowledgeAutoSync({
    store,
    intervalMinutes: () => interval,
    owner: () => owner,
    send: async (to, text) => {
      sent.push({ to, text });
    },
    ...(opts.startDelayMs !== undefined ? { startDelayMs: opts.startDelayMs } : {}),
  });
  loops.push(loop);
  return loop;
}

async function remoteFile(path: string): Promise<string> {
  const show = await git(remote, ['show', `main:${path}`]);
  return show.ok ? show.stdout : '';
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lcb-knowledge-auto-sync-'));
  remote = join(root, 'remote.git');
  await mkdir(remote, { recursive: true });
  const init = await git(remote, ['init', '--bare', '--initial-branch=main']);
  if (!init.ok) throw new Error(init.stderr);
  store = new KnowledgeStore(join(root, 'bot', 'knowledge'));
  await store.ensure();
  sent = [];
  owner = 'ou_owner';
  interval = 30;
});

afterEach(async () => {
  await Promise.all(loops.splice(0).map((loop) => loop.stop()));
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe('knowledge auto-sync', { timeout: GIT_TIMEOUT_MS }, () => {
  it('does nothing until the directory is a repository with a remote', async () => {
    const loop = autoSync();
    await store.addMemory({ kind: 'profile' }, '还没绑定');
    expect(await loop.tick()).toBeUndefined();

    // A repository without `origin` is still nothing to sync with.
    expect((await git(store.dir, ['init', '-q', '--initial-branch=main'])).ok).toBe(true);
    expect(await loop.tick()).toBeUndefined();
    expect((await git(store.dir, ['log', '--oneline'])).ok).toBe(false);
    expect(loop.status().last).toBeUndefined();
  });

  it('syncs a bound directory with its remote', async () => {
    expect(isGitError(await bindKnowledgeRemote(store, remote))).toBe(false);
    await store.addMemory({ kind: 'profile' }, '自动推上去');
    const loop = autoSync();

    const record = await loop.tick();
    expect(record).toMatchObject({ trigger: 'auto', ok: true, pushed: true });
    expect(record!.committed).toBeGreaterThan(0);
    expect(await remoteFile('MEMORY.md')).toContain('自动推上去');
    expect(await remoteFile('.gitattributes')).toContain('MEMORY.md merge=union');
    expect(loop.status()).toMatchObject({ intervalMinutes: 30, failures: 0, syncing: false, last: { ok: true } });
  });

  it('runs the first round on its own after the start-up delay', async () => {
    expect(isGitError(await bindKnowledgeRemote(store, remote))).toBe(false);
    await store.addMemory({ kind: 'profile' }, '启动后同步');
    const loop = autoSync({ startDelayMs: 0 });
    loop.start();

    await vi.waitFor(() => expect(loop.status().last?.ok).toBe(true), { timeout: 15_000, interval: 50 });
    expect(await remoteFile('MEMORY.md')).toContain('启动后同步');
  });

  it('schedules nothing when the interval is 0', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    interval = 0;
    const loop = autoSync();
    loop.start();
    expect(vi.getTimerCount()).toBe(0);
    expect(loop.status().intervalMinutes).toBe(0);

    interval = 30;
    const on = autoSync();
    on.start();
    expect(vi.getTimerCount()).toBe(1);
    await on.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts or restarts the wait when the interval changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    interval = 0;
    const loop = autoSync();
    loop.start();
    expect(vi.getTimerCount()).toBe(0);

    interval = 5;
    loop.reschedule();
    expect(vi.getTimerCount()).toBe(1);
    const tick = vi.spyOn(loop, 'tick').mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(tick).toHaveBeenCalledTimes(1);

    interval = 0;
    loop.reschedule();
    expect(vi.getTimerCount()).toBe(0);
    await loop.stop();
    loop.reschedule();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never runs git alongside a manual /knowledge sync', async () => {
    expect(isGitError(await bindKnowledgeRemote(store, remote))).toBe(false);
    await store.addMemory({ kind: 'profile' }, '自动那轮的');
    const loop = autoSync();

    const auto = loop.tick();
    // Written while the automatic round may be anywhere between commit and
    // push; the manual sync queued behind it still has to carry it.
    await store.addMemory({ kind: 'profile' }, '手动那轮的');
    const manual = syncKnowledge(store);
    const [autoRecord, manualResult] = await Promise.all([auto, manual]);

    expect(autoRecord?.ok).toBe(true);
    if (isGitError(manualResult)) throw new Error(manualResult.error);
    expect(manualResult.pushed).toBe(true);
    const memory = await remoteFile('MEMORY.md');
    expect(memory).toContain('自动那轮的');
    expect(memory).toContain('手动那轮的');
    expect((await git(store.dir, ['status', '--porcelain'])).stdout.trim()).toBe('');
  });

  it('tells the owner once per failure streak, on the second failed round', async () => {
    expect(isGitError(await bindKnowledgeRemote(store, remote))).toBe(false);
    const loop = autoSync();
    const gone = join(root, 'remote-gone.git');
    await rename(remote, gone);
    await store.addMemory({ kind: 'profile' }, '推不上去');

    const first = await loop.tick();
    expect(first).toMatchObject({ ok: false });
    expect(first!.error).toMatch(/推送失败：fatal:/);
    expect(sent).toEqual([]);

    expect((await loop.tick())?.ok).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('ou_owner');
    expect(sent[0]!.text).toContain('连续 2 次失败');
    expect(sent[0]!.text).toContain('fatal:');
    expect(sent[0]!.text).toContain(store.dir);
    expect(sent[0]!.text).toContain('/knowledge sync');

    expect((await loop.tick())?.ok).toBe(false);
    expect(sent).toHaveLength(1);
    expect(loop.status().failures).toBe(3);

    // Back online: the owner who was told hears that it is over, once.
    await rename(gone, remote);
    expect((await loop.tick())?.ok).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain('已恢复');
    expect(loop.status().failures).toBe(0);
    expect(await remoteFile('MEMORY.md')).toContain('推不上去');
  });

  it('stays quiet about a single failure and pages again on a new streak', async () => {
    expect(isGitError(await bindKnowledgeRemote(store, remote))).toBe(false);
    const loop = autoSync();
    const gone = join(root, 'remote-gone.git');

    await rename(remote, gone);
    await loop.tick();
    await rename(gone, remote);
    expect((await loop.tick())?.ok).toBe(true);
    // One blip, then fine: nobody hears about it, not even "recovered".
    expect(sent).toEqual([]);

    await rename(remote, gone);
    await loop.tick();
    await loop.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('连续 2 次失败');
  });

  it('only logs when the owner is unknown, and a manual success ends a streak quietly', async () => {
    owner = undefined;
    expect(isGitError(await bindKnowledgeRemote(store, remote))).toBe(false);
    const loop = autoSync();
    const gone = join(root, 'remote-gone.git');
    await rename(remote, gone);
    await loop.tick();
    await loop.tick();
    expect(sent).toEqual([]);
    expect(loop.status().failures).toBe(2);

    // A manual failure is seen by whoever ran it, so it does not count.
    loop.noteManual(await syncKnowledge(store));
    expect(loop.status()).toMatchObject({ failures: 2, last: { trigger: 'manual', ok: false } });

    owner = 'ou_owner';
    await rename(gone, remote);
    loop.noteManual(await syncKnowledge(store));
    expect(loop.status()).toMatchObject({ failures: 0, last: { trigger: 'manual', ok: true } });
    expect(sent).toEqual([]);
  });

  it('lets a round already running finish when stopped', async () => {
    expect(isGitError(await bindKnowledgeRemote(store, remote))).toBe(false);
    await store.addMemory({ kind: 'profile' }, '停之前那轮');
    const loop = autoSync({ startDelayMs: 0 });
    loop.start();
    await vi.waitFor(() => expect(loop.status().syncing).toBe(true), { timeout: 10_000, interval: 5 });

    await loop.stop();
    expect(loop.status()).toMatchObject({ syncing: false, last: { ok: true } });
    expect(await remoteFile('MEMORY.md')).toContain('停之前那轮');
  });
});

describe('helpers', () => {
  it('defaults the interval when the profile has no knowledge section', () => {
    expect(getKnowledgeSyncIntervalMinutes(undefined)).toBe(DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MINUTES);
    expect(getKnowledgeSyncIntervalMinutes({})).toBe(30);
    expect(getKnowledgeSyncIntervalMinutes({ syncIntervalMinutes: 0 })).toBe(0);
  });

  it('boils a git failure down to the stage and its first fatal / error line, credentials masked', () => {
    expect(
      summarizeSyncError(
        "推送失败：fatal: unable to access 'https://bot:s3cret@github.com/a/b.git/': Could not resolve host\nhint: check the URL",
      ),
    ).toBe("推送失败：fatal: unable to access 'https://***@github.com/a/b.git/': Could not resolve host");
    expect(
      summarizeSyncError(
        '拉取失败（已回滚）：From /srv/remote\n * branch main -> FETCH_HEAD\nerror: could not apply 1a2b3c... knowledge: sync\nhint: Resolve all conflicts',
      ),
    ).toBe('拉取失败（已回滚）：error: could not apply 1a2b3c... knowledge: sync');
    expect(summarizeSyncError('知识目录还不是 git 仓库')).toBe('知识目录还不是 git 仓库');
    expect(summarizeSyncError('x'.repeat(500)).length).toBeLessThanOrEqual(300);
  });
});
