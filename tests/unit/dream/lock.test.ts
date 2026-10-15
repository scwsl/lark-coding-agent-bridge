import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDreamLocks, canonicalRepoId } from '../../../src/dream/lock.js';
import { ghRepoSlug } from '../../../src/dream/publish.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('canonicalRepoId', () => {
  it('names one repository the same however its remote is written', () => {
    const forms = [
      'git@github.com:Mirsery/Lark-Bot-Knowledge.git',
      'ssh://git@github.com/mirsery/lark-bot-knowledge',
      'https://x-access-token:secret@github.com/mirsery/lark-bot-knowledge.git/',
      'https://github.com/mirsery/lark-bot-knowledge',
    ];
    expect(new Set(forms.map(canonicalRepoId))).toEqual(new Set(['github.com/mirsery/lark-bot-knowledge']));
    expect(canonicalRepoId('/srv/Repos/knowledge.git/')).toBe('/srv/Repos/knowledge');
    expect(canonicalRepoId('file:///srv/Repos/knowledge.git')).toBe('/srv/Repos/knowledge');
  });
});

describe('ghRepoSlug', () => {
  it('gives gh -R the repository, or nothing for a local path', () => {
    expect(ghRepoSlug('git@github.com:mirsery/lark-bot-skills.git')).toBe('mirsery/lark-bot-skills');
    expect(ghRepoSlug('https://github.com/mirsery/lark-bot-skills')).toBe('mirsery/lark-bot-skills');
    expect(ghRepoSlug('https://git.example.com/team/skills.git')).toBe('git.example.com/team/skills');
    expect(ghRepoSlug('/srv/knowledge.git')).toBeUndefined();
    expect(ghRepoSlug('https://github.com/a/b/c')).toBeUndefined();
  });
});

describe('acquireDreamLocks', () => {
  it('lets one profile at a time hold a repository, all of a run’s repositories or none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcb-dream-lock-'));
    dirs.push(dir);
    const knowledge = 'git@github.com:acme/knowledge.git';
    const skills = 'https://github.com/acme/skills';

    const first = await acquireDreamLocks(dir, [knowledge], { profile: 'claude', batch: 'b1' });
    if ('error' in first) throw new Error(first.error);
    // same repository, other spelling: refused, and the free one is not kept
    const second = await acquireDreamLocks(dir, [skills, 'https://github.com/ACME/knowledge'], { profile: 'codex', batch: 'b2' });
    expect(second).toEqual({ error: expect.stringContaining('profile claude 正在整理同一个仓库（批次 b1）') });
    const skillsOnly = await acquireDreamLocks(dir, [skills], { profile: 'codex', batch: 'b3' });
    if ('error' in skillsOnly) throw new Error(skillsOnly.error);
    await skillsOnly.release();

    await first.release();
    const third = await acquireDreamLocks(dir, [knowledge, skills], { profile: 'codex', batch: 'b4' });
    expect(third).toHaveProperty('release');
    if ('release' in third) await third.release();
  });
});
