import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diaryEntry, diaryWorthWriting, rejectionCounts, writeDiary, type DiaryInput } from '../../../src/dream/diary.js';

const AT = Date.parse('2026-10-27T20:00:00Z');

function input(over: Partial<DiaryInput> = {}): DiaryInput {
  return {
    batchId: '20261028-040000-abcd',
    at: AT,
    timezone: 'Asia/Shanghai',
    trigger: 'auto',
    light: {
      sessions: 3,
      scopes: 2,
      exchanges: 17,
      deferred: 1,
      external: [
        { library: 'cc', files: 4, pending: 2 },
        { library: 'quiet', files: 0, pending: 0 },
      ],
      recall: { sessions: 5, exchanges: 40, reads: 12 },
      topNotes: [{ key: 'note:oc_1/build', reads: 6 }],
      topSkills: [{ key: 'skill:antelope-tcpdump', reads: 3 }],
    },
    deep: { memory: 1, notes: 2, skills: 0, flags: 1 },
    rejected: [],
    ...over,
  };
}

describe('diaryEntry', () => {
  it('tells what each phase did, without anything that was turned down', () => {
    const entry = diaryEntry(
      input({
        rem: { narrative: '本周集中在构建与抓包。', themes: 3, recurring: 1 },
        deep: {
          memory: 1,
          notes: 2,
          skills: 0,
          flags: 1,
          pool: { entered: 4, promoted: 2, expired: 1, size: 9 },
          consolidation: { prUrl: 'https://github.com/o/k/pull/9', updated: 2, merged: 1, deleted: 0, dismissed: 1 },
          notesMerge: { notes: 5, into: 2, lifted: 1, dropped: 3 },
          archived: 4,
        },
        rejected: [
          { scopeId: 'oc_1', kind: 'memory', reason: '与已提交过的条目重复' },
          { scopeId: 'oc_1', kind: 'memory', reason: '与已有记忆重复' },
          { scopeId: 'oc_1', kind: 'memory', reason: '疑似包含凭证（token）' },
          { scopeId: 'oc_1', kind: 'skill', reason: '简称 x 和已有技能 a:x 重名' },
          { scopeId: 'oc_1', kind: 'output', reason: '输出的 JSON 无法解析' },
        ],
      }),
    );
    expect(entry).toMatch(/^## 2026-10-28 04:00 · 批次 `20261028-040000-abcd`（自动）/);
    expect(entry).toContain('读了 3 个会话（2 个范围、17 轮）；课前学习 cc 4 个文件（还剩 2 个）；1 个会话延后。');
    expect(entry).not.toContain('quiet');
    expect(entry).toContain('召回统计：新统计到 12 次读取');
    expect(entry).toContain('oc_1/build（6）');
    expect(entry).toContain('antelope-tcpdump（3）');
    expect(entry).toContain('**REM**：本周集中在构建与抓包。主题 3 个，其中跨会话或跨天复现的 1 个。');
    expect(entry).toContain('当晚生效：记忆 1 条、笔记 2 条、待处理标记 1 条');
    expect(entry).toContain('候选池：新进 4 条、晋升 2 条、过期 1 条，池中现有 9 条');
    expect(entry).toContain('待审 Draft PR https://github.com/o/k/pull/9');
    expect(entry).toContain('笔记整合：5 篇合成 2 篇，1 篇提升到主会话，去掉重复条目 3 条');
    expect(entry).toContain('归档长期没人读的笔记 4 篇');
    expect(entry).toContain('**未采纳**：5 条——重复 2、其他 1、技能命名不合规 1、疑似含凭证 1');
    expect(entry).not.toContain('token');
  });

  it('says what waits in a PR and what did not get through', () => {
    const entry = diaryEntry(input({ deep: { memory: 0, notes: 1, skills: 1, flags: 0, viaPr: true, problems: ['知识库：推送失败'] } }));
    expect(entry).toContain('写进待审 Draft PR：笔记 1 条、技能 1 个');
    expect(entry).toContain('没走通的（下一轮重试）：知识库：推送失败');
    expect(entry).not.toContain('**REM**');
    expect(entry).not.toContain('**未采纳**');
  });
});

describe('rejectionCounts / diaryWorthWriting', () => {
  it('counts rejections by kind, most frequent first', () => {
    expect(
      rejectionCounts([
        { scopeId: 'a', kind: 'memory', reason: '缺少整理理由' },
        { scopeId: 'a', kind: 'memory', reason: '引用了不存在的记忆 id abc123' },
        { scopeId: 'a', kind: 'memory', reason: '超过每个会话范围 20 条的上限' },
        { scopeId: 'a', kind: 'memory', reason: '缺少整理理由' },
      ]),
    ).toEqual([
      { kind: '缺少理由', count: 2 },
      { kind: '引用了不存在的条目', count: 1 },
      { kind: '超出数量上限', count: 1 },
    ]);
  });

  it('writes to the repository only when the run changed something', () => {
    expect(diaryWorthWriting(input({ deep: { memory: 0, notes: 0, skills: 0, flags: 0 } }))).toBe(false);
    expect(diaryWorthWriting(input({ deep: { memory: 0, notes: 0, skills: 0, flags: 0, archived: 1 } }))).toBe(true);
    expect(diaryWorthWriting(input({ deep: { memory: 0, notes: 0, skills: 0, flags: 0, pool: { entered: 1, promoted: 0, expired: 0, size: 1 } } }))).toBe(true);
    expect(diaryWorthWriting(input())).toBe(true);
  });

  it('puts the newest entry first in DREAMS.md', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcb-diary-'));
    try {
      expect(await writeDiary(dir, '## 第一晚\n\n- a')).toEqual({ file: 'DREAMS.md' });
      await writeDiary(dir, '## 第二晚\n\n- b');
      const text = await readFile(join(dir, 'DREAMS.md'), 'utf8');
      expect(text).toMatch(/^# 梦境日记/);
      expect(text.indexOf('第二晚')).toBeLessThan(text.indexOf('第一晚'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
