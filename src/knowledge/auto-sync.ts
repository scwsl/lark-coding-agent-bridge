import { log } from '../core/logger';
import { isGitError } from '../git/exec';
import { maskUrlCredentials } from './libraries';
import type { KnowledgeStore } from './store';
import { knowledgeSyncConfigured, syncKnowledge, type SyncOutcome } from './sync';

/**
 * Periodic `/knowledge sync` for a knowledge directory bound to a remote.
 *
 * Several bots bound to one repository only see each other's memories after a
 * sync, so this runs one shortly after start-up and then every
 * `knowledge.syncIntervalMinutes`. A cycle does nothing until the directory is
 * a repository of its own with an `origin`, which is what `/knowledge bind`
 * sets up. It goes through the same queue as the command (`syncKnowledge`), so
 * the two never run git at the same time.
 *
 * Failures are logged every time but reach the owner only once per streak, on
 * the second failed cycle in a row: one network blip must not page anybody.
 */

export interface KnowledgeSyncRecord {
  at: number;
  trigger: 'auto' | 'manual';
  ok: boolean;
  /** One line, credentials masked. */
  error?: string;
  committed?: number;
  pulled?: boolean;
  pushed?: boolean;
}

export interface KnowledgeAutoSyncStatus {
  /** Configured interval; `0` = automatic sync off. */
  intervalMinutes: number;
  /** An automatic round is running right now. */
  syncing: boolean;
  last?: KnowledgeSyncRecord;
  /** Failed automatic cycles in a row. */
  failures: number;
}

export const DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MINUTES = 30;
/** Let the connection settle (and the owner resolve) before the first round. */
const START_DELAY_MS = 15_000;
const STOP_GRACE_MS = 5_000;
/** Failed cycles in a row that reach the owner. */
const NOTIFY_AFTER_FAILURES = 2;

/** Configured interval, defaulting when the profile has no `knowledge` section. */
export function getKnowledgeSyncIntervalMinutes(knowledge: { syncIntervalMinutes?: number } | undefined): number {
  return knowledge?.syncIntervalMinutes ?? DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MINUTES;
}

export class KnowledgeAutoSync {
  private readonly store: KnowledgeStore;
  private readonly intervalMinutes: () => number;
  private readonly owner: () => string | undefined;
  private readonly send: (to: string, markdown: string) => Promise<unknown>;
  private readonly startDelayMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private loop: Promise<unknown> | undefined;
  private stopped = false;
  /** A cycle is running; it schedules the next one itself when it ends. */
  private cycling = false;
  private syncing = false;
  private last: KnowledgeSyncRecord | undefined;
  private failures = 0;
  /** The owner was told about the current streak. */
  private notified = false;

