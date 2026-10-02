import { formatMoment, limitLabel } from '../bot/auto-resume';
import type { RunLimit } from './run-state';

/** What a paused run's card says: why it stopped, and what happens next. */
export function pauseNotice(limit: RunLimit | undefined): string {
  const label = limitLabel(limit?.limitType);
  const reset = limit?.resetsAt ? `（${formatMoment(limit.resetsAt)} 重置）` : '';
  const why = `⏸ **任务暂停**：Claude ${label}已用完${reset}。`;
  if (limit?.autoResumeAt) {
    return (
      `${why}\n将在 **${formatMoment(limit.autoResumeAt)}** 自动继续，届时新开一张卡片接着做；` +
      '发 `/stop` 可以取消自动续跑。'
    );
  }
  return `${why}\n额度重置后发「继续」，我会从中断的地方接着做。`;
}
