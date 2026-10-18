import { describe, expect, it } from 'vitest';
import { interruptedNoticeText } from '../../../src/bot/interrupted-notice.js';
import { findLedger, isKilledExit, stripLedgerLines } from '../../../src/bot/task-ledger.js';
import type { RunRecord } from '../../../src/runtime/run-registry.js';

describe('task ledger', () => {
  it('finds the ledger line the agent announces', () => {
    expect(findLedger('开始。\n📒 任务台账：/Users/a/proj/docs/progress/up.md\n先读代码')).toBe(
      '/Users/a/proj/docs/progress/up.md',
    );
    expect(findLedger('任务台账: `~/.occam/tasks/x.md`')).toBe('~/.occam/tasks/x.md');
    expect(findLedger('📒 Task ledger: /tmp/l.md')).toBe('/tmp/l.md');
    expect(findLedger('我会建一份任务台账，稍后给出路径')).toBeUndefined();
    expect(findLedger('任务台账：docs/progress/x.md')).toBeUndefined();
  });

  it('tells a kill from outside apart from a real failure', () => {
    expect(isKilledExit('claude exited with code 143')).toBe(true);
    expect(isKilledExit('claude exited with code 137')).toBe(true);
    expect(isKilledExit('killed by SIGTERM')).toBe(true);
    expect(isKilledExit('claude exited with code 1: bad config')).toBe(false);
    expect(isKilledExit(undefined)).toBe(false);
  });

  it('says in the restart notice that the task resumes on its own', () => {
    const rec: RunRecord = {
      runId: 'r',
      scope: 'oc',
      chatId: 'oc',
      originMessageId: 'om',
      promptPreview: '升级依赖',
      startedAt: 0,
      ownerPid: 1,
      ledger: '/tmp/l.md',
    };
    expect(interruptedNoticeText(rec, 'restart', 60_000, true)).toContain('按任务台账自动继续（/tmp/l.md）');
    expect(interruptedNoticeText(rec, 'restart', 60_000)).toContain('回一句「继续」');
  });
});

describe('run registry keeps what an interrupted task needs to resume', () => {
  it('persists the ledger and resume identity across processes', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { RunRegistry } = await import('../../../src/runtime/run-registry.js');
    const dir = await mkdtemp(join(tmpdir(), 'run-registry-'));
    try {
      const file = join(dir, 'runs.json');
      const deadPid = 999_999;
      const before = new RunRegistry(file, deadPid);
      before.start({
        runId: 'r1',
        scope: 'oc',
        chatId: 'oc',
        originMessageId: 'om',
        promptPreview: '升级',
        startedAt: Date.now(),
        resumeAs: { senderId: 'ou_owner', chatType: 'p2p', locale: 'zh' },
      });
      before.annotate('r1', { ledger: '/tmp/l.md' });
      await before.flush();

      const after = new RunRegistry(file, process.pid);
      await after.load();
      const [orphan] = after.takeOrphans();
      // takeOrphans persists in the background: let that write land before the directory goes.
      await after.flush();
      expect(orphan).toMatchObject({
        ledger: '/tmp/l.md',
        resumeAs: { senderId: 'ou_owner', chatType: 'p2p', locale: 'zh' },
      });
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  });
});

describe('stripLedgerLines', () => {
  it('drops the ledger line and keeps the rest of the answer', () => {
    const text = '做完了：\n\n- 结论 A\n\n📒 任务台账：/Users/a/tasks/x.md\n\n下一步 B';
    expect(stripLedgerLines(text)).toBe('做完了：\n\n- 结论 A\n\n下一步 B');
  });

  it('handles a ledger line at the end, in English, or quoted', () => {
    expect(stripLedgerLines('结论\n📒 任务台账：`~/.occam/tasks/x.md`')).toBe('结论\n');
    expect(stripLedgerLines('Done.\n📒 Task ledger: /tmp/l.md\nNext')).toBe('Done.\nNext');
    expect(stripLedgerLines('> 📒 任务台账：/tmp/l.md\n正文')).toBe('正文');
  });

  it('leaves text without a ledger path line untouched', () => {
    for (const text of ['提到任务台账这个词，但没有路径行', '任务台账：已经更新到第 3 步']) {
      expect(stripLedgerLines(text)).toBe(text);
    }
  });
});
