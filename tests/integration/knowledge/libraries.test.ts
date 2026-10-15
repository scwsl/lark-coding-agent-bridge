import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillLibraryConfig } from '../../../src/config/profile-schema';
import { git } from '../../../src/git/exec';
import { buildKnowledgeContext } from '../../../src/knowledge/inject';
import {
  buildLibraryConfig,
  libraryNameFromUrl,
  maskUrlCredentials,
  SkillLibraries,
} from '../../../src/knowledge/libraries';
import { KnowledgeStore } from '../../../src/knowledge/store';

/** Real git against local repositories — a library sync is all git plumbing. */

let root: string;
let config: SkillLibraryConfig[];
let libraries: SkillLibraries;

async function commitAll(repo: string, message: string): Promise<void> {
  for (const args of [
    ['add', '-A'],
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message],
  ]) {
    const result = await git(repo, args);
    if (!result.ok) throw new Error(result.stderr);
  }
}

async function writeSkill(dir: string, name: string, description: string, body = '正文'): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

/** A source repository with `skills/<name>/SKILL.md` for each entry. */
async function sourceRepo(name: string, skills: Record<string, string>, layout = 'skills'): Promise<string> {
  const repo = join(root, 'remotes', name);
  await mkdir(repo, { recursive: true });
  const init = await git(repo, ['init', '-q', '--initial-branch=main']);
  if (!init.ok) throw new Error(init.stderr);
  for (const [skill, description] of Object.entries(skills)) {
    await writeSkill(layout ? join(repo, layout) : repo, skill, description);
  }
  await writeFile(join(repo, 'README.md'), '# library\n');
  await commitAll(repo, 'init');
  return repo;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lcb-skill-libraries-'));
  config = [];
  libraries = new SkillLibraries({ dir: join(root, 'skill-libraries'), libraries: () => config });
});

