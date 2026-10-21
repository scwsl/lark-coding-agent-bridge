/** Persistent shape of one scheduled job. Everything here survives a restart. */
export interface ScheduledJob {
  /** Short, user-facing id — what `/cron remove <id>` takes. */
  id: string;
  /**
   * Human-readable name shown in `/cron list`, `/cron show` and on every
   * delivered result, so nobody has to remember what `d55d1f` was.
   */
  name?: string;
  /** What the agent is asked to do when the job fires. */
  prompt: string;
  schedule: JobSchedule;
  /** Chat the result is delivered to — the chat the job was created in. */
  chatId: string;
  /** Which access rule applies on each fire (DM allowlist vs group allowlist). */
  chatType: 'p2p' | 'group' | 'topic';
  /** Topic id when the job was created inside a topic group. */
  threadId?: string;
  /**
   * Message that created the job. Used as the reply anchor so a topic job's
   * output lands in its topic (Feishu has no "send into thread" without one).
   */
  anchorMessageId?: string;
  /**
   * Who created it. Their access is re-checked on every fire, so revoking a
   * person's access also disarms the jobs they left behind.
   */
  creatorId: string;
  /** Working directory at creation time; falls back to the profile default. */
  cwd?: string;
  /**
   * `fresh` starts a new agent session on every fire (the default — a daily
   * report should not accumulate a year of context), `continue` keeps one
   * long-running conversation across fires.
   */
  session: 'fresh' | 'continue';
  enabled: boolean;
  createdAt: number;
  /** Epoch ms of the next planned fire; absent when disabled or exhausted. */
  nextRunAt?: number;
  lastRun?: JobRunRecord;
  /** Consecutive failures, reset by any successful run. Drives auto-disable. */
  failureStreak?: number;
}

export type JobSchedule =
  | { kind: 'cron'; expr: string }
  /** One-shot: fires once at `at`, then the job is removed. */
  | { kind: 'once'; at: number };

export interface JobRunRecord {
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  /** Terminal state of the agent run (`done` / `error` / `interrupted` / …). */
  terminal?: string;
  /** Why it did not run / did not succeed, for `/cron list`. */
  error?: string;
}

export function isScheduledJob(value: unknown): value is ScheduledJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<ScheduledJob>;
  if (typeof job.id !== 'string' || !job.id) return false;
  if (typeof job.prompt !== 'string' || !job.prompt) return false;
  if (typeof job.chatId !== 'string' || !job.chatId) return false;
  if (typeof job.creatorId !== 'string') return false;
  if (job.chatType !== 'p2p' && job.chatType !== 'group' && job.chatType !== 'topic') return false;
  if (typeof job.enabled !== 'boolean') return false;
  if (typeof job.createdAt !== 'number') return false;
  if (job.session !== 'fresh' && job.session !== 'continue') return false;
  const schedule = job.schedule;
  if (!schedule || typeof schedule !== 'object') return false;
  if (schedule.kind === 'cron') return typeof schedule.expr === 'string' && Boolean(schedule.expr);
  if (schedule.kind === 'once') return typeof schedule.at === 'number';
  return false;
}

/** "储能周报 · d55d1f", or just the id for a job without a name. Plain text. */
export function jobTitle(job: Pick<ScheduledJob, 'id' | 'name'>): string {
  return job.name ? `${job.name} · ${job.id}` : job.id;
}

/** Markdown form of {@link jobTitle}: the name as-is, the id in a code span. */
export function jobTitleMd(job: Pick<ScheduledJob, 'id' | 'name'>): string {
  return job.name ? `「${job.name}」\`${job.id}\`` : `\`${job.id}\``;
}
