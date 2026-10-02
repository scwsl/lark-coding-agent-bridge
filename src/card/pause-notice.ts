import { formatMoment, runStrings, type Locale } from './i18n';
import type { RunLimit } from './run-state';

/** `five_hour` → `5 小时额度` / `5-hour quota`. */
export function limitLabel(limitType: string | undefined, locale?: Locale): string {
  const t = runStrings(locale);
  return (limitType && t.limitLabels[limitType]) || t.limitFallback;
}

/** What a paused run's card says: why it stopped, and what happens next. */
export function pauseNotice(limit: RunLimit | undefined, locale?: Locale): string {
  const t = runStrings(locale);
  const why = t.paused(
    limitLabel(limit?.limitType, locale),
    limit?.resetsAt ? formatMoment(limit.resetsAt) : undefined,
  );
  const next = limit?.autoResumeAt ? t.autoResumeAt(formatMoment(limit.autoResumeAt)) : t.resumeManually;
  return `${why}\n${next}`;
}
