import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, isGitError } from '../../../src/git/exec';
import { KnowledgeStore } from '../../../src/knowledge/store';
import {
  bindKnowledgeRemote,
  ensureMemoryMergeAttributes,
  isRejectedPush,
  knowledgeRemoteUrl,
  knowledgeRepoStatus,
  syncKnowledge,
  unbindKnowledgeRemote,
} from '../../../src/knowledge/sync';

/** Real git against a local bare repository — the sync path is all git plumbing. */

// Several real git rounds per test; the 5s default is too tight when the whole
// suite runs in parallel.
const GIT_TIMEOUT_MS = 30_000;

let root: string;
let remote: string;

async function freshStore(name: string): Promise<KnowledgeStore> {
  const store = new KnowledgeStore(join(root, name, 'knowledge'));
  await store.ensure();
  return store;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lcb-knowledge-sync-'));
  remote = join(root, 'remote.git');
  await mkdir(remote, { recursive: true });
  const init = await git(remote, ['init', '--bare', '--initial-branch=main']);
  if (!init.ok) throw new Error(init.stderr);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe('knowledge sync', { timeout: GIT_TIMEOUT_MS }, () => {
  it('binds an empty remote, pushes local content, and seeds a second machine', async () => {
    const laptop = await freshStore('laptop');
    await laptop.addMemory({ kind: 'profile' }, '提交信息不要带 AI 署名');
    await mkdir(join(laptop.skillsDir, 'deploy'), { recursive: true });
    await writeFile(
      join(laptop.skillsDir, 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: 发布步骤\n---\n',
    );

    const bound = await bindKnowledgeRemote(laptop, remote);
    expect(isGitError(bound)).toBe(false);
    expect(await knowledgeRemoteUrl(laptop)).toBe(remote);

    const synced = await syncKnowledge(laptop);
    if (isGitError(synced)) throw new Error(synced.error);
    expect(synced.pushed).toBe(true);

    // A second profile / machine binding the same remote gets everything.
    const desktop = await freshStore('desktop');
    const boundDesktop = await bindKnowledgeRemote(desktop, remote);
    expect(isGitError(boundDesktop)).toBe(false);
    expect(await desktop.listMemories({ kind: 'profile' })).toMatchObject([
      { text: '提交信息不要带 AI 署名' },
    ]);
    expect(await desktop.listSkills()).toMatchObject([{ name: 'deploy', description: '发布步骤' }]);
  });

  it('merges content that already existed on both sides', async () => {
    const laptop = await freshStore('laptop');
    await laptop.addMemory({ kind: 'profile' }, '来自笔记本');
    expect(isGitError(await bindKnowledgeRemote(laptop, remote))).toBe(false);
    expect(isGitError(await syncKnowledge(laptop))).toBe(false);

    const desktop = await freshStore('desktop');
    // Local notes written before binding must survive the merge.
    await desktop.addMemory({ kind: 'chat', scopeId: 'oc_desktop' }, '来自台式机');
    expect(isGitError(await bindKnowledgeRemote(desktop, remote))).toBe(false);

    expect(await desktop.listMemories({ kind: 'profile' })).toMatchObject([{ text: '来自笔记本' }]);
    expect(await desktop.listMemories({ kind: 'chat', scopeId: 'oc_desktop' })).toMatchObject([
      { text: '来自台式机' },
    ]);
  });

  it('round-trips an edit made on the other machine', async () => {
    const laptop = await freshStore('laptop');
    await bindKnowledgeRemote(laptop, remote);
    await syncKnowledge(laptop);

    const desktop = await freshStore('desktop');
    await bindKnowledgeRemote(desktop, remote);
    await desktop.addMemory({ kind: 'profile' }, '台式机加的规则');
    expect(isGitError(await syncKnowledge(desktop))).toBe(false);

    expect(await laptop.listMemories({ kind: 'profile' })).toHaveLength(0);
    const pulled = await syncKnowledge(laptop);
    if (isGitError(pulled)) throw new Error(pulled.error);
    expect(pulled.pulled).toBe(true);
    expect(await laptop.listMemories({ kind: 'profile' })).toMatchObject([
      { text: '台式机加的规则' },
    ]);
  });

  it('commits locally and says so when there is no remote', async () => {
    const store = await freshStore('solo');
    const init = await git(store.dir, ['init', '--initial-branch=main']);
    expect(init.ok).toBe(true);
    await store.addMemory({ kind: 'profile' }, '只在本地');

    const result = await syncKnowledge(store);
    if (isGitError(result)) throw new Error(result.error);
    expect(result).toMatchObject({ pushed: false, pulled: false });
    expect(result.committed).toBeGreaterThan(0);
    expect(result.note).toContain('没有配置远端');
  });

  it('refuses to sync a directory that was never bound', async () => {
    const store = await freshStore('unbound');
    expect(await syncKnowledge(store)).toMatchObject({ error: expect.stringContaining('bind') });
  });

  it('rejects an unreachable remote instead of half-binding', async () => {
    const store = await freshStore('bad');
    const result = await bindKnowledgeRemote(store, join(root, 'does-not-exist.git'));
    expect(isGitError(result)).toBe(true);
  });

  it('unbinds without losing local content', async () => {
    const store = await freshStore('laptop');
    await store.addMemory({ kind: 'profile' }, '保留我');
    await bindKnowledgeRemote(store, remote);

    expect(isGitError(await unbindKnowledgeRemote(store))).toBe(false);
    expect(await knowledgeRemoteUrl(store)).toBeUndefined();
    expect(await store.listMemories({ kind: 'profile' })).toMatchObject([{ text: '保留我' }]);
    // Still a repository, so history is intact.
    expect(await knowledgeRepoStatus(store)).toBeDefined();
  });

  it('unions concurrent memory appends from two bots instead of conflicting', async () => {
    const cc = await freshStore('cc');
    await cc.addMemory({ kind: 'profile' }, '共同的起点');
    await cc.addMemory({ kind: 'chat', scopeId: 'oc_shared' }, '群里的起点');
    expect(isGitError(await bindKnowledgeRemote(cc, remote))).toBe(false);
    expect(isGitError(await syncKnowledge(cc))).toBe(false);
    const poki = await freshStore('poki');
    expect(isGitError(await bindKnowledgeRemote(poki, remote))).toBe(false);

    // Both append to the end of the same files before either syncs: without
    // `merge=union` the second rebase stops on a conflict.
    await cc.addMemory({ kind: 'profile' }, 'CC 记下的');
    await poki.addMemory({ kind: 'profile' }, 'Poki 记下的');
    await cc.addMemory({ kind: 'chat', scopeId: 'oc_shared' }, 'CC 在群里记的');
    await poki.addMemory({ kind: 'chat', scopeId: 'oc_shared' }, 'Poki 在群里记的');

    for (const store of [cc, poki, cc]) {
      const result = await syncKnowledge(store);
      if (isGitError(result)) throw new Error(result.error);
      expect(result.pushed).toBe(true);
    }

    for (const store of [cc, poki]) {
      expect((await store.listMemories({ kind: 'profile' })).map((entry) => entry.text).sort()).toEqual(
        ['CC 记下的', 'Poki 记下的', '共同的起点'].sort(),
      );
      expect((await store.listMemories({ kind: 'chat', scopeId: 'oc_shared' })).map((entry) => entry.text).sort()).toEqual(
        ['CC 在群里记的', 'Poki 在群里记的', '群里的起点'].sort(),
      );
      const status = await knowledgeRepoStatus(store);
      expect(status?.dirty).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
    }
  });

  it('unions memory files when a bot that has no .gitattributes yet pushed first', async () => {
    // The other bot still runs a version without union merges: its commits
    // carry no .gitattributes, so only ours does. A rebase reads attributes
    // from the working tree, which is why they get a commit of their own.
    const old = join(root, 'old-bot');
    const clone = await git(root, ['clone', '-q', remote, old]);
    if (!clone.ok) throw new Error(clone.stderr);
    const ours = await freshStore('ours');
    await ours.addMemory({ kind: 'profile' }, '起点');
    expect(isGitError(await bindKnowledgeRemote(ours, remote))).toBe(false);
    expect(isGitError(await syncKnowledge(ours))).toBe(false);
    // Simulate the pre-upgrade history: drop the attributes from the remote.
    const pulled = await git(old, ['pull', '-q', 'origin', 'main']);
    if (!pulled.ok) throw new Error(pulled.stderr);
    await rm(join(old, '.gitattributes'));
    await commitIn(old, 'old bot: no attributes');
    const seeded = await git(old, ['push', '-q', 'origin', 'main']);
    if (!seeded.ok) throw new Error(seeded.stderr);
    expect(isGitError(await syncKnowledge(ours))).toBe(false);

    await writeFile(join(old, 'MEMORY.md'), `${await readFile(join(old, 'MEMORY.md'), 'utf8')}- [0a0a0a] 旧版本记的\n`);
    await commitIn(old, 'old bot memory');
    expect((await git(old, ['push', '-q', 'origin', 'main'])).ok).toBe(true);
    await ours.addMemory({ kind: 'profile' }, '新版本记的');

    const result = await syncKnowledge(ours);
    if (isGitError(result)) throw new Error(result.error);
    expect((await ours.listMemories({ kind: 'profile' })).map((entry) => entry.text).sort()).toEqual(
      ['新版本记的', '旧版本记的', '起点'].sort(),
    );
  });

  it('writes .gitattributes on bind and keeps lines that were already there', async () => {
    const store = await freshStore('attrs');
    await writeFile(join(store.dir, '.gitattributes'), '*.png binary');
    expect(isGitError(await bindKnowledgeRemote(store, remote))).toBe(false);
    expect(await readFile(join(store.dir, '.gitattributes'), 'utf8')).toBe(
      '*.png binary\nMEMORY.md merge=union\nchats/*.md merge=union\n',
    );
    // Already complete: left alone.
    expect(await ensureMemoryMergeAttributes(store)).toBe(false);
    expect(isGitError(await syncKnowledge(store))).toBe(false);
    const tracked = await git(store.dir, ['ls-files', '.gitattributes']);
    expect(tracked.stdout.trim()).toBe('.gitattributes');
  });

  it('serializes overlapping syncs of one directory', async () => {
    const store = await freshStore('busy');
    await store.addMemory({ kind: 'profile' }, '第一条');
    expect(isGitError(await bindKnowledgeRemote(store, remote))).toBe(false);

    const runs = [syncKnowledge(store), syncKnowledge(store)];
    await store.addMemory({ kind: 'profile' }, '同步途中写的');
    runs.push(syncKnowledge(store));
    for (const result of await Promise.all(runs)) {
      if (isGitError(result)) throw new Error(result.error);
    }
    // The last one ran after the write, so it pushed it.
    const remoteMemory = await git(remote, ['show', 'main:MEMORY.md']);
    expect(remoteMemory.stdout).toContain('同步途中写的');
  });

  it.skipIf(process.platform === 'win32')('retries once when another bot pushed in the middle of ours', async () => {
    const store = await freshStore('racer');
    expect(isGitError(await bindKnowledgeRemote(store, remote))).toBe(false);
    expect(isGitError(await syncKnowledge(store))).toBe(false);
    const other = join(root, 'other');
    expect((await git(root, ['clone', '-q', remote, other])).ok).toBe(true);
    await writeFile(join(other, 'notes.md'), '另一个 bot 的笔记\n');
    await commitIn(other, 'other bot');

    // The hook lands the other bot's commit while our push is under way, once.
    const hook = join(store.dir, '.git', 'hooks', 'pre-push');
    await writeFile(
      hook,
      `#!/bin/sh\nrm -f "$0"\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\ngit -C '${other}' push -q origin main\n`,
    );
    await chmod(hook, 0o755);
    await store.addMemory({ kind: 'profile' }, '我们的');

    const result = await syncKnowledge(store);
    if (isGitError(result)) throw new Error(result.error);
    expect(result).toMatchObject({ pulled: true, pushed: true });
    const log = await git(remote, ['log', '--format=%s', 'main']);
    expect(log.stdout).toContain('other bot');
    expect((await git(remote, ['show', 'main:MEMORY.md'])).stdout).toContain('我们的');
  });

  it('recognises a push that lost a race', () => {
    expect(isRejectedPush(' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs')).toBe(true);
    expect(isRejectedPush(" ! [remote rejected] main -> main (failed to update ref)")).toBe(true);
    expect(isRejectedPush("fatal: '/srv/x.git' does not appear to be a git repository")).toBe(false);
    expect(isRejectedPush('remote: Permission to a/b.git denied to someone.')).toBe(false);
  });

  it('will not commit on top of an unfinished merge', async () => {
    const store = await freshStore('stuck');
    expect(isGitError(await bindKnowledgeRemote(store, remote))).toBe(false);
    expect(isGitError(await syncKnowledge(store))).toBe(false);
    const head = await git(store.dir, ['rev-parse', 'HEAD']);
    await writeFile(join(store.dir, '.git', 'MERGE_HEAD'), `${head.stdout.trim()}\n`);
    await store.addMemory({ kind: 'profile' }, '不该被提交');

    expect(await syncKnowledge(store)).toMatchObject({ error: expect.stringContaining('merge') });
    expect((await git(store.dir, ['rev-parse', 'HEAD'])).stdout).toBe(head.stdout);
  });

  it('does not mistake a directory inside another repository for its own', async () => {
    const outer = join(root, 'outer');
    await mkdir(outer, { recursive: true });
    expect((await git(outer, ['init', '-q', '--initial-branch=main'])).ok).toBe(true);
    await writeFile(join(outer, 'unrelated.txt'), '别动我\n');
    const store = new KnowledgeStore(join(outer, 'knowledge'));
    await store.ensure();

    expect(await syncKnowledge(store)).toMatchObject({ error: expect.stringContaining('bind') });
    expect(isGitError(await bindKnowledgeRemote(store, remote))).toBe(false);
    // The bind created a repository of its own instead of rewiring the outer one.
    expect((await git(outer, ['remote'])).stdout.trim()).toBe('');
    expect((await git(outer, ['status', '--porcelain'])).stdout).toContain('unrelated.txt');
    expect(await knowledgeRemoteUrl(store)).toBe(remote);
  });
});

async function commitIn(repo: string, message: string): Promise<void> {
  for (const args of [
    ['add', '-A'],
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message],
  ]) {
    const result = await git(repo, args);
    if (!result.ok) throw new Error(result.stderr);
  }
}
