import type { DreamRun } from './state';

/**
 * 续跑: one run reads within its limits — input characters, conversations,
 * minutes — and leaves the rest. Rather than wait a day for the next window,
 * a run that left work behind and made progress is followed by another, up
 * to `dreamTuning.drainRounds` in a row. Pure parts only; the service decides
 * whether the profile is idle and the quota allows it.
 */

/**
 * Deferral reasons that are about this run, not about the conversation itself:
 * its limits, or giving way to a user task (see DreamService#preempt).
 */
/** Deferral reason when every account is at 自动整理's quota ceiling; counts as leftover for 续跑. */
export const ACCOUNTS_FULL_REASON = '各账户额度都到了课堂精练的上限';

const LIMIT_REASONS: ReadonlySet<string> = new Set([
  '超出本轮输入预算',
  '超出本轮会话数上限',
  '超出本轮运行时间',
  '让位给用户任务',
  ACCOUNTS_FULL_REASON,
]);

export interface DreamLeftover {
  /** External library files that did not fit this run's budget. */
  files: number;
  /** Conversations deferred only for this run's limits. */
  sessions: number;
}

export function dreamLeftover(run: DreamRun): DreamLeftover {
  const files = (run.external ?? []).filter((item) => !item.error).reduce((sum, item) => sum + item.pending, 0);
  const sessions = run.deferred.filter((item) => LIMIT_REASONS.has(item.reason)).length;
  return { files, sessions };
}

/** Something was consumed: a cursor moved, so the next run starts further on. */
export function dreamProgressed(run: DreamRun): boolean {
  if (run.checkpointAt !== undefined && run.sessions > 0) return true;
  if (run.learnFailed) return false;
  return (run.external ?? []).some((item) => !item.error && item.files > 0);
}

/** The run that should follow `run`, or nothing: finished, failed, stuck, or out of rounds. */
export function nextDrainRound(run: DreamRun, maxRounds: number): { round: number; note: string } | undefined {
  if (run.status !== 'succeeded') return undefined;
  const round = run.round ?? 1;
  if (round >= maxRounds) return undefined;
  const left = dreamLeftover(run);
  if (left.files + left.sessions === 0 || !dreamProgressed(run)) return undefined;
  const parts = [
    left.files > 0 ? `${left.files} 个外部库文件` : undefined,
    left.sessions > 0 ? `${left.sessions} 个会话` : undefined,
  ].filter(Boolean);
  return { round: round + 1, note: `续跑第 ${round + 1} 轮（上一轮 \`${run.id}\` 还剩 ${parts.join('、')}）` };
}