afterEach(async () => {
  await libraries.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe('skill libraries', () => {
  it('mirrors a repository and indexes its skills with their source', async () => {
    const url = await sourceRepo('team', { deploy: '发布步骤', triage: '排查流程' });
    const library = { name: 'team', url };

    const result = await libraries.syncLibrary(library);
    expect(result).toMatchObject({ name: 'team', ok: true, changed: true });
    expect(result.commit).toMatch(/^[0-9a-f]{7,}$/);

    config = [library];
    const skills = await libraries.listSkills();
    expect(skills.map((skill) => [skill.name, skill.description, skill.source])).toEqual([
      ['deploy', '发布步骤', 'team'],
      ['triage', '排查流程', 'team'],
    ]);
    expect(await readFile(skills[0]!.path, 'utf8')).toContain('发布步骤');
    // No scratch directory is left next to the mirror.
    expect(await readdir(join(root, 'skill-libraries'))).toEqual(['team']);
  });

  it('follows the remote and throws away local edits on the next sync', async () => {
    const url = await sourceRepo('team', { deploy: '发布步骤' });
    config = [{ name: 'team', url }];
    await libraries.sync();

    const [skill] = await libraries.listSkills();
    await writeFile(skill!.path, '---\nname: deploy\ndescription: 本地乱改\n---\n');
    await writeFile(join(libraries.mirrorDir('team'), 'stray.txt'), 'x');

    const unchanged = await libraries.sync('team');
    expect(unchanged[0]).toMatchObject({ ok: true, changed: false });
    expect((await libraries.listSkills())[0]!.description).toBe('发布步骤');
    await expect(stat(join(libraries.mirrorDir('team'), 'stray.txt'))).rejects.toThrow();

    await writeSkill(join(url, 'skills'), 'rollback', '回滚步骤');
    await commitAll(url, 'add rollback');
    const moved = await libraries.sync('team');
    expect(moved[0]).toMatchObject({ ok: true, changed: true });
    expect((await libraries.listSkills()).map((item) => item.name)).toEqual(['deploy', 'rollback']);
  });

  it('pins a ref, and honours path / include / exclude', async () => {
    const url = await sourceRepo('pinned', { a: 'A', b: 'B', c: 'C' }, 'pack');
    const first = await git(url, ['rev-parse', 'HEAD']);
    await writeSkill(join(url, 'pack'), 'd', 'D');
    await commitAll(url, 'add d');

    config = [{ name: 'pinned', url, ref: first.stdout.trim(), path: 'pack', exclude: ['b'] }];
    await libraries.sync();
    expect((await libraries.listSkills()).map((skill) => skill.name)).toEqual(['a', 'c']);

    config = [{ name: 'pinned', url, ref: 'main', path: 'pack', include: ['d', 'a'] }];
    await libraries.sync();
    expect((await libraries.listSkills()).map((skill) => skill.name)).toEqual(['a', 'd']);
  });

  it('treats a repository with SKILL.md at its root as one skill', async () => {
    const url = join(root, 'remotes', 'solo');
    await mkdir(url, { recursive: true });
    await git(url, ['init', '-q', '--initial-branch=main']);
    await writeFile(join(url, 'SKILL.md'), '---\ndescription: 单个 skill\n---\n');
    await commitAll(url, 'init');

    config = [{ name: 'solo', url }];
    await libraries.sync();
    expect(await libraries.listSkills()).toMatchObject([{ name: 'solo', description: '单个 skill', source: 'solo' }]);
  });

  it('reports a failed first fetch without leaving anything behind', async () => {
    const result = await libraries.syncLibrary({ name: 'ghost', url: join(root, 'does-not-exist') });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(await readdir(join(root, 'skill-libraries')).catch(() => [])).toEqual([]);

    config = [{ name: 'ghost', url: join(root, 'does-not-exist') }];
    const [status] = await libraries.status();
    expect(status).toMatchObject({ present: false, skills: [] });
    expect(status!.lastError).toBeTruthy();
  });

  it('skips skills that lead outside the mirror', async () => {
    const outside = join(root, 'secret.md');
    await writeFile(outside, '---\nname: leak\ndescription: 不该出现\n---\n');
    const url = await sourceRepo('sneaky', { fine: '正常' });
    await mkdir(join(url, 'skills', 'leak'), { recursive: true });
    await symlink(outside, join(url, 'skills', 'leak', 'SKILL.md'));
    await symlink(join(root, 'remotes'), join(url, 'skills', 'linked-dir'));
    await commitAll(url, 'add links');

    config = [{ name: 'sneaky', url }];
    await libraries.sync();
    expect((await libraries.listSkills()).map((skill) => skill.name)).toEqual(['fine']);
  });

  it('removes a mirror', async () => {
    const url = await sourceRepo('team', { deploy: '发布步骤' });
    config = [{ name: 'team', url }];
    await libraries.sync();
    await libraries.remove('team');
    config = [];
    await expect(stat(libraries.mirrorDir('team'))).rejects.toThrow();
  });

  it('sweeps scratch directories a crashed first fetch left behind', async () => {
    const scratch = join(root, 'skill-libraries', 'team.tmp-0123abcd');
    await mkdir(scratch, { recursive: true });
    libraries.startAutoSync(() => 0);
    await libraries.stop();
    await expect(stat(scratch)).rejects.toThrow();
  });

  it('sweeps mirrors of libraries that are no longer configured on start-up', async () => {
    const url = await sourceRepo('team', { deploy: '发布步骤' });
    const other = await sourceRepo('other', { triage: '排查流程' });
    config = [
      { name: 'team', url },
      { name: 'other', url: other },
    ];
    await libraries.sync();
    // Removed from the configuration by another process (the web console)
    // while this one kept the mirror around.
    config = [{ name: 'team', url }];
    await writeFile(join(root, 'skill-libraries', 'notes.txt'), 'not a mirror');

    libraries.startAutoSync(() => 0);
    await libraries.stop();

    expect((await readdir(join(root, 'skill-libraries'))).sort()).toEqual(['notes.txt', 'team']);
  });

  it('applies a changed interval to the wait already running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let minutes = 60;
      const sync = vi.spyOn(libraries, 'sync');
      libraries.startAutoSync(() => minutes);
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      expect(sync).toHaveBeenCalledTimes(1);

      minutes = 1;
      libraries.reschedule();
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    } finally {
      await libraries.stop();
      vi.useRealTimers();
    }
  });
});

