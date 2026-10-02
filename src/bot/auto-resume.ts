import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { RunLimit } from '../card/run-state';

/** Wait this long past the reset before resuming, so the new window is open. */
export const RESUME_GRACE_MS = 60_000;
/** When the agent never said when the quota resets, try again after this. */
export const UNKNOWN_RESET_RETRY_MS = 30 * 60_000;
/** Consecutive auto-resumes that hit the quota again before giving up. */
export const MAX_AUTO_RESUMES = 6;

/** When a run paused by `limit` should be resumed. */
export function resumeAtFor(limit: RunLimit): number {
  const reset = limit.resetsAt ?? limit.at + UNKNOWN_RESET_RETRY_MS;
  return Math.max(reset, limit.at) + RESUME_GRACE_MS;
}

/** `five_hour` → `5 小时额度`. */
export function limitLabel(limitType: string | undefined): string {
  switch (limitType) {
    case 'five_hour':
      return '5 小时额度';
    case 'seven_day':
      return '本周额度';
    case 'seven_day_opus':
      return '本周 Opus 额度';
    case 'seven_day_sonnet':
      return '本周 Sonnet 额度';
    case 'seven_day_overage_included':
      return '本周额度（含超额）';
    case 'overage':
      return '超额用量';
    default:
      return 'Claude 额度';
  }
}

/** `10-02 23:40`, in the bridge host's local time. */
export function formatMoment(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What the resumed run is told. */
export function autoResumePrompt(limitType: string | undefined): string {
  return (
    `[自动续跑] 上一轮任务因 Claude ${limitLabel(limitType)}用完而暂停，额度已经重置。` +
    '请从中断的地方继续完成原任务，不要重复已经完成的步骤；如果原任务其实已经完成，简短说明即可。'
  );
}

/** One run waiting for its quota to reset. Persisted, so it survives restarts. */
export interface PendingResume {
  scope: string;
  chatId: string;
  chatType: 'p2p' | 'group' | 'topic';
  threadId?: string;
  /** Who started the paused task; the resume runs on their behalf. */
  senderId: string;
  senderName?: string;
  /** The message the paused run replied to — the new card replies to it too. */
  originMessageId: string;
  /** The paused card, to note on it that the task went on. */
  cardMessageId?: string;
  card?: object;
  resumeAt: number;
  limitType?: string;
  /** 1 for the first resume of a task, +1 each time a resume hits the quota again. */
  attempt: number;
  createdAt: number;
}

interface ResumeFile {
  resumes: Record<string, PendingResume>;
}

export interface AutoResumerOptions {
  /** Where pending resumes are kept; in-memory only when absent. */
  file?: string;
  /** Start the resumed run. Errors are logged, never retried. */
  fire: (resume: PendingResume) => Promise<void>;
  now?: () => number;
  tickMs?: number;
}

/**
 * Resumes tasks the plan's quota stopped, once the quota resets.
 *
 * One pending resume per scope (a newer pause replaces the older one). A
 * timer checks for due entries instead of one long `setTimeout` each: a weekly
 * reset can be days out, and a check loop also picks up what was persisted
 * before a restart.
 */
export class AutoResumer {
  private resumes = new Map<string, PendingResume>();
  /** Attempt number of the resume that last fired per scope, to chain retries. */
  private readonly fired = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private saving: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly opts: AutoResumerOptions) {
    this.now = opts.now ?? Date.now;
  }

  async load(): Promise<void> {
    if (!this.opts.file) return;
    let text: string;
    try {
      text = await readFile(this.opts.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    try {
      const parsed = JSON.parse(text) as Partial<ResumeFile>;
      for (const [scope, entry] of Object.entries(parsed.resumes ?? {})) {
        if (isPendingResume(entry)) this.resumes.set(scope, entry);
      }
    } catch (err) {
      log.warn('auto-resume', 'load-failed', { err: String(err) });
    }
    if (this.resumes.size > 0) log.info('auto-resume', 'loaded', { count: this.resumes.size });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get(scope: string): PendingResume | undefined {
    return this.resumes.get(scope);
  }

  /** Attempt number the next pause in `scope` should carry. */
  nextAttempt(scope: string, resumedRun: boolean): number {
    return resumedRun ? (this.fired.get(scope) ?? 0) + 1 : 1;
  }

  async schedule(resume: PendingResume): Promise<void> {
    this.resumes.set(resume.scope, resume);
    log.info('auto-resume', 'scheduled', {
      scope: resume.scope,
      resumeAt: new Date(resume.resumeAt).toISOString(),
      limitType: resume.limitType ?? null,
      attempt: resume.attempt,
    });
    await this.persist();
  }

  /** Drop the pending resume for `scope`, if any, and return it. */
  async cancel(scope: string, reason: string): Promise<PendingResume | undefined> {
    const existing = this.resumes.get(scope);
    this.fired.delete(scope);
    if (!existing) return undefined;
    this.resumes.delete(scope);
    log.info('auto-resume', 'cancelled', { scope, reason });
    await this.persist();
    return existing;
  }

  /** Fire every resume due by `now`. Exposed for tests. */
  async tick(now: number = this.now()): Promise<void> {
    const due = [...this.resumes.values()].filter((r) => r.resumeAt <= now);
    if (due.length === 0) return;
    for (const r of due) {
      this.resumes.delete(r.scope);
      this.fired.set(r.scope, r.attempt);
    }
    await this.persist();
    for (const r of due) {
      log.info('auto-resume', 'fire', { scope: r.scope, attempt: r.attempt });
      try {
        await this.opts.fire(r);
      } catch (err) {
        log.fail('auto-resume', err, { scope: r.scope, step: 'fire' });
      }
    }
  }

  private persist(): Promise<void> {
    const file = this.opts.file;
    if (!file) return Promise.resolve();
    const data: ResumeFile = { resumes: Object.fromEntries(this.resumes) };
    this.saving = this.saving
      .catch(() => {})
      .then(() => writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 }))
      .catch((err) => log.warn('auto-resume', 'persist-failed', { err: String(err) }));
    return this.saving;
  }
}

function isPendingResume(value: unknown): value is PendingResume {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<PendingResume>;
  return (
    typeof r.scope === 'string' &&
    typeof r.chatId === 'string' &&
    (r.chatType === 'p2p' || r.chatType === 'group' || r.chatType === 'topic') &&
    typeof r.senderId === 'string' &&
    typeof r.originMessageId === 'string' &&
    typeof r.resumeAt === 'number' &&
    typeof r.attempt === 'number'
  );
}