  constructor(opts: {
    store: KnowledgeStore;
    /** Re-read before every cycle. */
    intervalMinutes: () => number;
    /** Bot owner's open_id, late-bound: it resolves after the channel connects. */
    owner: () => string | undefined;
    /** Direct message to an `ou_*` id. */
    send: (to: string, markdown: string) => Promise<unknown>;
    startDelayMs?: number;
    now?: () => number;
  }) {
    this.store = opts.store;
    this.intervalMinutes = opts.intervalMinutes;
    this.owner = opts.owner;
    this.send = opts.send;
    this.startDelayMs = opts.startDelayMs ?? START_DELAY_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * First cycle after the start-up delay, then every `intervalMinutes()`,
   * re-read each time. `0` schedules nothing (only `/knowledge sync`) until
   * {@link reschedule} is called after the interval changed.
   */
  start(): void {
    this.stopped = false;
    if (this.intervalMinutes() <= 0) {
      log.info('knowledge', 'auto-sync-off');
      return;
    }
    this.schedule(this.startDelayMs);
  }

  /**
   * Apply a changed interval now: restart the wait with the current value, or
   * start waiting at all when it was `0` before. A cycle that is running picks
   * the new value up when it ends.
   */
  reschedule(): void {
    if (this.stopped || this.cycling) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const minutes = this.intervalMinutes();
    if (minutes > 0) this.schedule(minutes * 60_000);
  }

  /**
   * One cycle. `undefined` when there is nothing to sync with (not a
   * repository, or no `origin`). Exposed so tests and callers can drive a cycle
   * without waiting for the timer.
   */
  async tick(): Promise<KnowledgeSyncRecord | undefined> {
    if (!(await knowledgeSyncConfigured(this.store))) return undefined;
    this.syncing = true;
    const result = await syncKnowledge(this.store)
      .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        this.syncing = false;
      });
    const record = toRecord(result, 'auto', this.now());
    this.last = record;
    if (record.ok) await this.recovered();
    else await this.failed(record.error ?? '同步失败');
    return record;
  }

  /**
   * Result of a `/knowledge sync` someone ran by hand. The person who ran it
   * already saw the outcome, so a failure does not count towards the streak;
   * a success ends one quietly.
   */
  noteManual(result: SyncOutcome | { error: string }): void {
    const record = toRecord(result, 'manual', this.now());
    this.last = record;
    if (!record.ok) return;
    if (this.failures > 0) log.info('knowledge', 'auto-sync-recovered', { after: this.failures, by: 'manual' });
    this.failures = 0;
    this.notified = false;
  }

  status(): KnowledgeAutoSyncStatus {
    return {
      intervalMinutes: this.intervalMinutes(),
      syncing: this.syncing,
      ...(this.last ? { last: { ...this.last } } : {}),
      failures: this.failures,
    };
  }

  /**
   * Stop the timer. A sync already running gets a few seconds to finish, not
   * its whole timeout: shutdown must not hang on a slow remote. One that is
   * cut off mid-rebase is caught by the next sync's unfinished-operation check.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const loop = this.loop?.catch(() => undefined);
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([
      loop,
      new Promise<void>((resolve) => {
        grace = setTimeout(resolve, STOP_GRACE_MS);
        grace.unref?.();
      }),
    ]);
    if (grace) clearTimeout(grace);
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.loop = this.cycle();
    }, ms);
    this.timer.unref?.();
  }

  private async cycle(): Promise<void> {
    if (this.stopped) return;
    this.cycling = true;
    await this.tick()
      .catch((err: unknown) => log.warn('knowledge', 'auto-sync-crashed', { err: String(err) }))
      .finally(() => {
        this.cycling = false;
      });
    if (this.stopped) return;
    const minutes = this.intervalMinutes();
    if (minutes <= 0) {
      log.info('knowledge', 'auto-sync-off');
      return;
    }
    this.schedule(minutes * 60_000);
  }

  private async failed(error: string): Promise<void> {
    this.failures += 1;
    log.warn('knowledge', 'auto-sync-failed', { failures: this.failures, err: error });
    if (this.failures !== NOTIFY_AFTER_FAILURES || this.notified) return;
    this.notified = true;
    const owner = this.owner();
    if (!owner) {
      log.warn('knowledge', 'auto-sync-owner-unknown', { failures: this.failures });
      return;
    }
    const text = [
      `⚠️ 知识库自动同步连续 ${this.failures} 次失败：${error}`,
      `目录：\`${this.store.dir}\``,
      '处理好后发 `/knowledge sync` 重试；恢复之前不再提醒。',
    ].join('\n');
    await this.send(owner, text).catch((err: unknown) =>
      log.warn('knowledge', 'auto-sync-notify-failed', { err: String(err) }),
    );
  }

  private async recovered(): Promise<void> {
    if (this.failures === 0) return;
    log.info('knowledge', 'auto-sync-recovered', { after: this.failures });
    const told = this.notified;
    this.failures = 0;
    this.notified = false;
    // Only someone who was told about the failure hears that it is over.
    const owner = this.owner();
    if (!told || !owner) return;
    await this.send(owner, '✅ 知识库自动同步已恢复。').catch((err: unknown) =>
      log.warn('knowledge', 'auto-sync-notify-failed', { err: String(err) }),
    );
  }
}

function toRecord(
  result: SyncOutcome | { error: string },
  trigger: KnowledgeSyncRecord['trigger'],
  at: number,
): KnowledgeSyncRecord {
  if (isGitError(result)) return { at, trigger, ok: false, error: summarizeSyncError(result.error) };
  return { at, trigger, ok: true, committed: result.committed, pulled: result.pulled, pushed: result.pushed };
}

/**
 * `拉取失败（已回滚）：<git stderr>` → the stage plus git's first `fatal:` /
 * `error:` line — the lines after it are generic advice ("hint: …") — with
 * credentials in URLs masked.
 */
export function summarizeSyncError(error: string): string {
  const lines = maskUrlCredentials(error)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0] ?? '';
  const cut = first.indexOf('：');
  const stage = cut >= 0 ? first.slice(0, cut + 1) : '';
  const rest = [cut >= 0 ? first.slice(cut + 1).trim() : first, ...lines.slice(1)].filter(Boolean);
  const detail = rest.find((line) => /^(fatal|error):/.test(line)) ?? rest[0] ?? '';
  const summary = `${stage}${detail}` || '同步失败';
  return summary.length > 300 ? `${summary.slice(0, 299)}…` : summary;
}
