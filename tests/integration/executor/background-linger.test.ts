import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor, type BackgroundTurn, type RunApprovalGates } from '../../../src/runtime/run-executor';
import type { GateContext } from '../../../src/runtime/approvals';
import type { UsageEntry } from '../../../src/runtime/usage-ledger';

/**
 * A process the test drives by hand, shaped like `claude --input-format
 * stream-json`: it stays alive across turns, accepts `send` until its input
 * is closed, and only exits when the test says so (or it is stopped).
 */
class LiveRun implements AgentRun {
  readonly runId: string;
  readonly sent: string[] = [];
  stopped = false;
  inputClosed = false;
  private readonly queue: AgentEvent[] = [];
  private wake: (() => void) | undefined;
  private exited = false;
  private exitWaiters: Array<() => void> = [];

  constructor(readonly opts: AgentRunOptions) {
    this.runId = opts.runId;
  }

  emit(...events: AgentEvent[]): void {
    this.queue.push(...events);
    this.notify();
  }

  exit(): void {
    this.exited = true;
    this.notify();
    for (const resolve of this.exitWaiters.splice(0)) resolve();
  }

  closeInput(): void {
    this.inputClosed = true;
  }

  /** Like a streamed-input CLI asked to finish: input closes, then it exits. */
  endInputCalls = 0;
  endInput?: () => void;

  readonly events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]: () => this.iterate(),
  };

  send(prompt: string): boolean {
    if (this.inputClosed || this.exited) return false;
    this.sent.push(prompt);
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.exit();
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private async *iterate(): AsyncGenerator<AgentEvent> {
    for (;;) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.exited) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

class LiveAgent implements AgentAdapter {
  readonly id: string = 'claude';
  readonly displayName = 'Live fake';
  readonly runs: LiveRun[] = [];
  /** Give runs `endInput`, like the Codex app-server transport. */
  endInput = false;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  run(opts: AgentRunOptions): AgentRun {
    const run = new LiveRun(opts);
    if (this.endInput) {
      run.endInput = () => {
        run.endInputCalls++;
        run.closeInput();
        setTimeout(() => run.exit(), 5);
      };
    }
    this.runs.push(run);
    return run;
  }
}

function harness(
  opts: { maxBackgroundLingerMs?: number; postDoneExitGraceMs?: number; idleKeepAliveMs?: number; noApprovals?: boolean } = {},
) {
  const agent = new LiveAgent();
  agent.endInput = (opts.idleKeepAliveMs ?? 0) > 0;
  const activeRuns = new ActiveRuns();
  const booked: UsageEntry[] = [];
  const gates = { opened: [] as GateContext[], updated: [] as GateContext[], closed: [] as string[] };
  const audited: Array<Record<string, unknown>> = [];
  const approvals: RunApprovalGates = {
    open: (ctx) => {
      gates.opened.push(ctx);
      return { token: `tok-${gates.opened.length}`, approvals: { hookCommand: 'hook', decide: async () => ({ decision: 'allow', reason: '' }) } };
    },
    update: (_token, ctx) => void gates.updated.push(ctx),
    close: (token) => void gates.closed.push(token),
  };
  let n = 0;
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 2),
    activeRuns,
    createRunId: () => `run-${++n}`,
    now: () => 1000,
    postDoneExitGraceMs: 50,
    usage: { record: (entry) => booked.push(entry) },
    audit: { append: (entry) => audited.push(entry) },
    ...(opts.noApprovals ? {} : { approvals }),
    ...opts,
  });
  return { agent, activeRuns, executor, booked, gates, audited };
}

