import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_FAILOVER_PROMPT, runWithAccountFailover } from '../../../src/agent/claude/account-failover';
import { claudeAccountsPaths, ClaudeAccountPool, type PickedAccount } from '../../../src/agent/claude/accounts';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor, type BackgroundTurn } from '../../../src/runtime/run-executor';

/**
 * A process kept for its background subagents, and the account it runs on.
 *
 * Accounts differ only in `CLAUDE_CODE_OAUTH_TOKEN` (one shared CLI config
 * directory), so a process on another account that resumes the session sees
 * the conversation and every subagent's transcript, and can continue a
 * subagent by its agentId with SendMessage. That is what makes stopping the
 * old process and resuming elsewhere safe: the tests check the bridge does it
 * at the right moments and asks for exactly that.
 */

const NOW = Date.UTC(2026, 9, 24, 15, 0);
const HOUR = 3_600_000;

class LiveRun implements AgentRun {
  readonly runId: string;
  readonly sent: string[] = [];
  stopped = false;
  private readonly queue: AgentEvent[] = [];
  private wake: (() => void) | undefined;
  private exited = false;

  constructor(
    readonly opts: AgentRunOptions,
    readonly account: string,
  ) {
    this.runId = opts.runId;
  }

  emit(...events: AgentEvent[]): void {
    this.queue.push(...events);
    this.notify();
  }

  readonly events: AsyncIterable<AgentEvent> = { [Symbol.asyncIterator]: () => this.iterate() };

  send(prompt: string): boolean {
    if (this.exited) return false;
    this.sent.push(prompt);
    return true;
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    this.stopped = true;
    // Like the adapter: a stopped process ends with an interrupted `done`.
    this.queue.push({ type: 'done', terminationReason: 'interrupted' });
    this.exited = true;
    this.notify();
  }

  async waitForExit(): Promise<boolean> {
    return this.exited;
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

/** The Claude adapter's shape: every run goes through the account failover. */
class AccountAgent implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'accounts fake';
  readonly runs: LiveRun[] = [];
  constructor(private readonly pool: ClaudeAccountPool) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  run(opts: AgentRunOptions): AgentRun {
    return runWithAccountFailover(opts, {
      pool: this.pool,
      spawn: (attemptOpts, account: PickedAccount) => {
        const run = new LiveRun(attemptOpts, account.id);
        this.runs.push(run);
        return run;
      },
      labelOf: async (account) => account.label ?? account.id,
    });
  }
}

const dirs: string[] = [];
const pools: ClaudeAccountPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.flush()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function harness(ids: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'lcb-handover-'));
  dirs.push(dir);
  const paths = claudeAccountsPaths(dir);
  await writeFile(
    paths.configFile,
    JSON.stringify({ accounts: [{ id: 'default', label: 'yu.ou' }, ...ids.map((id) => ({ id, label: `${id}-name` }))] }),
  );
  const pool = new ClaudeAccountPool({ paths, now: () => NOW, readSecret: async (s) => `tok-${s}` });
  await pool.refresh();
  pools.push(pool);
  const agent = new AccountAgent(pool);
  const activeRuns = new ActiveRuns();
  let n = 0;
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 2),
    activeRuns,
    createRunId: () => `run-${++n}`,
    now: () => 1000,
    postDoneExitGraceMs: 50,
  });
  return { pool, agent, activeRuns, executor };
}

