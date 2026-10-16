import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SkillProposal, MemoryAddition } from '../../../src/dream/proposal.js';
import {
  checkPullRequestAccess,
  commitDraft,
  openDraftPullRequest,
  prepareCheckout,
  pushDraft,
  writeKnowledgeDraft,
  writeSkillDraft,
} from '../../../src/dream/publish.js';
import { git } from '../../../src/git/exec.js';
import { installFakeGh } from './fake-gh.js';

const TIMEOUT = 30_000;
let root: string;
let gh: Awaited<ReturnType<typeof installFakeGh>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lcb-dream-publish-'));
  gh = await installFakeGh(root);
});

afterEach(async () => {
  gh.restore();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

/** A bare remote whose `main` holds `files`. */
async function remoteWith(name: string, files: Record<string, string>): Promise<string> {
  const remote = join(root, `${name}.git`);
  const seed = join(root, `${name}-seed`);
  await mkdir(remote, { recursive: true });
  await git(remote, ['init', '-q', '--bare', '--initial-branch=main']);
  await mkdir(seed, { recursive: true });
  await git(seed, ['init', '-q', '--initial-branch=main']);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(seed, path, '..'), { recursive: true });
    await writeFile(join(seed, path), content);
  }
  await git(seed, ['add', '-A']);
  await git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'seed']);
  await git(seed, ['tag', 'v1']);
  await git(seed, ['push', '-q', '--tags', remote, 'main']);
  return remote;
}

const add = (patch: Partial<MemoryAddition>): MemoryAddition => ({
  kind: 'add',
  scopeId: 'oc_team',
  target: 'chat',
  text: 't',
  reason: 'r',
  sources: [],
  hash: Math.random().toString(16),
  ...patch,
});

const skill = (patch: Partial<SkillProposal>): SkillProposal => ({
  scopeId: 'oc_team',
  action: 'create',
  name: 'release-check',
  description: 'd',
  body: '---\nname: release-check\ndescription: d\n---\nsteps\n',
  reason: 'r',
  sources: [],
  hash: Math.random().toString(16),
  ...patch,
});

