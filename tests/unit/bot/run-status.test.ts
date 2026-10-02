import { describe, expect, it } from 'vitest';
import type { RunHandle } from '../../../src/bot/active-runs.js';
import { describeActiveRun } from '../../../src/bot/run-status.js';

function handle(overrides: Partial<RunHandle> = {}): RunHandle {
  return {
    run: { runId: 'r', pid: process.pid } as RunHandle['run'],
    interrupted: false,
    startedAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}

describe('describeActiveRun', () => {
  it('reports runtime, last activity, the running tool and the agent process', () => {
    const line = describeActiveRun(
      handle({ lastActivityAt: 364_000, toolLabel: '查 bridge 日志（Bash）' }),
      372_000,
    );
    expect(line).toBe(
      `已运行 6:12 · 上次动静 8 秒前 · 当前：查 bridge 日志（Bash） · agent 进程 ${process.pid} 存活`,
    );
  });

  it('flags a run that has gone quiet', () => {
    const line = describeActiveRun(handle({ run: { runId: 'r' } as RunHandle['run'] }), 300_000);
    expect(line).toBe('已运行 5:00 · ⚠️ 已 5 分钟没有新动静');
  });
});
