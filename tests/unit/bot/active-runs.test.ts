import { describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import type { AgentRun } from '../../../src/agent/types';

function fakeRun(): AgentRun {
  return { stop: vi.fn(async () => {}), waitForExit: vi.fn(async () => true) } as unknown as AgentRun;
}

describe('ActiveRuns stop cause', () => {
  it('records who stopped a run: a person by default, or the recall of its message', () => {
    const runs = new ActiveRuns();
    const byUser = runs.register('s1', fakeRun());
    const byRecall = runs.register('s2', fakeRun());

    expect(runs.interrupt('s1')).toBe(true);
    expect(runs.interruptDetailed('s2', 'recalled')).toEqual({ active: true, background: false });

    expect(byUser.stopCause).toBe('user');
    expect(byRecall.stopCause).toBe('recalled');
    expect(byRecall.interrupted).toBe(true);
    expect(byRecall.run.stop).toHaveBeenCalled();
    expect(runs.get('s2')).toBeUndefined();
  });
});
