import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWorktreeCleanup } from '../../../src/git/worktree-cleanup';
import { getWorktreeCleanupIdleDays } from '../../../src/config/schema';
import { WorkspaceStore } from '../../../src/workspace/store';
afterEach(() => vi.useRealTimers());
describe('worktree cleanup scheduling', () => {
  it('checks hourly, reads the switch live and stops on disconnect', async () => {
    vi.useFakeTimers();
    const store = new WorkspaceStore('/unused');
    const list = vi.spyOn(store, 'listManagedWorktrees').mockReturnValue([]);
    let enabled = false;
    const timer = startWorktreeCleanup({ store, idleDays: () => enabled ? 7 : undefined, protectedPaths: async () => [] });
    await vi.advanceTimersByTimeAsync(3600000); expect(list).not.toHaveBeenCalled();
    enabled = true;
    await vi.advanceTimersByTimeAsync(3599999); expect(list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(list).toHaveBeenCalledTimes(1);
    await timer.stop(); await vi.advanceTimersByTimeAsync(3600000); expect(list).toHaveBeenCalledTimes(1);
  });
  it('defaults off and validates the idle period', () => {
    expect(getWorktreeCleanupIdleDays({} as any)).toBeUndefined();
    expect(getWorktreeCleanupIdleDays({ preferences: { autoWorktreeCleanup: true } } as any)).toBe(7);
    for (const days of [0, -1, 366, NaN]) expect(getWorktreeCleanupIdleDays({ preferences: { autoWorktreeCleanup: true, worktreeCleanupIdleDays: days } } as any)).toBe(7);
    expect(getWorktreeCleanupIdleDays({ preferences: { autoWorktreeCleanup: true, worktreeCleanupIdleDays: 14 } } as any)).toBe(14);
  });
});