describe('dream publishing', { timeout: TIMEOUT }, () => {
  it('drafts knowledge on a new branch, pushes it and opens a Draft PR without touching main', async () => {
    const remote = await remoteWith('knowledge', { 'MEMORY.md': '# Memory\n\n- [abc123] 回复用中文\n' });
    const dir = join(root, 'batches', 'b1', 'knowledge');
    const prepared = await prepareCheckout({ repo: 'knowledge', label: '知识库', url: remote }, dir, 'dream/b1');
    expect(prepared).toEqual({ base: 'main' });

    const draft = await writeKnowledgeDraft(dir, [
      add({ target: 'profile', text: '部署前先跑 ci' }),
      add({ target: 'profile', text: '回复用中文' }),
      add({ target: 'chat', text: '本群周五发周报' }),
      add({ target: 'note', note: 'deploy', text: '发布走 ship.md' }),
    ]);
    expect(draft.files.sort()).toEqual(['MEMORY.md', 'chats/oc_team.md', 'notes/oc_team/deploy.md']);
    expect(draft.duplicates.map((d) => d.text)).toEqual(['回复用中文']);
    expect(await readFile(join(dir, 'MEMORY.md'), 'utf8')).toMatch(/- \[abc123\] 回复用中文\n- \[[0-9a-f]{6}\] 部署前先跑 ci\n$/);

    const committed = await commitDraft(dir, draft.files, 'dream: 课堂精练 b1\n', join(root, 'hooks'));
    expect(committed).toHaveProperty('commit');
    expect(await checkPullRequestAccess(dir)).toEqual({ ok: true });
    expect(await pushDraft(dir, 'dream/b1', join(root, 'hooks'))).toEqual({ ok: true });
    // pushing again (a retry) is not an error
    expect(await pushDraft(dir, 'dream/b1', join(root, 'hooks'))).toEqual({ ok: true });
    const pr = await openDraftPullRequest(dir, { branch: 'dream/b1', base: 'main', title: 'T', body: '正文' });
    expect(pr).toEqual({ url: 'https://github.com/acme/repo/pull/7', number: 7 });

    const heads = await git(remote, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    expect(heads.stdout.trim().split('\n').sort()).toEqual(['dream/b1', 'main']);
    const mainLog = await git(remote, ['log', '--format=%s', 'main']);
    expect(mainLog.stdout.trim()).toBe('seed');
    const calls = await gh.calls();
    expect(calls.find((c) => c.args?.[1] === 'create')?.args).toEqual(
      expect.arrayContaining(['--draft', '--base', 'main', '--head', 'dream/b1']),
    );
    expect(calls.some((c) => c.body === '正文')).toBe(true);
  });

  it('refuses read-only access before pushing anything', async () => {
    const remote = await remoteWith('lib', { 'README.md': 'x' });
    const dir = join(root, 'ro');
    await prepareCheckout({ repo: 'skills:lib', label: 'lib', url: remote }, dir, 'dream/b2');
    process.env.FAKE_GH_PERMISSION = 'READ';
    const access = await checkPullRequestAccess(dir);
    expect(access).toEqual({ error: expect.stringContaining('权限是 READ') });
  });

  it('refuses tags and pinned commits as write targets', async () => {
    const remote = await remoteWith('pinned', { 'README.md': 'x' });
    expect(await prepareCheckout({ repo: 'skills:p', label: 'p', url: remote, ref: 'a'.repeat(40) }, join(root, 'p1'), 'dream/b'))
      .toEqual({ error: expect.stringContaining('不能作为写入目标') });
    expect(await prepareCheckout({ repo: 'skills:p', label: 'p', url: remote, ref: 'v1' }, join(root, 'p2'), 'dream/b'))
      .toEqual({ error: expect.stringContaining('不能作为写入目标') });
  });

  it('writes skills under the library path, updates by parsed name and respects filters', async () => {
    const remote = await remoteWith('skills', {
      'skills/deploy-dir/SKILL.md': '---\nname: deploy\ndescription: old\n---\nold\n',
      'skills/taken/SKILL.md': '---\nname: taken\ndescription: x\n---\n',
    });
    const dir = join(root, 'skills-co');
    await prepareCheckout({ repo: 'skills:team', label: 'team', url: remote }, dir, 'dream/b3');
    const draft = await writeSkillDraft(dir, { name: 'team', url: remote, exclude: ['secret-skill'] }, [
      skill({}),
      skill({ action: 'update', name: 'deploy', body: '---\nname: deploy\ndescription: new\n---\nnew\n' }),
      skill({ name: 'taken' }),
      skill({ name: 'secret-skill' }),
      skill({ action: 'update', name: 'ghost' }),
    ]);
    expect(draft.files.sort()).toEqual(['skills/deploy-dir/SKILL.md', 'skills/release-check/SKILL.md']);
    expect(await readFile(join(dir, 'skills', 'deploy-dir', 'SKILL.md'), 'utf8')).toContain('new');
    expect(draft.rejected.map((r) => r.reason)).toEqual([
      '最新基线里已有同名目录',
      expect.stringContaining('include / exclude'),
      '最新基线里找不到这个 skill',
    ]);
  });

  it('refuses a single-skill repository and symlinked targets', async () => {
    const single = await remoteWith('single', { 'SKILL.md': '---\nname: one\ndescription: x\n---\n' });
    const dir = join(root, 'single-co');
    await prepareCheckout({ repo: 'skills:one', label: 'one', url: single }, dir, 'dream/b4');
    const draft = await writeSkillDraft(dir, { name: 'one', url: single }, [skill({})]);
    expect(draft.files).toEqual([]);
    expect(draft.rejected[0]?.reason).toContain('单个 skill');

    const kn = await remoteWith('kn', { 'MEMORY.md': '# Memory\n' });
    const kdir = join(root, 'kn-co');
    await prepareCheckout({ repo: 'knowledge', label: 'k', url: kn }, kdir, 'dream/b5');
    await mkdir(join(kdir, 'chats'), { recursive: true });
    await writeFile(join(root, 'outside.md'), 'x');
    await symlink(join(root, 'outside.md'), join(kdir, 'chats', 'oc_team.md'));
    const written = await writeKnowledgeDraft(kdir, [add({ target: 'chat', text: 'x' })]);
    expect(written.files).toEqual([]);
    expect(written.errors[0]).toContain('路径越界');
    expect(await readFile(join(root, 'outside.md'), 'utf8')).toBe('x');
  });
});
