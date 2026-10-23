import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions, RunApprovals } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { agentDescriptor, isAgentKind } from '../agent/registry';
import { RunRejected, SpawnFailed } from './errors';
import type { RunGuard } from '../policy/owner-guard';
import { isTerminalEvent, ProcessSession } from './process-session';
import type { UsageEntry } from './usage-ledger';
import { needsApproval, summarizeToolCall, type AuditSink, type GateContext } from './approvals';

/** Per-process approval channels for gated runs (see ApprovalBroker). */
export interface RunApprovalGates {
  open(ctx: GateContext): { token: string; approvals: RunApprovals };
  update(token: string, ctx: GateContext): void;
  close(token: string): void;
}

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
  /**
   * How long a process may keep running background tasks after its last
   * user turn before it is stopped anyway.
   */
  maxBackgroundLingerMs?: number;
  /** Override of the agent's `idleKeepAliveMs` (tests). */
  idleKeepAliveMs?: number;
  /** Where each turn's token / cost report is booked against the person behind it. */
  usage?: { record(entry: UsageEntry): void };
  /** Approval channels for runs a non-admin drives; without them such runs are read-only. */
  approvals?: RunApprovalGates;
  /** Who had the bot run which command / write which file. */
  audit?: AuditSink;
}

/**
 * What a submitter hears about a process after its user turn ended: a turn
 * the agent ran on its own (a background task it started reported back), or
 * that the process was stopped with background work still running.
 */
export type BackgroundTurn =
  | { kind: 'turn'; events: AgentEvent[] }
  /** `account`: the subscription account the stopped process ran on, for the card. */
  | { kind: 'stopped'; reason: 'max-linger'; afterMs: number; account?: string }
  | { kind: 'stopped'; reason: 'shutdown'; account?: string };

export type BackgroundTurnHandler = (turn: BackgroundTurn) => Promise<void>;

export interface SubmitRunInput {
  scopeId: string;
  policy: RunPolicyAllow;
  sessionId?: string;
  threadId?: string;
  model?: string;
  effort?: string;
  images?: readonly string[];
  stopGraceMs?: number;
  guard?: RunGuard;
  /** See AgentRunOptions.compactWindowTokens. */
  compactWindowTokens?: number;
  /** See AgentRunOptions.accountLineCap. */
  accountLineCap?: AgentRunOptions['accountLineCap'];
  nowait?: boolean;
  /** Who this run is for — the person its usage is booked against. */
  actor?: { id: string; name?: string };
  /** The chat the run answers in, for the audit trail. */
  chatId?: string;
  /**
   * Set when a non-admin drives the run: side-effecting steps need an
   * admin's approval. Gated and ungated turns never share a process.
   */
  gate?: GateContext;
  /**
   * Receives background turns once this run's user turn is over. A later
   * submission for the same scope replaces it, so follow-ups go to whoever
   * talked to the process last. Without one they are only logged.
   */
  onBackgroundTurn?: BackgroundTurnHandler;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
}

const DEFAULT_MAX_BACKGROUND_LINGER_MS = 30 * 60 * 1000;

