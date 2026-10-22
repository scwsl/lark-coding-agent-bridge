import type { AgentRun } from '../agent/types';

/**
 * What an IM run exposes so a follow-up message can be recognized as a
 * supplement to it (and who may send one). Set by the IM flow only; comment,
 * scheduler and card-callback runs have none and never take supplements.
 */
export interface SupplementTarget {
  /** Messages that triggered the run — quoting one of them targets this run. */
  originIds: Set<string>;
  /** The run's own reply (card / markdown) once it exists. */
  replyIds: Set<string>;
  /** Senders of the triggering batch; only they (and the owner) may add to it. */
  initiators: Set<string>;
}

/** Who or what stopped a run — logged on `card final` so the watchdog can tell a wanted stop from a failure. */
export type StopCause = 'user' | 'recalled' | 'shutdown';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  supplement?: SupplementTarget;
  /** When the run was registered — the in-memory fallback for elapsed-time
   * display when no durable RunRecord exists (e.g. comment runs). */
  startedAt: number;
  /** Last time the agent produced an event — drives the card's live clock
   * and `/status`. Starts at `startedAt`. */
  lastActivityAt: number;
  /** What the in-flight tool is doing, while one is running. */
  toolLabel?: string;
  /** The task ledger the agent announced in this run (see task-ledger.ts). */
  ledger?: string;
  /** Called once, when the agent first announces its ledger. */
  onLedger?: (path: string) => void;
  /** Why the run was stopped, when it was: a person, the message that started
   * it being recalled, or the bridge shutting down. */
  stopCause?: StopCause;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();
  private readonly reservations = new Set<string>();
  /**
   * Processes whose user turn is over but which are still running background
   * tasks the agent started (see RunExecutor). Not "active": new messages for
   * the scope are handed to them rather than queued. Interrupts stop them.
   */
  private readonly lingering = new Map<string, { run: AgentRun; kind: 'background' | 'idle' }>();
  private pauseDepth = 0;
  private pauseReason: string | undefined;

  reserve(chatId: string): (() => void) | undefined {
    if (this.handles.has(chatId) || this.reservations.has(chatId)) return undefined;
    this.reservations.add(chatId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations.delete(chatId);
    };
  }

  register(chatId: string, run: AgentRun, startedAt: number = Date.now()): RunHandle {
    if (this.handles.has(chatId)) {
      throw new Error(`run already active for scope: ${chatId}`);
    }
    this.reservations.delete(chatId);
    const handle: RunHandle = { run, interrupted: false, startedAt, lastActivityAt: startedAt };
    this.handles.set(chatId, handle);
    return handle;
  }

  pauseNewRuns(reason: string): () => void {
    this.pauseDepth++;
    this.pauseReason = reason;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pauseDepth = Math.max(0, this.pauseDepth - 1);
      if (this.pauseDepth === 0) this.pauseReason = undefined;
    };
  }

  newRunsPaused(): boolean {
    return this.pauseDepth > 0;
  }

  newRunsPauseReason(): string | undefined {
    return this.pauseReason;
  }

  get(chatId: string): RunHandle | undefined {
    return this.handles.get(chatId);
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  snapshot(): RunHandle[] {
    return [...this.handles.values()];
  }

  /** Scope → handle pairs, for views that need to know *which* scope runs. */
  entries(): Array<{ scope: string; handle: RunHandle }> {
    return [...this.handles.entries()].map(([scope, handle]) => ({ scope, handle }));
  }

  scopes(): string[] {
    return [...this.handles.keys()];
  }

  /**
   * `background`: still running tasks the agent started. `idle`: merely kept
   * up for the conversation's next message (Codex app-server).
   */
  setLingering(chatId: string, run: AgentRun, kind: 'background' | 'idle' = 'background'): void {
    this.lingering.set(chatId, { run, kind });
  }

  clearLingering(chatId: string, run: AgentRun): void {
    if (this.lingering.get(chatId)?.run === run) this.lingering.delete(chatId);
  }

  /** The scope's process is still running background tasks. */
  isLingering(chatId: string): boolean {
    return this.lingering.get(chatId)?.kind === 'background';
  }

  /** The scope has a process kept between turns, idle or busy with background work. */
  hasKeptProcess(chatId: string): boolean {
    return this.lingering.has(chatId);
  }

  /** Any live process kept between turns, including idle sessions. */
  hasAnyKeptProcess(): boolean {
    return this.lingering.size > 0;
  }

  lingeringScopes(): string[] {
    return [...this.lingering.entries()].filter(([, l]) => l.kind === 'background').map(([scope]) => scope);
  }

  /**
   * Interrupt the current run for this chat, if any, and any background
   * tasks its process is still running. Returns true if anything was
   * stopped. Fires stop() fire-and-forget — the old run's generator exits on
   * its own as the subprocess dies.
   */
  interrupt(chatId: string, cause: Exclude<StopCause, 'shutdown'> = 'user'): boolean {
    // An idle kept process is stopped too, but quietly: nothing was running.
    const result = this.interruptDetailed(chatId, cause);
    return result.active || result.background;
  }

  /** {@link interrupt}, reporting whether a user turn and/or background work was stopped. */
  interruptDetailed(
    chatId: string,
    cause: Exclude<StopCause, 'shutdown'> = 'user',
  ): { active: boolean; background: boolean } {
    const lingering = this.lingering.get(chatId);
    if (lingering) {
      this.lingering.delete(chatId);
      void lingering.run.stop().catch(() => {
        /* stop errors are non-fatal */
      });
    }
    const background = lingering?.kind === 'background';
    const h = this.handles.get(chatId);
    if (!h) return { active: false, background };
    this.reservations.delete(chatId);
    h.interrupted = true;
    h.stopCause = cause;
    this.handles.delete(chatId);
    void h.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
    return { active: true, background };
  }

  async stopAll(): Promise<void> {
    const all = [...this.handles.values()];
    const lingering = [...this.lingering.values()].map((l) => l.run);
    this.handles.clear();
    this.reservations.clear();
    this.lingering.clear();
    for (const h of all) {
      h.interrupted = true;
      h.stopCause = 'shutdown';
    }
    await Promise.allSettled([...all.map((h) => h.run.stop()), ...lingering.map((run) => run.stop())]);
  }

  async waitForAll(timeoutMs = 300_000): Promise<void> {
    const all = [...this.handles.values()];
    await Promise.allSettled(all.map((h) => h.run.waitForExit(timeoutMs)));
  }
}
