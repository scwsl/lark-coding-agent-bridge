import { mkdtemp, mkdir, realpath, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { git } from '../../../src/git/exec';
import * as worktreeModule from '../../../src/git/worktree';
import { addWorktree } from '../../../src/git/worktree';
import { cleanupWorktrees, protectedWorkspacePaths } from '../../../src/git/worktree-cleanup';
import { WorkspaceStore } from '../../../src/workspace/store';
let root: string, repo: string, tree: string, store: WorkspaceStore;
const DAY = 86400000;
async function run(cwd: string, args: string[]) { const r = await git(cwd, args); if (!r.ok) throw new Error(r.stderr); return r.stdout.trim(); }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'cleanup-worktree-')));
  repo = join(root, 'repo'); tree = join(root, 'tree');
  await mkdir(repo);
  await run(repo, ['init', '--initial-branch=main']);
  await run(repo, ['config', 'user.email', 'test@example.com']);
  await run(repo, ['config', 'user.name', 'Test']);
  await writeFile(join(repo, 'a'), 'one'); await run(repo, ['add', '.']); await run(repo, ['commit', '-m', 'initial']);
  const result = await addWorktree({ cwd: repo, repoRoot: repo, branch: 'task', path: tree });
  if ('error' in result) throw new Error(result.error);
  store = new WorkspaceStore(join(root, 'workspaces.json'));
  store.trackWorktree({ repoRoot: repo, path: tree, branch: 'task', ownedBranch: true }, 0);
});
afterEach(async () => { vi.restoreAllMocks(); await store.flush(); await rm(root, { recursive: true, force: true }); });
const clean = (protectedPaths: string[] = [], enabled = true) => cleanupWorktrees({ store, idleDays: enabled ? 7 : undefined, now: 8 * DAY, protectedPaths: async () => protectedPaths });
describe('managed worktree cleanup', () => {
  it('removes only an old merged managed worktree and its newly created branch', async () => {
    expect((await clean()).removed).toEqual([tree]);
    await expect(access(tree)).rejects.toThrow();
    expect((await git(repo, ['show-ref', '--verify', 'refs/heads/task'])).ok).toBe(false);
    const loaded = new WorkspaceStore(join(root, 'workspaces.json')); await store.flush(); await loaded.load();
    expect(loaded.listManagedWorktrees()).toEqual([]);
  });
  it.each(['disabled', 'recent', 'dirty', 'untracked', 'ignored', 'unmerged', 'locked', 'named', 'referenced', 'external-reference', 'branch-changed', 'main'])('protects %s worktrees', async (reason) => {
    if (reason === 'recent') store.touchWorktree(tree, 7 * DAY);
    if (reason === 'dirty') await writeFile(join(tree, 'a'), 'changed');
    if (reason === 'untracked') await writeFile(join(tree, 'untracked'), 'data');
    if (reason === 'ignored') { await writeFile(join(tree, '.gitignore'), 'secret\n'); await run(tree, ['add', '.']); await run(tree, ['commit', '-m', 'ignore']); await run(repo, ['merge', 'task']); await writeFile(join(tree, 'secret'), 'keep'); }
    if (reason === 'unmerged') { await writeFile(join(tree, 'a'), 'new'); await run(tree, ['commit', '-am', 'unmerged']); }
    if (reason === 'locked') await run(repo, ['worktree', 'lock', tree]);
    if (reason === 'named') store.saveNamed('tree', tree);
    if (reason === 'referenced') store.setCwd('chat', tree);
    if (reason === 'branch-changed') await run(tree, ['switch', '-c', 'other']);
    if (reason === 'main') store.trackWorktree({ repoRoot: repo, path: repo, branch: 'main', ownedBranch: true }, 0);
    expect((await clean(reason === 'external-reference' ? [join(tree, 'subdir')] : [], reason !== 'disabled')).removed).toEqual(reason === 'main' ? [tree] : []);
    await access(reason === 'main' ? repo : tree);
  });
  it('does not let recent entries starve older worktrees beyond the first fifty', async () => {
    for (let i = 0; i < 50; i++) store.trackWorktree({ repoRoot: repo, path: join(root, `recent-${i}`), branch: `recent-${i}`, ownedBranch: true }, 7 * DAY);
    store.trackWorktree({ repoRoot: repo, path: tree, branch: 'task', ownedBranch: true }, 0);
    expect((await clean()).removed).toEqual([tree]);
  });
  it('uses the default branch even if the primary checkout switches to another branch', async () => {
    await writeFile(join(tree, 'a'), 'unmerged'); await run(tree, ['commit', '-am', 'unmerged']);
    await run(repo, ['switch', '-c', 'temporary', 'task']);
    expect((await clean()).removed).toEqual([]); await access(tree);
  });
  it('keeps a branch moved concurrently after worktree removal', async () => {
    await run(repo, ['switch', '-c', 'concurrent']);
    await run(repo, ['commit', '--allow-empty', '-m', 'new commit']);
    const changed = await run(repo, ['rev-parse', 'HEAD']); await run(repo, ['switch', 'main']);
    const remove = worktreeModule.removeWorktree;
    vi.spyOn(worktreeModule, 'removeWorktree').mockImplementationOnce(async (...args) => {
      const result = await remove(...args);
      await run(repo, ['update-ref', 'refs/heads/task', changed]);
      return result;
    });
    expect((await clean()).removed).toEqual([tree]);
    expect(await run(repo, ['rev-parse', 'refs/heads/task'])).toBe(changed);
  });
  it('keeps pre-existing branches after removing their worktree', async () => {
    store.trackWorktree({ repoRoot: repo, path: tree, branch: 'task', ownedBranch: false }, 0);
    expect((await clean()).removed).toEqual([tree]);
    expect((await git(repo, ['show-ref', '--verify', 'refs/heads/task'])).ok).toBe(true);
  });
  it('fails closed if protected paths cannot be read', async () => {
    await expect(cleanupWorktrees({ store, idleDays: 7, now: 8 * DAY, protectedPaths: async () => { throw new Error('unavailable'); } })).rejects.toThrow('unavailable');
    await access(tree);
  });
  it('retains unknown worktrees and remembers usage across restart', async () => {
    store.setCwd('chat', tree); store.setCwd('chat', repo); await store.flush();
    const loaded = new WorkspaceStore(join(root, 'workspaces.json')); await loaded.load();
    expect(loaded.listManagedWorktrees()[0]!.lastUsedAt).toBeGreaterThan(0);
    store.forgetWorktree(tree); expect((await clean()).removed).toEqual([]); await access(tree);
  });
});