/** A spawned process, tracked per scope while it may still serve turns. */
interface LiveProcess {
  scopeId: string;
  session: ProcessSession;
  /** Run options that must match for a new user turn to reuse the process. */
  compatKey: string;
  dimensions: Record<string, unknown>;
  onBackgroundTurn: BackgroundTurnHandler | undefined;
  /** Latest submitter: background turns are booked against them. */
  actor: { id: string; name?: string } | undefined;
  /** The process's approval channel, when it runs gated. */
  gateToken: string | undefined;
  chatId: string | undefined;
  source: string;
  lingerTimer: NodeJS.Timeout | undefined;
  finishing: boolean;
  /** Settles once a finishing process has exited (or been stopped). */
  finished: Promise<void> | undefined;
}

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;
  private readonly maxBackgroundLingerMs: number;
  private readonly idleKeepAliveMs: number;
  private readonly usage: RunExecutorDeps['usage'];
  private readonly approvals: RunExecutorDeps['approvals'];
  private readonly audit: RunExecutorDeps['audit'];
  private readonly live = new Map<string, LiveProcess>();

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs =
      deps.postDoneExitGraceMs ?? agentDescriptor(isAgentKind(deps.agent.id) ? deps.agent.id : undefined).exitGraceMs;
    this.maxBackgroundLingerMs = deps.maxBackgroundLingerMs ?? DEFAULT_MAX_BACKGROUND_LINGER_MS;
    this.usage = deps.usage;
    this.approvals = deps.approvals;
    this.audit = deps.audit;
    this.idleKeepAliveMs =
      deps.idleKeepAliveMs ?? agentDescriptor(isAgentKind(deps.agent.id) ? deps.agent.id : undefined).idleKeepAliveMs;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const release = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire();
    if (!release) {
      releaseScope();
      throw new RunRejected('pool-full', 'process pool is full');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions = {
      runId,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      model: input.model,
      effort: input.effort,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
      ...(input.guard ? { guard: input.guard } : {}),
      ...(input.compactWindowTokens ? { compactWindowTokens: input.compactWindowTokens } : {}),
      ...(input.accountLineCap ? { accountLineCap: input.accountLineCap } : {}),
    };
    const compatKey = runCompatKey({ ...runOptions, gated: Boolean(input.gate) });
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };

    // A process still running background tasks for this scope takes the
    // prompt as its next turn, so that work is not killed to spawn anew.
    let live: LiveProcess | undefined;
    let turnEvents: AsyncIterable<AgentEvent> | undefined;
    const previous = this.live.get(input.scopeId);
    // A process still exiting on its own after its last turn is left to
    // finish its bookkeeping in the background; the conversation it wrote is
    // already complete, so the new turn does not wait for it.
    if (previous && !previous.finishing) {
      const resumeTarget = input.sessionId ?? input.threadId;
      const compatible =
        previous.compatKey === compatKey &&
        !previous.finishing &&
        !previous.session.hasExited &&
        !previous.session.hasAttachedTurn &&
        (!resumeTarget || resumeTarget === previous.session.conversationId);
      if (compatible && previous.session.run.send) {
        const events = previous.session.attachTurn();
        if (previous.session.run.send(input.policy.prompt)) {
          live = previous;
          turnEvents = events;
          this.endLinger(live);
          live.dimensions = dimensions;
          if (live.gateToken && input.gate) this.approvals?.update(live.gateToken, input.gate);
          log.info('run', 'reuse-process', { ...dimensions, background: live.session.background });
        } else {
          previous.session.detachTurn();
        }
      }
      if (!live) await this.retire(previous, compatible ? 'input-closed' : 'incompatible');
    }

    let run: AgentRun;
    let gateToken: string | undefined;
    if (live && turnEvents) {
      run = live.session.run;
    } else {
      if (input.gate) {
        if (this.approvals) {
          const opened = this.approvals.open(input.gate);
          gateToken = opened.token;
          Object.assign(runOptions, { approvals: opened.approvals });
        } else {
          // Nobody to ask: a gated run without an approval channel stays read-only.
          Object.assign(runOptions, { permissionMode: 'plan', sandbox: 'read-only' });
        }
      }
      try {
        await this.agent.prepareRun?.(runOptions);
      } catch (err) {
        release();
        releaseScope();
        if (gateToken) this.approvals?.close(gateToken);
        if (err instanceof SpawnFailed) throw err;
        throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
      }
      if (this.activeRuns.newRunsPaused()) {
        release();
        releaseScope();
        throw new RunRejected(
          'reconnect-in-progress',
          this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
        );
      }
      try {
        run = this.agent.run(runOptions);
      } catch (err) {
        release();
        releaseScope();
        if (gateToken) this.approvals?.close(gateToken);
        throw new SpawnFailed('agent spawn failed', err);
      }
      let created!: LiveProcess;
      const session = new ProcessSession(run, {
        onBackgroundTurn: (events) => this.deliverBackgroundTurn(created, events),
        onExit: () => this.forget(created),
      });
      created = {
        scopeId: input.scopeId,
        session,
        compatKey,
        dimensions,
        onBackgroundTurn: undefined,
        actor: undefined,
        gateToken,
        chatId: undefined,
        source: 'unknown',
        lingerTimer: undefined,
        finishing: false,
        finished: undefined,
      };
      live = created;
      turnEvents = created.session.attachTurn();
      this.live.set(input.scopeId, created);
    }
    live.onBackgroundTurn = input.onBackgroundTurn;
    live.actor = input.actor;
    live.chatId = input.chatId;
    live.source = dimensions.source;
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    let handle: RunHandle;
    try {
      handle = this.activeRuns.register(input.scopeId, run);
    } catch (err) {
      releaseScope();
      release();
      await run.stop().catch(() => {});
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    const owner = live;
    let cleaned = false;
    const cleanup = async (terminal: AgentEvent | undefined): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      this.activeRuns.unregister(input.scopeId, run);
      release();
      if (handle.interrupted) return;
      if (terminal?.type === 'done' && run.send && !owner.session.hasExited) {
        if (owner.session.background > 0) {
          this.startLinger(owner, 'background');
          return;
        }
        if (this.keepsIdleProcesses(run)) {
          this.startLinger(owner, 'idle');
          return;
        }
      }
      await this.finish(owner);
    };
    let terminal: AgentEvent | undefined;
    const fanout = new EventFanout(
      observeRunEvents(turnEvents, { dimensions, startedAt, now: this.now }, (event) => {
        if (event.type === 'usage') this.bookUsage(owner, event);
        else if (event.type === 'tool_use') this.auditTool(owner, event);
        else terminal = event;
      }),
      async () => {
        await cleanup(terminal);
      },
    );

    return {
      runId,
      scopeId: input.scopeId,
      run,
      handle,
      subscribe: () => fanout.subscribe(),
      stop: async () => {
        handle.interrupted = true;
        await run.stop();
        await run.waitForExit(this.postDoneExitGraceMs);
        await cleanup(undefined);
      },
    };
  }

  /**
   * Tell every scope whose process is only running background tasks that the
   * work is being stopped, then stop it — for shutdown / reconnect, where the
   * process dies with this daemon anyway.
   */
  /**
   * Whether `scopeId` still has an agent process this executor would hand the
   * next message to (lingering for background work or kept idle), rather than
   * one that is only finishing its own exit.
   */
  hasLiveProcess(scopeId: string): boolean {
    const live = this.live.get(scopeId);
    return Boolean(live && !live.finishing && !live.session.hasExited);
  }

  /**
   * Close `scopeId`'s process now if it is only being kept idle for a next
   * turn — for one-shot internal runs (课堂精练) that will never have one.
   */
  async closeIdleScope(scopeId: string): Promise<void> {
    const live = this.live.get(scopeId);
    if (!live || live.finishing || live.session.hasExited || live.session.hasAttachedTurn) return;
    if (live.session.background > 0) return;
    this.endLinger(live);
    await this.closeIdle(live);
  }

  async stopLingering(): Promise<void> {
    const lingering = [...this.live.values()].filter(
      (live) => !live.session.hasExited && !live.session.hasAttachedTurn && !live.finishing,
    );
    await Promise.allSettled(
      lingering.map(async (live) => {
        log.info('run', 'linger-stopped', { ...live.dimensions, reason: 'shutdown', background: live.session.background });
        // Only real background work is worth telling the chat about; an idle
        // kept process just goes away.
        if (live.session.background > 0) {
          await this.notify(live, { kind: 'stopped', reason: 'shutdown', ...accountOf(live) });
        }
        await this.retire(live, 'shutdown');
      }),
    );
  }

  /** Whether this agent's processes wait idle for the next turn (Codex app-server). */
  private keepsIdleProcesses(run: AgentRun): boolean {
    return this.idleKeepAliveMs > 0 && Boolean(run.send && run.endInput);
  }

  /**
   * Keep a process after its user turn: `background` while tasks the agent
   * started run on (capped, stopping them says so), `idle` while it simply
   * waits for the conversation's next message (closed quietly when unused).
   */
  private startLinger(live: LiveProcess, kind: 'background' | 'idle'): void {
    this.endLinger(live);
    this.activeRuns.setLingering(live.scopeId, live.session.run, kind);
    const ms = kind === 'background' ? this.maxBackgroundLingerMs : this.idleKeepAliveMs;
    live.lingerTimer = setTimeout(() => {
      void (kind === 'background' ? this.expireLinger(live) : this.closeIdle(live));
    }, ms);
    live.lingerTimer.unref?.();
    log.info('run', 'linger-start', { ...live.dimensions, kind, background: live.session.background, lingerMs: ms });
  }

  /** An idle kept process nobody came back to: let it exit on its own. */
  private async closeIdle(live: LiveProcess): Promise<void> {
    live.lingerTimer = undefined;
    if (live.session.hasExited || live.session.hasAttachedTurn) return;
    log.info('run', 'idle-close', { ...live.dimensions, idleMs: this.idleKeepAliveMs });
    live.session.run.endInput?.();
    await this.finish(live);
  }

  private endLinger(live: LiveProcess): void {
    if (live.lingerTimer) clearTimeout(live.lingerTimer);
    live.lingerTimer = undefined;
    this.activeRuns.clearLingering(live.scopeId, live.session.run);
  }

  private async expireLinger(live: LiveProcess): Promise<void> {
    live.lingerTimer = undefined;
    if (live.session.hasExited || live.session.hasAttachedTurn) return;
    log.warn('run', 'linger-timeout', {
      ...live.dimensions,
      background: live.session.background,
      maxLingerMs: this.maxBackgroundLingerMs,
    });
    await this.notify(live, {
      kind: 'stopped',
      reason: 'max-linger',
      afterMs: this.maxBackgroundLingerMs,
      ...accountOf(live),
    });
    await this.retire(live, 'max-linger');
  }

  private bookUsage(live: LiveProcess, usage: Extract<AgentEvent, { type: 'usage' }>): void {
    if (!this.usage || !live.actor) return;
    try {
      this.usage.record({
        actorId: live.actor.id,
        ...(live.actor.name ? { actorName: live.actor.name } : {}),
        source: live.source,
        scopeId: live.scopeId,
        usage,
      });
    } catch (err) {
      log.warn('run', 'usage-record-failed', { ...live.dimensions, err: String(err) });
    }
  }

  /** Record a side-effecting step (command, file write, MCP call) against the person behind it. */
  private auditTool(live: LiveProcess, event: Extract<AgentEvent, { type: 'tool_use' }>): void {
    if (!this.audit || !live.actor || !needsApproval(event.name)) return;
    const input = event.input && typeof event.input === 'object' ? (event.input as Record<string, unknown>) : {};
    const summary =
      event.name === 'file_change' && Array.isArray(input.paths)
        ? `修改文件：${(input.paths as unknown[]).join(', ')}`
        : summarizeToolCall(event.name, input);
    this.audit.append({
      kind: 'tool',
      actorId: live.actor.id,
      ...(live.actor.name ? { actorName: live.actor.name } : {}),
      source: live.source,
      scopeId: live.scopeId,
      ...(live.chatId ? { chatId: live.chatId } : {}),
      agent: String(live.dimensions.agent ?? ''),
      tool: event.name,
      summary,
      gated: Boolean(live.gateToken),
    });
  }

  private deliverBackgroundTurn(live: LiveProcess, events: AgentEvent[]): void {
    for (const event of events) {
      if (event.type === 'usage') this.bookUsage(live, event);
      if (event.type === 'tool_use') this.auditTool(live, event);
    }
    log.info('run', 'background-turn', {
      ...live.dimensions,
      events: events.length,
      background: live.session.background,
    });
    void this.notify(live, { kind: 'turn', events }).then(async () => {
      if (live.session.background > 0 || live.session.hasAttachedTurn || live.session.hasExited) return;
      // No background work left: wait idle for the next message where the
      // agent supports it, otherwise make sure the process goes away (the
      // Claude adapter has already closed its input).
      if (this.keepsIdleProcesses(live.session.run)) this.startLinger(live, 'idle');
      else await this.finish(live);
    });
  }

  private async notify(live: LiveProcess, turn: BackgroundTurn): Promise<void> {
    if (!live.onBackgroundTurn) return;
    try {
      await live.onBackgroundTurn(turn);
    } catch (err) {
      log.warn('run', 'background-turn-delivery-failed', {
        ...live.dimensions,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Let a process with nothing left to do exit; stop it if it won't. */
  private finish(live: LiveProcess): Promise<void> {
    if (!live.finished) {
      live.finishing = true;
      live.finished = this.awaitExit(live);
    }
    return live.finished;
  }

  private async awaitExit(live: LiveProcess): Promise<void> {
    this.endLinger(live);
    const exited = await live.session.run.waitForExit(this.postDoneExitGraceMs);
    if (!exited) {
      log.warn('run', 'post-done-exit-timeout', {
        ...live.dimensions,
        graceMs: this.postDoneExitGraceMs,
        background: live.session.background,
      });
      await live.session.run.stop().catch((err) => {
        log.warn('run', 'post-done-stop-failed', {
          ...live.dimensions,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
    this.forget(live);
  }

  /** Stop a process that can no longer serve this scope's turns. */
  private async retire(
    live: LiveProcess,
    reason: 'incompatible' | 'input-closed' | 'max-linger' | 'shutdown',
  ): Promise<void> {
    log.info('run', 'retire-process', { ...live.dimensions, reason, background: live.session.background });
    if (reason === 'input-closed') {
      await this.finish(live);
      return;
    }
    if (live.finished) {
      await live.finished;
      return;
    }
    live.finishing = true;
    live.finished = (async () => {
      this.endLinger(live);
      await live.session.run.stop().catch(() => {});
      this.forget(live);
    })();
    await live.finished;
  }

  private forget(live: LiveProcess): void {
    this.endLinger(live);
    if (live.gateToken) {
      this.approvals?.close(live.gateToken);
      live.gateToken = undefined;
    }
    if (this.live.get(live.scopeId) === live) this.live.delete(live.scopeId);
  }
}

/** The account a stopped process ran on, for its notice's card. */
function accountOf(live: LiveProcess): { account?: string } {
  return live.session.account ? { account: live.session.account } : {};
}

/** Everything a running process was started with that a later turn must share. */
function runCompatKey(opts: {
  gated?: boolean;
  cwd?: string;
  model?: string;
  effort?: string;
  sandbox?: string;
  permissionMode?: string;
  images?: readonly string[];
  compactWindowTokens?: number;
  accountLineCap?: AgentRunOptions['accountLineCap'];
}): string {
  return JSON.stringify([
    opts.gated ?? false,
    opts.cwd ?? null,
    opts.model ?? null,
    opts.effort ?? null,
    opts.sandbox ?? null,
    opts.permissionMode ?? null,
    // Image arguments ride on argv; a turn that carries them needs a new process.
    opts.images?.length ? opts.images : null,
    // The compaction window rides on the process environment.
    opts.compactWindowTokens ?? null,
    // The account was picked under the cap: an uncapped turn needs its own pick.
    opts.accountLineCap ?? null,
  ]);
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  opts: {
    dimensions: Record<string, unknown>;
    startedAt: number;
    now: () => number;
  },
  onEvent: (event: AgentEvent) => void,
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      for await (const event of events) {
        if (isTerminalEvent(event) || event.type === 'usage' || event.type === 'tool_use') onEvent(event);
        if (event.type === 'done') {
          log.info('run', 'completed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
          });
          yield event;
          return;
        }
        if (event.type === 'error') {
          log.warn('run', 'failed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
            error: event.message,
          });
          yield event;
          return;
        }
        yield event;
      }
    },
  };
}

class EventFanout {
  private readonly source: AsyncIterable<AgentEvent>;
  private readonly onDone: () => Promise<void>;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private started = false;
  private done = false;
  private error: unknown;

  constructor(source: AsyncIterable<AgentEvent>, onDone: () => Promise<void>) {
    this.source = source;
    this.onDone = onDone;
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            if (this.done) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              const wake = (): void => {
                this.waiters.delete(wake);
                resolve();
              };
              this.waiters.add(wake);
            });
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.source) {
        this.buffer.push(event);
        this.wakeAll();
        if (isTerminalEvent(event)) break;
      }
    } catch (err) {
      this.error = err;
    } finally {
      // Start cleanup first (it frees the scope and pool slot synchronously),
      // then end the subscriptions: consumers must not wait for the process
      // to finish exiting, which can take a while (see exitGraceMs).
      const cleanup = this.onDone();
      this.done = true;
      this.wakeAll();
      await cleanup;
    }
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}