function policy(prompt: string): RunPolicyAllow {
  return {
    ok: true,
    prompt,
    requestedCwd: '/repo',
    cwdRealpath: '/repo',
    accessMode: 'full',
    sandbox: 'danger-full-access',
    permissionMode: 'bypassPermissions',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2000,
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

const done: AgentEvent = { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' };
const refusal: AgentEvent = { type: 'rate_limit', blocked: true, limitType: 'five_hour', resetsAt: NOW + HOUR, at: NOW };

/** A first turn that leaves one background subagent running on `default`. */
async function keptWithSubagent(h: Awaited<ReturnType<typeof harness>>, turns: BackgroundTurn[] = []) {
  const first = await h.executor.submit({
    scopeId: 'chat-1',
    policy: policy('build it'),
    onBackgroundTurn: async (turn) => void turns.push(turn),
  });
  const live = h.agent.runs[0]!;
  live.emit({ type: 'system', sessionId: 'sess-1' }, { type: 'background', count: 1 }, { type: 'text', delta: 'started' }, done);
  await collect(first.subscribe());
  await until(() => h.activeRuns.isLingering('chat-1'));
  return live;
}

describe('a kept process whose account can no longer serve the chat', () => {
  it('takes the next message to another account when its own refused, resuming the session there', async () => {
    const h = await harness(['b']);
    const old = await keptWithSubagent(h);
    h.pool.observe('default', refusal);

    const second = await h.executor.submit({ scopeId: 'chat-1', policy: policy('how is it going') });
    await until(() => h.agent.runs.length === 2);
    const next = h.agent.runs[1]!;
    expect(old.stopped).toBe(true);
    expect(old.sent).toEqual([]);
    expect(next.account).toBe('b');
    expect(next.opts.sessionId).toBe('sess-1');
    expect(next.opts.prompt).toContain('how is it going');
    expect(next.opts.prompt).toContain('SendMessage');
    expect(next.opts.prompt).toContain('agentId');

    next.emit({ type: 'system', sessionId: 'sess-1' }, { type: 'text', delta: 'resumed on b' }, done);
    const events = await collect(second.subscribe());
    expect(events).toContainEqual(expect.objectContaining({ type: 'account', label: 'b-name', switchedFrom: 'yu.ou' }));
    expect(events).toContainEqual({ type: 'text', delta: 'resumed on b' });
    // The stopped process's own end never closes the user's turn.
    expect(events.filter((e) => e.type === 'done')).toEqual([done]);
  });

  it('follows the main account after `/accounts switch`, even with its subagents running', async () => {
    const h = await harness(['b']);
    // The chat was moved to b earlier; the kept process runs there.
    h.pool.promote('b');
    await keptWithSubagent(h);
    expect(h.agent.runs[0]!.account).toBe('b');
    h.pool.promote('default');

    const second = await h.executor.submit({ scopeId: 'chat-1', policy: policy('carry on') });
    await until(() => h.agent.runs.length === 2);
    expect(h.agent.runs[0]!.stopped).toBe(true);
    expect(h.agent.runs[1]!.account).toBe('default');
    expect(h.agent.runs[1]!.opts.prompt).toContain('carry on');
    expect(h.agent.runs[1]!.opts.prompt).toContain('SendMessage');
    h.agent.runs[1]!.emit({ type: 'text', delta: 'ok' }, done);
    const events = await collect(second.subscribe());
    expect(events).toContainEqual(expect.objectContaining({ type: 'account', label: 'yu.ou', switchedFrom: 'b-name' }));
  });

  it('keeps handing messages to a process past its line while its subagents run fine', async () => {
    const h = await harness(['b']);
    const old = await keptWithSubagent(h);
    h.pool.observe('default', {
      type: 'rate_limit',
      blocked: false,
      windows: [{ kind: 'five_hour', usedPercent: 99, resetsAt: NOW + HOUR }],
      at: NOW,
    });
    await h.executor.submit({ scopeId: 'chat-1', policy: policy('still there?') });
    expect(old.sent).toEqual(['still there?']);
    expect(old.stopped).toBe(false);
    expect(h.agent.runs).toHaveLength(1);
  });

  it('with a single account, a refused process keeps the message as before', async () => {
    const h = await harness([]);
    const old = await keptWithSubagent(h);
    h.pool.observe('default', refusal);
    await h.executor.submit({ scopeId: 'chat-1', policy: policy('next') });
    expect(old.sent).toEqual(['next']);
    expect(h.agent.runs).toHaveLength(1);
  });

  it('moves a refused background turn to another account and says so in the chat', async () => {
    const h = await harness(['b']);
    const turns: BackgroundTurn[] = [];
    const old = await keptWithSubagent(h, turns);

    // The subagent dies on the quota; the turn the process runs on its own is refused too.
    old.emit(
      { type: 'subagent_rate_limited', taskId: 'a5c3605c87e6b7ee6', message: 'error type rate_limit', at: NOW },
      { type: 'background', count: 0 },
      refusal,
      { type: 'rate_limit', blocked: true, message: "You've hit your session limit · resets 1am", at: NOW },
      done,
    );
    await until(() => h.agent.runs.length === 2 && turns.length === 1);
    const next = h.agent.runs[1]!;
    expect(old.stopped).toBe(true);
    expect(next.account).toBe('b');
    expect(next.opts.sessionId).toBe('sess-1');
    expect(next.opts.prompt).toBe(BACKGROUND_FAILOVER_PROMPT);
    // A card right away, not a silent switch, and no "paused" refusal.
    const notice = turns[0]!;
    expect(notice.kind).toBe('turn');
    const noticeEvents = notice.kind === 'turn' ? notice.events : [];
    expect(noticeEvents).toContainEqual(expect.objectContaining({ type: 'account', label: 'b-name', switchedFrom: 'yu.ou' }));
    expect(noticeEvents.filter((e) => e.type === 'rate_limit' && e.blocked)).toEqual([]);
    // The process is still busy with the resumed work: not let go.
    expect(next.stopped).toBe(false);
    expect(h.activeRuns.isLingering('chat-1')).toBe(true);

    next.emit({ type: 'text', delta: 'subagents resumed, task finished' }, done);
    await until(() => turns.length >= 2);
    const resumed = turns[1]!;
    expect(resumed.kind === 'turn' ? resumed.events : []).toContainEqual({
      type: 'text',
      delta: 'subagents resumed, task finished',
    });
  });
});
