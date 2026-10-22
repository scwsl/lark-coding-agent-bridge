import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';

interface PendingEntry {
  messages: NormalizedMessage[];
  timer?: NodeJS.Timeout;
}

export type FlushHandler = (scope: string, batch: NormalizedMessage[]) => void;
/** Called with a scope's full queued list whenever it changes ([] once it is gone). */
export type ChangeHandler = (scope: string, messages: readonly NormalizedMessage[]) => void;

/**
 * Per-scope debounce queue. `scope` is the session scope string (typically
 * `chatId` for p2p / regular group, `chatId:threadId` for topic groups).
 * Accumulates messages within the same scope inside a quiet window, then
 * flushes as a single batch.
 *
 * `block(scope)` pauses the debounce timer while an agent run is active on
 * that scope — pushed messages still accumulate but no flush fires until
 * `unblock(scope)`, which arms a fresh quiet window.
 *
 * Commands should bypass this queue — they're cheap and should be responsive.
 */
export class PendingQueue {
  private readonly map = new Map<string, PendingEntry>();
  private readonly blocked = new Set<string>();
  private readonly delayMs: number;
  private readonly onFlush: FlushHandler;
  private readonly onChange: ChangeHandler | undefined;

  constructor(delayMs: number, onFlush: FlushHandler, onChange?: ChangeHandler) {
    this.delayMs = delayMs;
    this.onFlush = onFlush;
    this.onChange = onChange;
  }

  push(scope: string, msg: NormalizedMessage): number {
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.messages.push(msg);
      existing.timer = this.blocked.has(scope) ? undefined : this.armTimer(scope);
      this.onChange?.(scope, existing.messages);
      return existing.messages.length;
    }
    const messages = [msg];
    this.map.set(scope, {
      messages,
      timer: this.blocked.has(scope) ? undefined : this.armTimer(scope),
    });
    this.onChange?.(scope, messages);
    return 1;
  }

  /** Messages currently queued for a scope (0 when nothing is queued). */
  depth(scope: string): number {
    return this.map.get(scope)?.messages.length ?? 0;
  }

  /** Messages queued across every scope. */
  totalDepth(): number {
    let total = 0;
    for (const entry of this.map.values()) total += entry.messages.length;
    return total;
  }

  cancel(scope: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    this.onChange?.(scope, []);
    return entry.messages;
  }

  /**
   * Take one message out of whichever scope holds it (a recalled message must
   * not run). The scope's remaining messages keep their place and timer; an
   * emptied scope is dropped. Returns the scope it was in, if any.
   */
  remove(messageId: string): string | undefined {
    for (const [scope, entry] of this.map.entries()) {
      const index = entry.messages.findIndex((m) => m.messageId === messageId);
      if (index < 0) continue;
      entry.messages.splice(index, 1);
      if (entry.messages.length === 0) {
        if (entry.timer) clearTimeout(entry.timer);
        this.map.delete(scope);
        this.onChange?.(scope, []);
      } else {
        this.onChange?.(scope, entry.messages);
      }
      return scope;
    }
    return undefined;
  }

  cancelAll(): void {
    for (const [scope, entry] of this.map.entries()) {
      if (entry.timer) clearTimeout(entry.timer);
      this.onChange?.(scope, []);
    }
    this.map.clear();
    this.blocked.clear();
  }

  /**
   * Stop all timers and forget the queue in memory *without* reporting the
   * messages as gone, so a durable copy (see PendingStore) survives for the
   * next process to pick up. Used on shutdown / reconnect.
   */
  stop(): void {
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.map.clear();
    this.blocked.clear();
  }

  /** Pause the debounce timer; pushed messages keep accumulating. */
  block(scope: string): void {
    if (this.blocked.has(scope)) return;
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    log.info('queue', 'blocked', { scope, queued: entry?.messages.length ?? 0 });
  }

  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope: string): void {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    log.info('queue', 'unblocked', { scope, queued: entry?.messages.length ?? 0 });
    if (!entry || entry.messages.length === 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = this.armTimer(scope);
  }

  private armTimer(scope: string): NodeJS.Timeout {
    return setTimeout(() => this.flush(scope), this.delayMs);
  }

  private flush(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry) return;
    this.map.delete(scope);
    this.onChange?.(scope, []);
    try {
      this.onFlush(scope, entry.messages);
    } catch (err) {
      log.fail('queue', err, { scope, batchSize: entry.messages.length });
    }
  }
}
