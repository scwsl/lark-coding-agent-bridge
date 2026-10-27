import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyNotesPlan,
  buildNotesPrompt,
  notesChangelogLines,
  notesPlanSummary,
  parseNotesPlan,
  pickFamily,
  readFamilyNotes,
  type NoteFile,
} from '../../../src/dream/notes-merge.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lcb-notes-merge-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function note(scope: string, topic: string, entries: Array<[string, string]>): Promise<void> {
  await mkdir(join(dir, 'notes', scope), { recursive: true });
  const lines = entries.map(([id, text]) => `- [${id}] ${text}`).join('\n');
  await writeFile(join(dir, 'notes', scope, `${topic}.md`), `# ${topic}\n\n课堂精练归纳的项目事实。\n${lines}\n`, 'utf8');
}

async function seed(): Promise<NoteFile[]> {
  await note('oc_1', 'build', [
    ['a00001', '全工程构建用 mvnd -T 10'],
    ['a00002', '构建前先 install 上游模块'],
  ]);
  await note('oc_1_omt_x', 'build-tips', [
    ['b00001', '本机构建统一用 mvnd'],
    ['b00002', '构建要加全局锁'],
  ]);
  await note('oc_1_omt_y', 'build', [['c00001', '构建锁文件不要手动删']]);
  await note('oc_1_omt_y', 'dream-review', [['d00001', '待确认']]);
  await note('oc_2', 'deploy', [['e00001', '发布走 helm']]);
  return readFamilyNotes(dir, 'oc_1');
}

const merge = {
  into: { scope: 'oc_1', topic: 'build' },
  from: ['oc_1/build', 'oc_1_omt_x/build-tips', 'oc_1_omt_y/build'],
  entries: [
    { text: '全工程构建统一用 mvnd -T 10，并用全局锁包住', from: ['a00001', 'b00001', 'b00002'] },
    { text: '构建前先 install 上游模块', from: ['a00002'] },
    { text: '构建锁文件不要手动删', from: ['c00001'] },
  ],
  dropped: [],
  reason: '三个话题都在说本机构建',
};

describe('readFamilyNotes / pickFamily', () => {
  it('reads a chat and its topics, leaving review notes and other chats out', async () => {
    const notes = await seed();
    expect(notes.map((item) => `${item.scope}/${item.topic}`)).toEqual(['oc_1/build', 'oc_1_omt_x/build-tips', 'oc_1_omt_y/build']);
    expect(notes[0]?.entries).toEqual([
      { id: 'a00001', text: '全工程构建用 mvnd -T 10' },
      { id: 'a00002', text: '构建前先 install 上游模块' },
    ]);
  });

  it('picks the family with the most to fold, and none when there is nothing to fold', async () => {
    await seed();
    expect((await pickFamily(dir, ['oc_2', 'oc_1:omt_x']))?.family).toBe('oc_1');
    expect(await pickFamily(dir, ['oc_2'])).toBeUndefined();
  });
});

describe('buildNotesPrompt / parseNotesPlan', () => {
  it('accepts a merge that accounts for every entry', async () => {
    const notes = await seed();
    const { prompt, shown } = buildNotesPrompt('oc_1', notes);
    expect(shown).toHaveLength(3);
    expect(prompt).toContain('oc_1_omt_x/build-tips');
    const existing = new Set(notes.map((item) => `${item.scope}/${item.topic}`));
    const plan = parseNotesPlan(JSON.stringify({ merges: [merge] }), { family: 'oc_1', notes, existing });
    expect(plan).toEqual({ merges: [merge], rejected: [] });
    if ('error' in plan) return;
    expect(notesPlanSummary(plan, 'oc_1')).toEqual({ notes: 3, into: 1, lifted: 1, dropped: 0 });
    expect(notesChangelogLines(plan)[0]).toContain('`notes/oc_1/build.md` ← `oc_1/build`、`oc_1_omt_x/build-tips`、`oc_1_omt_y/build`');
  });

  it('turns down merges that lose entries, drop too much, leave the family or overwrite another note', async () => {
    const notes = await seed();
    const ctx = { family: 'oc_1', notes, existing: new Set([...notes.map((item) => `${item.scope}/${item.topic}`), 'oc_1/other']) };
    const lost = { ...merge, entries: merge.entries.slice(0, 2) };
    const tooMuch = { ...merge, entries: [merge.entries[0]], dropped: [{ id: 'a00002', reason: '过时' }, { id: 'c00001', reason: '重复' }] };
    const outside = { ...merge, into: { scope: 'oc_9', topic: 'build' } };
    const overwrite = { ...merge, into: { scope: 'oc_1', topic: 'other' } };
    const secret = { ...merge, entries: [{ text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', from: ['a00001', 'a00002', 'b00001', 'b00002', 'c00001'] }] };
    const unknown = { ...merge, entries: [...merge.entries, { text: '多出来的', from: ['zzzzzz'] }] };
    for (const bad of [lost, tooMuch, outside, overwrite, secret, unknown]) {
      const plan = parseNotesPlan(JSON.stringify({ merges: [bad] }), ctx);
      expect('error' in plan ? plan.error : plan.merges).toEqual([]);
      expect('error' in plan ? [] : plan.rejected).toHaveLength(1);
    }
    // One dropped entry out of five is within a quarter.
    const fine = { ...merge, entries: [merge.entries[0], merge.entries[1]], dropped: [{ id: 'c00001', reason: '与 b00002 重复' }] };
    const plan = parseNotesPlan(`说明文字 ${JSON.stringify({ merges: [fine] })}`, ctx);
    expect('error' in plan ? undefined : plan.merges).toHaveLength(1);
    expect(parseNotesPlan('没有 JSON', ctx)).toEqual({ error: '输出里没有 JSON 对象' });
  });

  it('keeps a note in one merge only', async () => {
    const notes = await seed();
    const ctx = { family: 'oc_1', notes, existing: new Set(notes.map((item) => `${item.scope}/${item.topic}`)) };
    const second = { ...merge, into: { scope: 'oc_1', topic: 'build-2' } };
    const plan = parseNotesPlan(JSON.stringify({ merges: [merge, second] }), ctx);
    expect('error' in plan ? undefined : [plan.merges.length, plan.rejected]).toEqual([1, ['笔记 oc_1/build 出现在两个合并里']]);
  });
});

describe('applyNotesPlan', () => {
  it('writes the merged note under the chat and removes the folded ones', async () => {
    const notes = await seed();
    const plan = parseNotesPlan(JSON.stringify({ merges: [merge] }), {
      family: 'oc_1',
      notes,
      existing: new Set(notes.map((item) => `${item.scope}/${item.topic}`)),
    });
    if ('error' in plan) throw new Error(plan.error);
    const changed = await applyNotesPlan(dir, plan);
    expect(changed.sort()).toEqual(['notes/oc_1/build.md', 'notes/oc_1_omt_x/build-tips.md', 'notes/oc_1_omt_y/build.md']);
    const merged = await readFile(join(dir, 'notes', 'oc_1', 'build.md'), 'utf8');
    expect(merged).toContain('- [a00001] 全工程构建统一用 mvnd -T 10，并用全局锁包住');
    expect(merged).toContain('- [a00002] 构建前先 install 上游模块');
    expect(merged).toContain('- [c00001] 构建锁文件不要手动删');
    expect(await readdir(join(dir, 'notes', 'oc_1_omt_x'))).toEqual([]);
    expect(await readdir(join(dir, 'notes', 'oc_1_omt_y'))).toEqual(['dream-review.md']);
  });
});
