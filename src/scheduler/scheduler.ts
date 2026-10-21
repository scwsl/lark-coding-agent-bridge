import { log } from '../core/logger';
import { CronParseError, nextCronTime, parseCron } from './cron';
import { notifyJobChat, runScheduledJob, scheduleLabel, type JobRunnerDeps } from './runner';
import type { JobStore } from './store';
import { jobTitleMd, type JobRunRecord, type ScheduledJob } from './types';

/** How often the scheduler looks for due jobs. */
const DEFAULT_TICK_MS = 30_000;

/**
 * How late a cron fire may be and still run after downtime.
 *
 * The bridge runs on someone's laptop, which sleeps. Firing a 09:00 daily job
 * at 10:30 when the lid opens is what the person wanted; firing last Tuesday's
 * at the same moment is noise. Six hours splits those two cases, and a missed
 * slot older than that is logged and skipped rather than replayed.
 */
const CRON_CATCHUP_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Consecutive failures after which a job is disarmed instead of retried forever. */
const MAX_FAILURE_STREAK = 5;

export interface SchedulerOptions extends JobRunnerDeps {
  store: JobStore;
  tickMs?: number;
  now?: () => number;
  /** Injectable for tests — defaults to the real agent run. */
  runJob?: (job: ScheduledJob) => Promise<JobRunRecord>;
}

/**
 * Fires scheduled jobs while the bridge is connected.
 *
 * Lives inside `startChannel`, so exactly one process per profile ever ticks:
 * the profile runtime lock already guarantees a single live bridge, and a job
 * that fired twice would double-post into a chat.
 */
export class Scheduler {
  private readonly opts: SchedulerOptions;
  private readonly store: JobStore;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private readonly inFlight = new Set<string>();

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
  }

  /** The job list this scheduler drives — what `/cron` reads and edits. */
  get jobs(): JobStore {
    return this.store;
  }

  /** Arm every enabled job and start ticking. */
  start(): void {
    if (this.timer) return;
    let armed = 0;
    for (const job of this.store.list()) {
      if (!job.enabled) continue;
      const next = this.computeNextRun(job);
      if (next !== job.nextRunAt) this.store.update(job.id, { nextRunAt: next });
      if (next !== undefined) armed++;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => log.fail('scheduler', err, { step: 'tick' }));
    }, this.opts.tickMs ?? DEFAULT_TICK_MS);
    // Keeping the event loop alive for the scheduler alone would stop the
    // process from exiting; the bridge's own WS connection is what holds it.
    this.timer.unref?.();
    log.info('scheduler', 'started', { jobs: this.store.list().length, armed });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    log.info('scheduler', 'stopped', { inFlight: this.inFlight.size });
  }

  /**
   * Fire everything that is due. Exposed for tests and for the "check right
   * now" path; overlapping calls are dropped rather than queued.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const job of this.store.list()) {
        if (!job.enabled || job.nextRunAt === undefined) continue;
        if (job.nextRunAt > now) continue;
        if (this.inFlight.has(job.id)) continue;

        const lateBy = now - job.nextRunAt;
        if (job.schedule.kind === 'cron' && lateBy > CRON_CATCHUP_WINDOW_MS) {
          log.info('scheduler', 'job-missed', { jobId: job.id, lateByMs: lateBy });
          this.store.update(job.id, { nextRunAt: this.computeNextRun(job, now) });
          continue;
        }
        await this.fire(job);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Run a job right now, independent of its schedule (`/cron run <id>`). */
  async runNow(jobId: string): Promise<JobRunRecord | undefined> {
    const job = this.store.get(jobId);
    if (!job) return undefined;
    if (this.inFlight.has(jobId)) {
      return { startedAt: this.now(), finishedAt: this.now(), ok: false, error: '该任务正在执行中' };
    }
    return this.fire(job, { manual: true });
  }

  /**
   * Compute a job's next fire time. Returns `undefined` when the job can never
   * fire again (a one-shot whose time has passed, an unsatisfiable cron).
   */
  computeNextRun(job: ScheduledJob, from: number = this.now()): number | undefined {
    if (job.schedule.kind === 'once') {
      return job.schedule.at > from ? job.schedule.at : undefined;
    }
    try {
      return nextCronTime(parseCron(job.schedule.expr), new Date(from))?.getTime();
    } catch (err) {
      // A hand-edited jobs.json can hold an expression that no longer parses.
      // Leaving it unarmed is better than crashing the tick loop.
      if (err instanceof CronParseError) {
        log.warn('scheduler', 'job-bad-cron', { jobId: job.id, expr: job.schedule.expr });
        return undefined;
      }
      throw err;
    }
  }

  /** Arm (or re-arm) one job after it was created, edited, or resumed. */
  armJob(jobId: string): ScheduledJob | undefined {
    const job = this.store.get(jobId);
    if (!job) return undefined;
    const next = job.enabled ? this.computeNextRun(job) : undefined;
    return this.store.update(jobId, { nextRunAt: next });
  }

  private async fire(job: ScheduledJob, opts: { manual?: boolean } = {}): Promise<JobRunRecord> {
    this.inFlight.add(job.id);
    let record: JobRunRecord;
    try {
      record = this.opts.runJob
        ? await this.opts.runJob(job)
        : await runScheduledJob(this.opts, job);
    } catch (err) {
      // runScheduledJob is written not to throw; this is the backstop that
      // keeps one broken job from killing the tick loop.
      log.fail('scheduler', err, { jobId: job.id, step: 'fire' });
      record = {
        startedAt: this.now(),
        finishedAt: this.now(),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.inFlight.delete(job.id);
    }

    // A one-shot has done its whole job; keeping a dead record around would
    // only clutter `/cron list`.
    if (job.schedule.kind === 'once' && !opts.manual) {
      this.store.remove(job.id);
      if (!record.ok) {
        await notifyJobChat(this.opts, job, failureNotice(job, record));
      }
      return record;
    }

    // A manual `/cron run` is how someone tests a job; letting those failures
    // count toward auto-disable would silently disarm a schedule that was only
    // ever being debugged. It records the outcome and leaves the arming alone.
    if (opts.manual) {
      this.store.update(job.id, { lastRun: record });
      if (!record.ok) await notifyJobChat(this.opts, job, failureNotice(job, record));
      return record;
    }

    const failureStreak = record.ok ? 0 : (job.failureStreak ?? 0) + 1;
    const exhausted = failureStreak >= MAX_FAILURE_STREAK;
    const current = this.store.get(job.id) ?? job;
    this.store.update(job.id, {
      lastRun: record,
      failureStreak,
      ...(exhausted
        ? { enabled: false, nextRunAt: undefined }
        : { nextRunAt: this.computeNextRun(current, this.now()) }),
    });

    if (!record.ok) {
      await notifyJobChat(
        this.opts,
        job,
        exhausted
          ? `${failureNotice(job, record)}\n\n已连续失败 ${failureStreak} 次，任务已自动暂停。修好后用 \`/cron resume ${job.id}\` 恢复。`
          : failureNotice(job, record),
      );
    }
    return record;
  }
}

function failureNotice(job: ScheduledJob, record: JobRunRecord): string {
  return `⏰ 定时任务 ${jobTitleMd(job)}（${scheduleLabel(job)}）执行失败：${record.error ?? '未知原因'}`;
}
