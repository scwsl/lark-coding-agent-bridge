import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMemoryPlan,
  buildMemoryPrompt,
  flagRefs,
  memoryPlanSummary,
  memoryPrBody,
  memoryWorthConsolidating,
  parseMemoryOps,
  readMemoryFiles,
  readPendingFlags,
  type MemoryFile,
} from '../../../src/dream/consolidate.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lcb-consolidate-'));
  await mkdir(join(dir, 'notes', 'oc_1'), { recursive: true });
  await mkdir(join(dir, 'chats'), { recursive: true });
  await writeFile(
    join(dir, 'MEMORY.md'),
    '# 记忆（全局）\n\n这个 profile 下所有会话都会看到下面的内容。\n- [aaa111] 提交信息不带 AI 署名\n- [bbb222] 回复用中文\n- [ccc333] 周报周五发\n- [ddd444] 周报发到群里\n',
  );
  await writeFile(join(dir, 'chats', 'oc_1.md'), '# 记忆（本会话）\n\n- [eee555] 本群用 dev 分支\n');
  await writeFile(
    join(dir, 'notes', 'oc_1', 'dream-review.md'),
    '# dream-review\n\n- [f00001] 建议合并 `ccc333`（全局）「周报周五发」、`ddd444`（全局）「周报发到群里」 → 「周五把周报发到群里」（理由：重复）\n- [f00002] 疑似过时 `eee555`（本会话）「本群用 dev 分支」\n- [f00003] 冲突 `aaa111`（全局）「提交信息不带 AI 署名」 ↔ 新说法「PR 描述也不带」\n',
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function load() {
  const flags = await readPendingFlags(dir);
  const files = await readMemoryFiles(dir, flags);
  return { flags, files };
}

describe('pending flags and memory files', () => {
  it('reads every open flag and the files they point at', async () => {
    const { flags, files } = await load();
    expect(flags.map((flag) => [flag.id, flag.scope])).toEqual([
      ['f00001', 'oc_1'],
      ['f00002', 'oc_1'],
      ['f00003', 'oc_1'],
    ]);
    expect(flagRefs(flags[1]!)).toEqual([{ id: 'eee555', where: 'oc_1' }]);
    expect(files.map((file) => [file.where, file.path, file.entries.length])).toEqual([
      ['profile', 'MEMORY.md', 4],
      ['oc_1', 'chats/oc_1.md', 1],
    ]);
    expect(memoryWorthConsolidating(flags, files)).toBe(true);
    expect(memoryWorthConsolidating([], files)).toBe(false);
    const full: MemoryFile[] = [{ where: 'profile', path: 'MEMORY.md', entries: [{ id: 'aaa111', text: 'x'.repeat(8_000) }] }];
    expect(memoryWorthConsolidating([], full)).toBe(true);
    const prompt = buildMemoryPrompt({ flags, files });
    expect(prompt).toContain('<flags>');
    expect(prompt).toContain('"where":"oc_1"');
  });
});

describe('parseMemoryOps', () => {
  it('keeps checked operations and says why the rest were dropped', async () => {
    const ctx = await load();
    const plan = parseMemoryOps(
      JSON.stringify({
        ops: [
          { op: 'merge', where: 'profile', ids: ['ccc333', 'ddd444'], text: '周五把周报发到群里', flags: ['f00001'], reason: '重复' },
          { op: 'delete', where: 'oc_1', id: 'eee555', flags: ['f00002'], reason: '已改用 main' },
          { op: 'update', where: 'profile', id: 'ccc333', text: '又改一次', flags: [], reason: '重复操作' },
          { op: 'update', where: 'profile', id: 'zzzzzz', text: 'x', flags: [], reason: '格式错' },
          { op: 'update', where: 'profile', id: 'aaa111', text: 'token ghp_' + 'z'.repeat(36), flags: [], reason: '凭证' },
          { op: 'dismiss', flags: ['f00009'], reason: '不存在的标记' },
          { op: 'dismiss', flags: ['f00003'], reason: '不成立' },
          { op: 'update', where: 'oc_2', id: 'eee555', text: 'x', flags: [], reason: '没有这份' },
        ],
      }),
      ctx,
    );
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.ops.map((op) => op.op)).toEqual(['merge', 'delete', 'dismiss']);
    expect(plan.rejected).toEqual([
      '条目 ccc333 被改了两次',
      'id 格式不对',
      '疑似包含凭证（github-token）',
      '引用了不存在的标记 id f00009',
      '没有 oc_2 这份记忆',
    ]);
    expect(memoryPlanSummary(plan)).toEqual({ updated: 0, merged: 1, deleted: 1, dismissed: 1 });
    expect(parseMemoryOps('没有', ctx)).toEqual({ error: '输出里没有 JSON 对象' });
  });

  it('changes no more than a quarter of a file, and keeps it within the budget', async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ id: `a0000${i.toString(16)}`, text: `条目 ${i}` }));
    const files: MemoryFile[] = [{ where: 'profile', path: 'MEMORY.md', entries }];
    const ops = entries.slice(0, 5).map((entry) => ({ op: 'update', where: 'profile', id: entry.id, text: `${entry.text} 改`, flags: [], reason: 'r' }));
    const plan = parseMemoryOps(JSON.stringify({ ops }), { flags: [], files });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.ops).toHaveLength(3);
    expect(plan.rejected).toEqual(['全局记忆 一次改动超过条目数的四分之一（上限 3 条）', '全局记忆 一次改动超过条目数的四分之一（上限 3 条）']);

    const big: MemoryFile[] = [{ where: 'profile', path: 'MEMORY.md', entries: [{ id: 'aaa111', text: 'x'.repeat(9_800) }, { id: 'bbb222', text: 'y' }] }];
    const grow = parseMemoryOps(JSON.stringify({ ops: [{ op: 'update', where: 'profile', id: 'bbb222', text: 'y'.repeat(400), flags: [], reason: 'r' }] }), { flags: [], files: big });
    if ('error' in grow) throw new Error(grow.error);
    expect(grow.ops).toEqual([]);
    expect(grow.rejected[0]).toContain('注入预算');
  });
});

