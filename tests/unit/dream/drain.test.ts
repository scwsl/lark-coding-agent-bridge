import { describe, expect, it } from 'vitest';
import { dreamLeftover, dreamProgressed, nextDrainRound } from '../../../src/dream/drain.js';
import type { DreamRun } from '../../../src/dream/state.js';

function run(patch: Partial<DreamRun> = {}): DreamRun {
  return {
    id: 'b1',
    status: 'succeeded',
    actorId: 'a',
    startedAt: 0,
    sessions: 0,
    scopes: 0,
    exchanges: 0,
    memoryItems: 0,
    skillItems: 0,
    rejected: 0,
    deferred: [],
    targets: [],
    ...patch,
  };
}

describe('续跑', () => {
  const external = [{ library: 'cc', head: 'h', files: 3, pending: 5 }];

  it('counts pending external files and conversations deferred for the run limits only', () => {
    expect(
      dreamLeftover(
        run({
          external: [...external, { library: 'gone', head: '', files: 0, pending: 9, error: '拉取失败' }],
          deferred: [
            { key: 'a', reason: '超出本轮输入预算' },
            { key: 'b', reason: '超出本轮会话数上限' },
            { key: 'c', reason: '超出本轮运行时间' },
            { key: 'd', reason: '会话正在运行' },
          ],
        }),
      ),
    ).toEqual({ files: 5, sessions: 3 });
  });

  it('needs progress: files read by a turn that worked, or conversations consumed', () => {
    expect(dreamProgressed(run({ external }))).toBe(true);
    expect(dreamProgressed(run({ external, learnFailed: true }))).toBe(false);
    expect(dreamProgressed(run({ sessions: 2, checkpointAt: 1 }))).toBe(true);
    expect(dreamProgressed(run({ sessions: 2 }))).toBe(false);
  });

  it('follows a succeeded run with leftovers, up to the round limit', () => {
    expect(nextDrainRound(run({ external }), 6)).toEqual({ round: 2, note: '续跑第 2 轮（上一轮 `b1` 还剩 5 个外部库文件）' });
    expect(nextDrainRound(run({ external, round: 5 }), 6)?.round).toBe(6);
    expect(nextDrainRound(run({ external, round: 6 }), 6)).toBeUndefined();
    expect(nextDrainRound(run({ external }), 1)).toBeUndefined();
    expect(nextDrainRound(run({ external, status: 'failed' }), 6)).toBeUndefined();
    expect(nextDrainRound(run({ external: [{ library: 'cc', head: 'h', files: 3, pending: 0 }] }), 6)).toBeUndefined();
    expect(nextDrainRound(run({ external, learnFailed: true }), 6)).toBeUndefined();
  });
});
