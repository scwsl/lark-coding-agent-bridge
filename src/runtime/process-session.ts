import type { AgentEvent, AgentRun } from '../agent/types';

/**
 * One agent process, read by exactly one pump, with its events routed per
 * turn: to the user turn the bridge attached (a submitted run), or — when no
 * user turn is attached — to a buffer for the turns the agent runs on its own
 * after a background task it started reports back.
 *
 * Turns in one process never overlap, so "whoever is attached when an event
 * arrives owns it" is enough. A user message handed over while a background
 * turn is mid-flight is merged into that turn by the CLI; the attached user
 * turn then owns the rest of it, including the answer.
 */
export class ProcessSession {
  readonly run: AgentRun;
  /** Background tasks the agent last reported running. */
  background = 0;
  /** Session / thread id the process reported — what a reused turn resumes. */
  conversationId: string | undefined;
  private sink: TurnSink | undefined;
  private backgroundEvents: AgentEvent[] = [];
  private started = false;
  private exited = false;
  private readonly hooks: ProcessSessionHooks;

  constructor(run: AgentRun, hooks: ProcessSessionHooks) {
    this.run = run;
    this.hooks = hooks;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  get hasAttachedTurn(): boolean {
    return this.sink !== undefined;
  }

  /**
   * Route the next events to a new user turn. The returned iterable ends
   * after that turn's terminal event (or when the process's output ends).
   * Attach before handing the process its input so no event is missed.
   */
  attachTurn(): AsyncIterable<AgentEvent> {
    if (this.sink) throw new Error('a user turn is already attached to this process');
    const sink = new TurnSink();
    if (this.exited) sink.end();
    else this.sink = sink;
    this.start();
    return sink;
  }

  /** Undo {@link attachTurn} when the process refused the input. */
  detachTurn(): void {
    const sink = this.sink;
    this.sink = undefined;
    sink?.end();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.run.events) {
        if (event.type === 'background') this.background = event.count;
        if (event.type === 'system' || event.type === 'done') {
          this.conversationId = event.sessionId ?? event.threadId ?? this.conversationId;
        }
        const sink = this.sink;
        if (sink) {
          sink.push(event);
          if (isTerminalEvent(event)) {
            this.sink = undefined;
            sink.end();
          }
          continue;
        }
        this.backgroundEvents.push(event);
        if (isTerminalEvent(event)) this.flushBackgroundTurn();
      }
    } catch (err) {
      this.sink?.fail(err);
      this.sink = undefined;
    } finally {
      this.exited = true;
      this.sink?.end();
      this.sink = undefined;
      // A background turn cut off by the process ending still gets delivered.
      if (this.backgroundEvents.some((e) => e.type !== 'background')) this.flushBackgroundTurn();
      this.backgroundEvents = [];
      this.hooks.onExit();
    }
  }

  private flushBackgroundTurn(): void {
    const events = this.backgroundEvents;
    this.backgroundEvents = [];
    this.hooks.onBackgroundTurn(events);
  }
}

export interface ProcessSessionHooks {
  /** A turn the agent ran on its own finished (or was cut off by exit). */
  onBackgroundTurn(events: AgentEvent[]): void;
  /** The process's output ended; nothing more will be routed. */
  onExit(): void;
}

export function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}

/** Single-consumer async queue backing one attached turn. */
class TurnSink implements AsyncIterable<AgentEvent> {
  private readonly queue: AgentEvent[] = [];
  private ended = false;
  private error: unknown;
  private wake: (() => void) | undefined;

  push(event: AgentEvent): void {
    this.queue.push(event);
    this.notify();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  fail(err: unknown): void {
    this.error = err;
    this.end();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (;;) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.error) throw this.error;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}
