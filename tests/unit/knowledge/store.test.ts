import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildKnowledgeContext } from '../../../src/knowledge/inject';
import {
  KnowledgeStore,
  isSafeSkillName,
  parseSkillHeader,
  sanitizeScopeId,
} from '../../../src/knowledge/store';
import { isPlausibleGitUrl } from '../../../src/knowledge/sync';

let dir: string;
let store: KnowledgeStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lcb-knowledge-'));
  store = new KnowledgeStore(join(dir, 'knowledge'));
  await store.ensure();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('memory', () => {
  it('adds, lists and forgets notes per scope', async () => {
    const chat = { kind: 'chat', scopeId: 'oc_1' } as const;
    const first = await store.addMemory(chat, '这个群里 deploy 指的是发到 staging');
    const second = await store.addMemory(chat, '不要 @ 其他 bot');
    await store.addMemory({ kind: 'profile' }, '提交信息不要带 AI 署名');

    const chatEntries = await store.listMemories(chat);
    expect(chatEntries.map((entry) => entry.text)).toEqual([
      '这个群里 deploy 指的是发到 staging',
      '不要 @ 其他 bot',
    ]);
    expect(await store.listMemories({ kind: 'profile' })).toHaveLength(1);
    // Scopes are independent files: a chat note is invisible elsewhere.
    expect(await store.listMemories({ kind: 'chat', scopeId: 'oc_2' })).toHaveLength(0);

    expect(await store.removeMemory(chat, first.id)).toBe(true);
    expect(await store.removeMemory(chat, first.id)).toBe(false);
    expect((await store.listMemories(chat)).map((entry) => entry.id)).toEqual([second.id]);
  });

  it('writes plain markdown a human can edit, at 0600', async () => {
    const chat = { kind: 'chat', scopeId: 'oc_1' } as const;
    await store.addMemory(chat, '记一条');
    const file = store.memoryFile(chat);
    const raw = await readFile(file, 'utf8');
    expect(raw).toContain('# 记忆');
    expect(raw).toMatch(/^- \[[0-9a-f]{6}\] 记一条$/m);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('keeps hand-written prose and only drops the bullet it was asked to', async () => {
    const chat = { kind: 'chat', scopeId: 'oc_1' } as const;
    const entry = await store.addMemory(chat, '第一条');
    const file = store.memoryFile(chat);
    await writeFile(file, `${await readFile(file, 'utf8')}\n手写的说明段落\n`);

    await store.removeMemory(chat, entry.id);
    const raw = await readFile(file, 'utf8');
    expect(raw).toContain('手写的说明段落');
    expect(raw).not.toContain('第一条');
  });

  it('collapses whitespace and refuses an empty note', async () => {
    const chat = { kind: 'chat', scopeId: 'oc_1' } as const;
    const entry = await store.addMemory(chat, '  多行\n   内容  ');
    expect(entry.text).toBe('多行 内容');
    await expect(store.addMemory(chat, '   ')).rejects.toThrow();
  });

  it('clears a scope without touching the other', async () => {
    const chat = { kind: 'chat', scopeId: 'oc_1' } as const;
    await store.addMemory(chat, 'a');
    await store.addMemory(chat, 'b');
    await store.addMemory({ kind: 'profile' }, 'global');

    expect(await store.clearMemories(chat)).toBe(2);
    expect(await store.listMemories(chat)).toHaveLength(0);
    expect(await store.listMemories({ kind: 'profile' })).toHaveLength(1);
    expect(await store.clearMemories(chat)).toBe(0);
  });

  it('turns a topic scope into one safe file name', () => {
    expect(sanitizeScopeId('oc_abc:omt_def')).toBe('oc_abc_omt_def');
    expect(sanitizeScopeId('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeScopeId('')).toBe('unknown');
  });
});

describe('skills', () => {
  async function writeSkill(name: string, body: string): Promise<void> {
    await mkdir(join(store.skillsDir, name), { recursive: true });
    await writeFile(join(store.skillsDir, name, 'SKILL.md'), body);
  }

  it('lists skills with frontmatter or markdown headers', async () => {
    await writeSkill('deploy', '---\nname: deploy\ndescription: 发布到 staging 的步骤\n---\n\n正文');
    await writeSkill('review', '# 代码评审\n\n按这个清单走\n');
    await writeSkill('bare', 'no header at all\n');

    const skills = await store.listSkills();
    expect(skills).toHaveLength(3);
    expect(skills.find((s) => s.path.includes('deploy'))).toMatchObject({
      name: 'deploy',
      description: '发布到 staging 的步骤',
    });
    expect(skills.find((s) => s.path.includes('review'))).toMatchObject({
      name: '代码评审',
      description: '按这个清单走',
    });
    expect(skills.find((s) => s.path.includes('bare'))).toMatchObject({ name: 'bare' });
  });

  it('ignores directories without a SKILL.md', async () => {
    await mkdir(join(store.skillsDir, 'empty'), { recursive: true });
    expect(await store.listSkills()).toHaveLength(0);
  });

  it('reads one skill and refuses an unsafe name', async () => {
    await writeSkill('deploy', '# deploy\n\nbody here\n');
    expect((await store.readSkill('deploy'))?.body).toContain('body here');
    expect(await store.readSkill('../../etc/passwd')).toBeUndefined();
    expect(await store.readSkill('nope')).toBeUndefined();
    expect(isSafeSkillName('ok-name_1')).toBe(true);
    expect(isSafeSkillName('../x')).toBe(false);
  });

  it('parses headers from either convention', () => {
    expect(parseSkillHeader('dir', '---\nname: a\ndescription: b\n---\n')).toEqual({
      name: 'a',
      description: 'b',
    });
    expect(parseSkillHeader('dir', '# Title\n\nFirst line\n')).toEqual({
      name: 'Title',
      description: 'First line',
    });
    expect(parseSkillHeader('dir', '')).toEqual({ name: 'dir', description: '' });
  });

  it('unquotes values and folds block descriptions into one line', () => {
    expect(
      parseSkillHeader('dir', '---\nname: "cilab-jira"\ndescription: "Create Jira. Don\'t use for \\"reads\\"."\n---\n'),
    ).toEqual({ name: 'cilab-jira', description: 'Create Jira. Don\'t use for "reads".' });
    expect(parseSkillHeader('dir', "---\nname: 'x'\ndescription: 'it''s fine'\n---\n")).toEqual({
      name: 'x',
      description: "it's fine",
    });
    expect(
      parseSkillHeader('dir', '---\nname: y\ndescription: >-\n  first line\n  second line\nlicense: MIT\n---\n'),
    ).toEqual({ name: 'y', description: 'first line second line' });
  });
});

describe('prompt injection', () => {
  it('returns nothing when there is nothing to inject', async () => {
    await expect(buildKnowledgeContext({ store, scopeId: 'oc_1' })).resolves.toBeUndefined();
  });

  it('carries both scopes and the skill index only', async () => {
    await store.addMemory({ kind: 'chat', scopeId: 'oc_1' }, 'chat note');
    await store.addMemory({ kind: 'profile' }, 'global note');
    await mkdir(join(store.skillsDir, 'deploy'), { recursive: true });
    await writeFile(
      join(store.skillsDir, 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: 发布步骤\n---\n\n很长的正文'.repeat(10),
    );

    const context = await buildKnowledgeContext({ store, scopeId: 'oc_1' });
    expect(context).toMatchObject({
      chatMemory: ['chat note'],
      profileMemory: ['global note'],
    });
    expect(context?.skills).toHaveLength(1);
    expect(context?.skills?.[0]).toMatchObject({ name: 'deploy', description: '发布步骤' });
    // Bodies stay on disk; only the path is injected.
    expect(JSON.stringify(context)).not.toContain('很长的正文');
  });

  it('gives a topic its group notes plus its own, and keeps topics apart', async () => {
    await store.addMemory({ kind: 'chat', scopeId: 'oc_g' }, 'group note');
    await store.addMemory({ kind: 'chat', scopeId: 'oc_g:omt_a' }, 'topic a note');

    const a = await buildKnowledgeContext({ store, scopeId: 'oc_g:omt_a' });
    expect(a?.chatMemory).toEqual(['group note', 'topic a note']);
    const b = await buildKnowledgeContext({ store, scopeId: 'oc_g:omt_b' });
    expect(b?.chatMemory).toEqual(['group note']);
    const group = await buildKnowledgeContext({ store, scopeId: 'oc_g' });
    expect(group?.chatMemory).toEqual(['group note']);
  });

  it('keeps the newest notes and prefers chat scope when the budget is tight', async () => {
    for (let i = 0; i < 10; i++) {
      await store.addMemory({ kind: 'profile' }, `global-${i}`.padEnd(20, 'x'));
      await store.addMemory({ kind: 'chat', scopeId: 'oc_1' }, `chat-${i}`.padEnd(20, 'x'));
    }

    const context = await buildKnowledgeContext({ store, scopeId: 'oc_1', maxChars: 100 });
    expect(context?.truncated).toBe(true);
    expect(context?.chatMemory).toHaveLength(5);
    expect(context?.chatMemory?.at(-1)).toContain('chat-9');
    expect(context?.profileMemory ?? []).toHaveLength(0);
  });
});

describe('remote url validation', () => {
  it('accepts the usual git url shapes', () => {
    for (const url of [
      'https://github.com/me/notes.git',
      'git@github.com:me/notes.git',
      'ssh://git@host/me/notes.git',
      '/srv/git/notes.git',
    ]) {
      expect(isPlausibleGitUrl(url), url).toBe(true);
    }
  });

  it('rejects flags and junk', () => {
    for (const url of ['--upload-pack=touch /tmp/x', 'not a url', '', 'ftp://host/repo']) {
      expect(isPlausibleGitUrl(url), url).toBe(false);
    }
  });
});

describe('noteTopicScopes', () => {
  it("lists only the note directories of the chat's topics", async () => {
    for (const scope of ['oc_1', 'oc_1_omt_b', 'oc_1_omt_a', 'oc_12_omt_x', 'external']) {
      await mkdir(join(dir, 'knowledge', 'notes', scope), { recursive: true });
    }
    await writeFile(join(dir, 'knowledge', 'notes', 'oc_1_omt_file.md'), 'x');
    expect(await store.noteTopicScopes('oc_1')).toEqual(['oc_1_omt_a', 'oc_1_omt_b']);
    expect(await new KnowledgeStore(join(dir, 'missing')).noteTopicScopes('oc_1')).toEqual([]);
  });
});