describe('cross-profile protection', () => {
  async function seed() {
    const profile = join(root, 'profiles', 'other'); await mkdir(profile, { recursive: true });
    await writeFile(join(root, 'config.json'), JSON.stringify({ profiles: { other: { workspaces: { default: repo } } } }));
    return profile;
  }
  it('includes other profiles, named workspaces and scheduled job directories', async () => {
    const profile = await seed();
    await writeFile(join(profile, 'workspaces.json'), JSON.stringify({ chats: { chat: { cwd: tree } }, named: { saved: tree } }));
    await writeFile(join(profile, 'jobs.json'), JSON.stringify({ jobs: { job: { cwd: tree } } }));
    expect(await protectedWorkspacePaths(root)).toEqual([repo, tree, tree, tree]);
    expect((await cleanupWorktrees({ store, idleDays: 7, now: 8 * DAY, protectedPaths: () => protectedWorkspacePaths(root) })).removed).toEqual([]);
  });
  it('defers when any other profile has a run or a malformed file', async () => {
    const profile = await seed();
    await writeFile(join(profile, 'runs.json'), '{"run":{}}');
    await expect(protectedWorkspacePaths(root)).rejects.toThrow('pending run');
    await rm(join(profile, 'runs.json'));
    await writeFile(join(profile, 'workspaces.json'), 'broken');
    await expect(protectedWorkspacePaths(root)).rejects.toThrow();
    await access(tree);
  });
  it('cancels removal when the switch changes during the pass', async () => {
    let enabled = true;
    const result = await cleanupWorktrees({ store, idleDays: 7, now: 8 * DAY, isEnabled: () => enabled, protectedPaths: async () => { enabled = false; return []; } });
    expect(result.removed).toEqual([]); await access(tree);
  });
});