describe('knowledge store with libraries', () => {
  it('puts the profile’s own skills first and lets them override a library skill', async () => {
    const url = await sourceRepo('team', { deploy: '库里的发布步骤', triage: '排查流程' });
    config = [{ name: 'team', url }];
    await libraries.sync();

    const store = new KnowledgeStore(join(root, 'knowledge'));
    await store.ensure();
    await writeSkill(store.skillsDir, 'deploy', '自己的发布步骤');
    store.addSkillSource(libraries);

    const skills = await store.listSkills();
    expect(skills.map((skill) => [skill.name, skill.description, skill.source])).toEqual([
      ['deploy', '自己的发布步骤', undefined],
      ['triage', '排查流程', 'team'],
    ]);
    expect((await store.listOwnSkills()).map((skill) => skill.name)).toEqual(['deploy']);

    const triage = await store.readSkill('triage');
    expect(triage?.summary.source).toBe('team');
    expect(triage?.body).toContain('排查流程');
    await expect(store.readSkill('../../etc/passwd')).resolves.toBeUndefined();

    const context = await buildKnowledgeContext({ store, scopeId: 'oc_1' });
    expect(context?.skills).toEqual([
      { name: 'deploy', description: '自己的发布步骤', path: join(store.skillsDir, 'deploy', 'SKILL.md') },
      expect.objectContaining({ name: 'triage', source: 'team' }),
    ]);
  });

  it('shortens long descriptions in the injected index', async () => {
    const url = await sourceRepo('wordy', { essay: '很长'.repeat(400) });
    config = [{ name: 'wordy', url }];
    await libraries.sync();
    const store = new KnowledgeStore(join(root, 'knowledge'));
    await store.ensure();
    store.addSkillSource(libraries);

    const context = await buildKnowledgeContext({ store, scopeId: 'oc_1' });
    const description = context?.skills?.[0]?.description ?? '';
    expect(description.length).toBeLessThanOrEqual(240);
    expect(description.endsWith('…')).toBe(true);
  });
});

describe('helpers', () => {
  it('masks credentials in URLs and git messages', () => {
    expect(maskUrlCredentials('https://user:tok3n@github.com/a/b.git')).toBe('https://***@github.com/a/b.git');
    expect(maskUrlCredentials("fatal: unable to access 'https://x-token@host/r.git/'")).toBe(
      "fatal: unable to access 'https://***@host/r.git/'",
    );
    expect(maskUrlCredentials('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
  });

  it('checks a library before it is added', () => {
    const taken = new Set(['team']);
    expect(buildLibraryConfig({ url: 'git@github.com:acme/team-skills.git' }, taken)).toEqual({
      library: { name: 'team-skills', url: 'git@github.com:acme/team-skills.git' },
    });
    expect(
      buildLibraryConfig(
        {
          url: ' https://github.com/acme/x.git ',
          name: 'x',
          ref: ' main ',
          path: './skills/',
          include: [' a ', '', 'b'],
          exclude: [],
        },
        taken,
      ),
    ).toEqual({ library: { name: 'x', url: 'https://github.com/acme/x.git', ref: 'main', path: 'skills', include: ['a', 'b'] } });
    expect(buildLibraryConfig({ url: 'not a url' }, taken)).toMatchObject({ error: expect.stringContaining('不像 git') });
    expect(buildLibraryConfig({ url: 'git@github.com:acme/team.git' }, taken)).toMatchObject({
      error: expect.stringContaining('已经有叫'),
    });
    expect(buildLibraryConfig({ url: 'git@github.com:a/b.git', ref: '--upload-pack=x' }, taken)).toMatchObject({
      error: expect.stringContaining('不合法'),
    });
    expect(buildLibraryConfig({ url: 'git@github.com:a/b.git', path: '../outside' }, taken)).toMatchObject({
      error: expect.stringContaining('不合法'),
    });
    expect(buildLibraryConfig({ url: 'git@github.com:a/b.git', name: '-bad' }, taken)).toMatchObject({
      error: expect.stringContaining('不可用'),
    });
  });

  it('suggests a library name from the URL', () => {
    expect(libraryNameFromUrl('git@github.com:mirsery/lysander-skills.git')).toBe('lysander-skills');
    expect(libraryNameFromUrl('https://github.com/a/team-skills/')).toBe('team-skills');
    expect(libraryNameFromUrl('/Users/me/repos/my skills')).toBe('my-skills');
  });
});