describe('applyMemoryPlan / memoryPrBody', () => {
  it('rewrites entries in place, closes handled flags and drops an empty review note', async () => {
    const ctx = await load();
    const plan = parseMemoryOps(
      JSON.stringify({
        ops: [
          { op: 'merge', where: 'profile', ids: ['ccc333', 'ddd444'], text: '周五把周报发到群里', flags: ['f00001'], reason: '重复' },
          { op: 'update', where: 'profile', id: 'aaa111', text: '提交信息和 PR 描述都不带 AI 署名', flags: ['f00003'], reason: '新说法更完整' },
          { op: 'delete', where: 'oc_1', id: 'eee555', flags: [], reason: '过时' },
        ],
      }),
      ctx,
    );
    if ('error' in plan) throw new Error(plan.error);
    // Four entries: two may change, the merge takes both.
    expect(plan.rejected).toEqual(['全局记忆 一次改动超过条目数的四分之一（上限 2 条）']);
    const changed = await applyMemoryPlan(dir, plan, ctx);
    expect(changed).toEqual(['MEMORY.md', 'chats/oc_1.md', 'notes/oc_1/dream-review.md']);
    expect(await readFile(join(dir, 'MEMORY.md'), 'utf8')).toBe(
      '# 记忆（全局）\n\n这个 profile 下所有会话都会看到下面的内容。\n- [aaa111] 提交信息不带 AI 署名\n- [bbb222] 回复用中文\n- [ccc333] 周五把周报发到群里\n',
    );
    expect(await readFile(join(dir, 'chats', 'oc_1.md'), 'utf8')).toBe('# 记忆（本会话）\n\n');
    // f00002 and the conflict whose rewrite was held back are still open
    expect(await readFile(join(dir, 'notes', 'oc_1', 'dream-review.md'), 'utf8')).toContain('[f00002]');
    expect(await readFile(join(dir, 'notes', 'oc_1', 'dream-review.md'), 'utf8')).toContain('[f00003]');
    expect(await readFile(join(dir, 'notes', 'oc_1', 'dream-review.md'), 'utf8')).not.toContain('[f00001]');

    const body = memoryPrBody({ batchId: 'b1', profile: 'claude', plan, files: ctx.files, flags: ctx.flags });
    expect(body).toContain('**合并** 全局记忆 `ccc333` + `ddd444`（处理标记 `f00001`）');
    expect(body).toContain('原 `ddd444`：周报发到群里');
    expect(body).toContain('**删除** 会话记忆 `oc_1` `eee555`');

    const last = parseMemoryOps(JSON.stringify({ ops: [{ op: 'dismiss', flags: ['f00002', 'f00003'], reason: '已处理' }] }), await load());
    if ('error' in last) throw new Error(last.error);
    expect(await applyMemoryPlan(dir, last, await load())).toEqual(['notes/oc_1/dream-review.md']);
    await expect(readFile(join(dir, 'notes', 'oc_1', 'dream-review.md'), 'utf8')).rejects.toThrow();
  });
});