function policy(overrides: Partial<RunPolicyAllow> = {}): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'hello',
    requestedCwd: '/repo',
    cwdRealpath: '/repo',
    accessMode: 'full',
    sandbox: 'danger-full-access',
    permissionMode: 'bypassPermissions',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2000,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function until(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('condition not met in time'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const done = (sessionId = 'sess-1'): AgentEvent => ({
  type: 'done',
  sessionId,
  terminationReason: 'normal',
});

describe('RunExecutor background tasks', () => {
  it('keeps a process that still has background tasks and delivers the turns they trigger', async () => {
    const h = harness();
    const turns: BackgroundTurn[] = [];
    const execution = await h.executor.submit({
      scopeId: 'chat-1',
      policy: policy(),
      onBackgroundTurn: async (turn) => {
        turns.push(turn);
      },
    });
    const live = h.agent.runs[0]!;
    live.emit(
      { type: 'system', sessionId: 'sess-1' },
      { type: 'background', count: 1 },
      { type: 'text', delta: 'started the build' },
      done(),
    );

    const events = await collect(execution.subscribe());
    expect(events.at(-1)).toEqual(done());
    await until(() => h.activeRuns.isLingering('chat-1'));
    expect(live.stopped).toBe(false);
    expect(h.activeRuns.get('chat-1')).toBeUndefined();

    // The build finishes: the agent runs a turn on its own and reports.
    live.emit({ type: 'background', count: 0 }, { type: 'text', delta: 'build ok' }, done());
    live.closeInput();
    await until(() => turns.length === 1);
    expect(turns[0]).toEqual({
      kind: 'turn',
      events: [{ type: 'background', count: 0 }, { type: 'text', delta: 'build ok' }, done()],
    });

    live.exit();
    await until(() => !h.activeRuns.isLingering('chat-1'));
    expect(live.stopped).toBe(false);
  });

  it('closes out a process with no background tasks exactly as before', async () => {
    const h = harness();
    const execution = await h.executor.submit({ scopeId: 'chat-1', policy: policy() });
    const live = h.agent.runs[0]!;
    live.emit({ type: 'text', delta: 'hi' }, done());
    await collect(execution.subscribe());

    // It does not exit on its own within the grace period, so it is stopped.
    await until(() => live.stopped);
    expect(h.activeRuns.isLingering('chat-1')).toBe(false);
  });

  it('hands the next message to the lingering process instead of spawning, without touching its background work', async () => {
    const h = harness();
    const turns: BackgroundTurn[] = [];
    const first = await h.executor.submit({ scopeId: 'chat-1', policy: policy() });
    const live = h.agent.runs[0]!;
    live.emit({ type: 'system', sessionId: 'sess-1' }, { type: 'background', count: 1 }, done());
    await collect(first.subscribe());
    await until(() => h.activeRuns.isLingering('chat-1'));

    const second = await h.executor.submit({
      scopeId: 'chat-1',
      policy: policy({ prompt: 'what is 2+2?' }),
      sessionId: 'sess-1',
      onBackgroundTurn: async (turn) => {
        turns.push(turn);
      },
    });
    expect(h.agent.runs).toHaveLength(1);
    expect(live.sent).toEqual(['what is 2+2?']);
    expect(second.run).toBe(live);
    expect(h.activeRuns.get('chat-1')?.run).toBe(live);
    expect(h.activeRuns.isLingering('chat-1')).toBe(false);

    live.emit({ type: 'text', delta: '4' }, done());
    expect(await collect(second.subscribe())).toEqual([{ type: 'text', delta: '4' }, done()]);
    // Still one background task: back to lingering, and the newest submitter
    // now receives the follow-up.
    await until(() => h.activeRuns.isLingering('chat-1'));
    live.emit({ type: 'background', count: 0 }, { type: 'text', delta: 'build ok' }, done());
    await until(() => turns.length === 1);
    expect(live.stopped).toBe(false);
    live.exit();
  });

  it('spawns a fresh process when the next message needs different run options', async () => {
    const h = harness();
    const first = await h.executor.submit({ scopeId: 'chat-1', policy: policy(), model: 'opus' });
    const live = h.agent.runs[0]!;
    live.emit({ type: 'system', sessionId: 'sess-1' }, { type: 'background', count: 1 }, done());
    await collect(first.subscribe());
    await until(() => h.activeRuns.isLingering('chat-1'));

    await h.executor.submit({ scopeId: 'chat-1', policy: policy(), model: 'sonnet', sessionId: 'sess-1' });
    expect(live.stopped).toBe(true);
    expect(live.sent).toEqual([]);
    expect(h.agent.runs).toHaveLength(2);
  });

  it('spawns a fresh process when the next message resumes a different session', async () => {
    const h = harness();
    const first = await h.executor.submit({ scopeId: 'chat-1', policy: policy() });
    const live = h.agent.runs[0]!;
    live.emit({ type: 'system', sessionId: 'sess-1' }, { type: 'background', count: 1 }, done());
    await collect(first.subscribe());
    await until(() => h.activeRuns.isLingering('chat-1'));

    await h.executor.submit({ scopeId: 'chat-1', policy: policy(), sessionId: 'sess-other' });
    expect(live.stopped).toBe(true);
    expect(h.agent.runs).toHaveLength(2);
  });

  it('waits for a process that stopped taking input to finish instead of killing it', async () => {
    const h = harness();
    const first = await h.executor.submit({ scopeId: 'chat-1', policy: policy() });
    const live = h.agent.runs[0]!;
    live.emit({ type: 'system', sessionId: 'sess-1' }, { type: 'background', count: 1 }, done());
    await collect(first.subscribe());
    await until(() => h.activeRuns.isLingering('chat-1'));
    live.closeInput();
    setTimeout(() => live.exit(), 10);

    await h.executor.submit({ scopeId: 'chat-1', policy: policy(), sessionId: 'sess-1' });
    expect(live.stopped).toBe(false);
    expect(h.agent.runs).toHaveLength(2);
  });

  it('stops lingering background work on interrupt', async () => {
    const h = harness();
    const first = await h.executor.submit({ scopeId: 'chat-1', policy: policy() });
    const live = h.agent.runs[0]!;
    live.emit({ type: 'background', count: 2 }, done());
    await collect(first.subscribe());
    await until(() => h.activeRuns.isLingering('chat-1'));

    expect(h.activeRuns.interruptDetailed('chat-1')).toEqual({ active: false, background: true });
    expect(live.stopped).toBe(true);
    expect(h.activeRuns.isLingering('chat-1')).toBe(false);
  });

  it('stops background work that outlives the linger cap and says so', async () => {
    const h = harness({ maxBackgroundLingerMs: 30 });
    const turns: BackgroundTurn[] = [];
    const first = await h.executor.submit({
      scopeId: 'chat-1',
      policy: policy(),
      onBackgroundTurn: async (turn) => {
        turns.push(turn);
      },
    });
    const live = h.agent.runs[0]!;
    live.emit({ type: 'background', count: 1 }, done());
    await collect(first.subscribe());

    await until(() => live.stopped);
    expect(turns).toEqual([{ kind: 'stopped', reason: 'max-linger', afterMs: 30 }]);
    await until(() => !h.activeRuns.isLingering('chat-1'));
  });

  it('does not linger when the user turn failed', async () => {
    const h = harness();
    const first = await h.executor.submit({ scopeId: 'chat-1', policy: policy() });
    const live = h.agent.runs[0]!;
    live.emit({ type: 'background', count: 1 }, { type: 'error', message: 'boom', terminationReason: 'failed' });
    await collect(first.subscribe());

    await until(() => live.stopped);
    expect(h.activeRuns.isLingering('chat-1')).toBe(false);
  });

  it('books each turn against the person behind it, background turns against the latest submitter', async () => {
    const h = harness();
    const first = await h.executor.submit({
      scopeId: 'chat-1',
      policy: policy(),
      actor: { id: 'ou_a', name: 'A' },
      observability: { profile: 'p', agent: 'claude', source: 'im', stage: 'submit' },
    });
    const live = h.agent.runs[0]!;
    live.emit(
      { type: 'system', sessionId: 'sess-1' },
      { type: 'background', count: 1 },
      { type: 'usage', inputTokens: 100, outputTokens: 10, costUsd: 0.1 },
      done(),
    );
    await collect(first.subscribe());
    await until(() => h.activeRuns.isLingering('chat-1'));

    const second = await h.executor.submit({
      scopeId: 'chat-1',
      policy: policy({ prompt: 'next' }),
      sessionId: 'sess-1',
      actor: { id: 'ou_b' },
      observability: { profile: 'p', agent: 'claude', source: 'im', stage: 'submit' },
    });
    live.emit({ type: 'usage', inputTokens: 50, outputTokens: 5 }, done());
    await collect(second.subscribe());
    await until(() => h.activeRuns.isLingering('chat-1'));
    live.emit({ type: 'background', count: 0 }, { type: 'usage', inputTokens: 7, outputTokens: 1 }, done());
    await until(() => h.booked.length === 3);

    expect(h.booked.map((b) => [b.actorId, b.source, b.scopeId, b.usage.inputTokens])).toEqual([
      ['ou_a', 'im', 'chat-1', 100],
      ['ou_b', 'im', 'chat-1', 50],
      ['ou_b', 'im', 'chat-1', 7],
    ]);
    expect(h.booked[0]?.actorName).toBe('A');
    live.exit();
  });

  it('leaves a process still exiting after its turn alone when the next turn starts', async () => {
    const h = harness({ postDoneExitGraceMs: 1_000 });
    const first = await h.executor.submit({ scopeId: 'chat-1', policy: policy() });
    const live = h.agent.runs[0]!;
    // Like Codex: the turn is over and input is closed, but the process takes
    // a moment to write its session and exit.
    live.closeInput();
    live.emit({ type: 'system', sessionId: 'sess-1' }, done());
    for await (const event of first.subscribe()) if (event.type === 'done') break;
    await until(() => !h.activeRuns.get('chat-1'));

    const started = Date.now();
    await h.executor.submit({ scopeId: 'chat-1', policy: policy(), sessionId: 'sess-1' });
    // The new turn neither waited for the old process nor killed it.
    expect(Date.now() - started).toBeLessThan(500);
    expect(h.agent.runs).toHaveLength(2);
    expect(live.stopped).toBe(false);
    live.exit();
  });

  it('ends subscriptions at the terminal event without waiting for the process to exit', async () => {
    const h = harness({ postDoneExitGraceMs: 2_000 });
    const execution = await h.executor.submit({ scopeId: 'chat-1', policy: policy() });
    const live = h.agent.runs[0]!;
    live.closeInput();
    live.emit({ type: 'text', delta: 'hi' }, done());

    const started = Date.now();
    await collect(execution.subscribe());
    expect(Date.now() - started).toBeLessThan(500);
    expect(h.activeRuns.get('chat-1')).toBeUndefined();
    live.exit();
  });

  it('gives each agent its own post-turn exit grace', () => {
    const codex = new RunExecutor({
      agent: Object.assign(new LiveAgent(), { id: 'codex' }),
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
    });
    const claude = new RunExecutor({ agent: new LiveAgent(), pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns() });
    expect((codex as unknown as { postDoneExitGraceMs: number }).postDoneExitGraceMs).toBe(30_000);
    // Claude needs 1–3s to exit once its input closes; the grace must clear that.
    expect((claude as unknown as { postDoneExitGraceMs: number }).postDoneExitGraceMs).toBe(10_000);
  });

  it('keeps an idle process for the next message where the agent supports it, then closes it quietly', async () => {
    const h = harness({ idleKeepAliveMs: 80 });
    const turns: BackgroundTurn[] = [];
    const first = await h.executor.submit({
      scopeId: 'chat-1',
      policy: policy(),
      onBackgroundTurn: async (turn) => {
        turns.push(turn);
      },
    });
    const live = h.agent.runs[0]!;
    live.emit({ type: 'system', threadId: 'thr-1' }, { type: 'done', threadId: 'thr-1', terminationReason: 'normal' });
    await collect(first.subscribe());
    await until(() => h.activeRuns.hasKeptProcess('chat-1'));
    // Idle is not background work: /status and notices treat it as nothing running.
    expect(h.activeRuns.isLingering('chat-1')).toBe(false);

    const second = await h.executor.submit({ scopeId: 'chat-1', policy: policy({ prompt: 'next' }), threadId: 'thr-1' });
    expect(h.agent.runs).toHaveLength(1);
    expect(live.sent).toEqual(['next']);
    live.emit({ type: 'done', threadId: 'thr-1', terminationReason: 'normal' });
    await collect(second.subscribe());

    // Nobody comes back: input is closed and the process exits on its own.
    await until(() => live.endInputCalls === 1, 2_000);
    await until(() => !h.activeRuns.hasKeptProcess('chat-1'));
    expect(live.stopped).toBe(false);
    expect(turns).toEqual([]);
  });

  it('stops an idle kept process on interrupt without reporting background work', async () => {
    const h = harness({ idleKeepAliveMs: 60_000 });
    const first = await h.executor.submit({ scopeId: 'chat-1', policy: policy() });
    const live = h.agent.runs[0]!;
    live.emit({ type: 'done', threadId: 'thr-1', terminationReason: 'normal' });
    await collect(first.subscribe());
    await until(() => h.activeRuns.hasKeptProcess('chat-1'));

    expect(h.activeRuns.interruptDetailed('chat-1')).toEqual({ active: false, background: false });
    expect(live.stopped).toBe(true);
  });

  it('does not tell the chat about idle processes stopped at shutdown', async () => {
    const h = harness({ idleKeepAliveMs: 60_000 });
    const turns: BackgroundTurn[] = [];
    const first = await h.executor.submit({ scopeId: 'chat-1', policy: policy(), onBackgroundTurn: async (t) => void turns.push(t) });
    const live = h.agent.runs[0]!;
    live.emit({ type: 'done', threadId: 'thr-1', terminationReason: 'normal' });
    await collect(first.subscribe());
    await until(() => h.activeRuns.hasKeptProcess('chat-1'));

    await h.executor.stopLingering();
    expect(live.stopped).toBe(true);
    expect(turns).toEqual([]);
  });

  const gate = (actor: string): GateContext => ({ actor: { id: actor }, source: 'im', scopeId: 'chat-1', chatId: 'chat-1', agent: 'claude' });

  it('opens an approval channel for a gated run and keeps gated and ungated turns apart', async () => {
    const h = harness();
    const first = await h.executor.submit({ scopeId: 'chat-1', policy: policy(), gate: gate('ou_a'), actor: { id: 'ou_a' } });
    const live = h.agent.runs[0]!;
    expect(live.opts.approvals?.hookCommand).toBe('hook');
    live.emit(
      { type: 'system', sessionId: 'sess-1' },
      { type: 'background', count: 1 },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      done(),
    );
    await collect(first.subscribe());
    await until(() => h.activeRuns.isLingering('chat-1'));

    // Another non-admin message reuses the gated process, now on their behalf.
    const second = await h.executor.submit({ scopeId: 'chat-1', policy: policy(), sessionId: 'sess-1', gate: gate('ou_b'), actor: { id: 'ou_b' } });
    expect(h.agent.runs).toHaveLength(1);
    expect(h.gates.updated.map((g) => g.actor.id)).toEqual(['ou_b']);
    live.emit(done());
    await collect(second.subscribe());
    await until(() => h.activeRuns.isLingering('chat-1'));

    // An admin's message never runs in the gated process.
    await h.executor.submit({ scopeId: 'chat-1', policy: policy(), sessionId: 'sess-1', actor: { id: 'ou_admin' } });
    expect(h.agent.runs).toHaveLength(2);
    expect(h.agent.runs[1]!.opts.approvals).toBeUndefined();
    await until(() => h.gates.closed.length === 1);
    expect(h.gates.closed).toEqual(['tok-1']);

    // Only side-effecting steps go to the audit trail, against the person behind them.
    expect(h.audited).toHaveLength(1);
    expect(h.audited[0]).toMatchObject({ kind: 'tool', actorId: 'ou_a', tool: 'Bash', summary: 'npm test', gated: true });
  });

  it('runs a gated turn read-only when there is no approval channel', async () => {
    const h = harness({ noApprovals: true });
    await h.executor.submit({ scopeId: 'chat-1', policy: policy(), gate: gate('ou_a') });
    expect(h.agent.runs[0]!.opts).toMatchObject({ permissionMode: 'plan', sandbox: 'read-only' });
    expect(h.agent.runs[0]!.opts.approvals).toBeUndefined();
  });
});
