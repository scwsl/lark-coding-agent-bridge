import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeSessionHasKnowledge } from '../../../src/agent/claude/session-probe.js';
import { promptSection } from '../../../src/agent/prompt.js';
import { buildKnowledgeContext, knowledgeStub } from '../../../src/knowledge/inject.js';
import type { KnowledgeStore } from '../../../src/knowledge/store.js';

const NOTES = '/kb/notes';

function fakeStore(over: { skills?: Array<{ name: string; path: string }>; profile?: string[] } = {}): KnowledgeStore {
  return {
    listMemories: async (scope: { kind: string }) =>
      scope.kind === 'profile' ? (over.profile ?? ['用中文回复']).map((text, i) => ({ id: `m${i}`, text })) : [],
    listSkills: async () =>
      (over.skills ?? [
        { name: 'occam:coffee', path: '/lib/occam-skills/skills/occam-coffee/SKILL.md' },
        { name: 'antelope:tcpdump', path: '/lib/occam-skills/skills/antelope-tcpdump/SKILL.md' },
      ]).map((s) => ({ ...s, description: `${s.name} 的说明` })),
    listNotes: async () => [
      { name: 'external/feishu-card', path: `${NOTES}/external/feishu-card.md` },
      { name: 'external/au-timezone', path: `${NOTES}/external/au-timezone.md` },
    ],
  } as unknown as KnowledgeStore;
}

describe('buildKnowledgeContext', () => {
  it('versions the block by its content, so an unchanged block keeps its version', async () => {
    const a = await buildKnowledgeContext({ store: fakeStore(), scopeId: 'oc_1' });
    const b = await buildKnowledgeContext({ store: fakeStore(), scopeId: 'oc_1' });
    const c = await buildKnowledgeContext({ store: fakeStore({ profile: ['用中文回复', '新记忆'] }), scopeId: 'oc_1' });
    expect(a?.version).toMatch(/^[0-9a-f]{16}$/);
    expect(b?.version).toBe(a?.version);
    expect(c?.version).not.toBe(a?.version);
  });

  it('lists notes by name under one directory instead of one absolute path each', async () => {
    const ctx = await buildKnowledgeContext({ store: fakeStore(), scopeId: 'oc_1' });
    expect(ctx?.notesDir).toBe(NOTES);
    expect(ctx?.notes).toEqual(['external/feishu-card', 'external/au-timezone']);
  });

  it('leaves out the skills the agent CLI already lists on its own', async () => {
    const ctx = await buildKnowledgeContext({
      store: fakeStore(),
      scopeId: 'oc_1',
      nativeSkillDirs: new Set(['occam-coffee']),
    });
    expect(ctx?.skills?.map((s) => s.name)).toEqual(['antelope:tcpdump']);
  });

  it('gives a resumed conversation a stub naming the version and a snapshot file', () => {
    expect(knowledgeStub('0123456789abcdef', '/snap/0123456789abcdef.json')).toEqual({
      unchangedSince: '0123456789abcdef',
      snapshot: '/snap/0123456789abcdef.json',
    });
  });
});

describe('claudeSessionHasKnowledge', () => {
  let home: string | undefined;
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
  });

  async function transcript(lines: unknown[]): Promise<{ env: NodeJS.ProcessEnv; cwd: string }> {
    home = await mkdtemp(join(tmpdir(), 'kb-session-'));
    const cwd = '/work/space';
    const dir = join(home, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 's1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return { env: { CLAUDE_CONFIG_DIR: home }, cwd };
  }

  const userTurn = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
  const knowledge = (version: string) => promptSection('bridge_knowledge', { version, profileMemory: ['x'] });

  it('is true while the full block of that version sits after the last compaction', async () => {
    const { env, cwd } = await transcript([
      userTurn(`${knowledge('aaaaaaaaaaaaaaaa')}\n<user_input>hi</user_input>`),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      userTurn(`${promptSection('bridge_knowledge', knowledgeStub('aaaaaaaaaaaaaaaa'))}\n<user_input>again</user_input>`),
    ]);
    expect(claudeSessionHasKnowledge('s1', cwd, 'aaaaaaaaaaaaaaaa', env)).toBe(true);
    // Another version, or only a stub naming it: send the block.
    expect(claudeSessionHasKnowledge('s1', cwd, 'bbbbbbbbbbbbbbbb', env)).toBe(false);
  });

  it('is false once the conversation was compacted after the block', async () => {
    const { env, cwd } = await transcript([
      userTurn(`${knowledge('aaaaaaaaaaaaaaaa')}\n<user_input>hi</user_input>`),
      { type: 'system', subtype: 'compact_boundary' },
      userTurn('<user_input>after</user_input>'),
    ]);
    expect(claudeSessionHasKnowledge('s1', cwd, 'aaaaaaaaaaaaaaaa', env)).toBe(false);
  });

  it('is false without a transcript', () => {
    expect(claudeSessionHasKnowledge('missing', '/nowhere', 'aaaaaaaaaaaaaaaa', { CLAUDE_CONFIG_DIR: '/nonexistent' })).toBe(false);
  });
});
