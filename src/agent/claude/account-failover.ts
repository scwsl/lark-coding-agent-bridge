import { log } from '../../core/logger';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../types';
import type { ClaudeAccountPool, PickedAccount } from './accounts';

type RateLimitEvent = Extract<AgentEvent, { type: 'rate_limit' }>;

export interface AccountFailoverDeps {
  pool: ClaudeAccountPool;
  /** Start one claude process on the given account. */
  spawn(opts: AgentRunOptions, account: PickedAccount): AgentRun;
  /** The account's name for the card (the CLI's own login asks `claude auth status`). */
  labelOf(account: PickedAccount): Promise<string | undefined>;
  /** How long a refused attempt may take to exit before it is stopped. */
  exitWaitMs?: number;
}

/**
 * Run on the account the pool picks, and when that account's quota runs out
 * mid-run, carry the same conversation on with another one.
 *
 * Every quota report goes to the pool. A refusal (`rate_limit` blocked) is held
 * back together with the turn's terminal event: if the attempt ends there and
 * another account has room, the refused process is let go and a new one
 * resumes the session on that account with a note to pick up where the last
 * one stopped. Otherwise the held events go out unchanged and the run ends
 * `paused` exactly as without accounts. A refusal the agent works past (extra
 * usage, a fallback model) is passed through as soon as work resumes.
 */
export function runWithAccountFailover(opts: AgentRunOptions, deps: AccountFailoverDeps): AgentRun {
  let account = deps.pool.pick();
  if (!account) throw new Error('no Claude account to run on');
  let current = deps.spawn(opts, account);
  let stopped = false;
  const tried = new Set<string>();

  async function* events(): AsyncGenerator<AgentEvent> {
    let sessionId = opts.sessionId;
    let switchedFrom: string | undefined;
    for (;;) {
      const attempt = current;
      const on = account!;
      tried.add(on.id);
      // With a single account the card's own Sponsor lookup is enough; don't
      // hold the first event up asking the CLI who is logged in.
      const named = deps.pool.multi || switchedFrom !== undefined;
      const label = named ? ((await deps.labelOf(on).catch(() => undefined)) ?? on.label ?? on.id) : on.id;
      if (named) yield { type: 'account', label, ...(switchedFrom ? { switchedFrom } : {}) };

      let refusal: RateLimitEvent | undefined;
      const held: AgentEvent[] = [];
      // Once the user's turn has ended, later turns are the process's own
      // (background tasks reporting back): a refusal there is not retried —
      // re-sending the user's message would run the task a second time.
      let turnEnded = false;
      for await (const evt of attempt.events) {
        if (evt.type === 'rate_limit') {
          deps.pool.observe(on.id, evt);
          if (evt.blocked && !turnEnded) {
            refusal = mergeRefusal(refusal, evt);
            continue;
          }
        }
        if (evt.type === 'system' && evt.sessionId) sessionId = evt.sessionId;
        if (refusal && (evt.type === 'done' || evt.type === 'error')) {
          if (evt.type === 'done' && evt.sessionId) sessionId = evt.sessionId;
          held.push(evt);
          continue;
        }
        if (refusal && isProgress(evt)) {
          // Working again after all: the refusal did not stop the run.
          yield refusal;
          refusal = undefined;
          yield* held.splice(0);
        }
        if (evt.type === 'done' || evt.type === 'error') turnEnded = true;
        yield evt;
      }

      if (!refusal) {
        yield* held;
        return;
      }
      const next = stopped || wasInterrupted(held) ? undefined : deps.pool.pickReady(tried);
      if (!next) {
        yield soonestReset(refusal, deps.pool);
        yield* held;
        return;
      }
      log.info('agent', 'account-failover', { runId: opts.runId, from: on.id, to: next.id, hasSession: Boolean(sessionId) });
      if (!(await attempt.waitForExit(deps.exitWaitMs ?? 10_000))) await attempt.stop();
      if (stopped) {
        yield refusal;
        yield* held;
        return;
      }
      switchedFrom = label;
      account = next;
      current = deps.spawn(
        { ...opts, ...(sessionId ? { sessionId } : {}), prompt: failoverPrompt(opts.prompt) },
        next,
      );
    }
  }

  return {
    runId: opts.runId,
    get pid() {
      return current.pid;
    },
    events: events(),
    stop: async () => {
      stopped = true;
      await current.stop();
    },
    waitForExit: (timeoutMs) => current.waitForExit(timeoutMs),
    inject: (prompt, preview) => current.inject?.(prompt, preview) ?? false,
  };
}

/**
 * What the next account is asked: the conversation it resumes already holds
 * whatever the last one got done, so continue from there. The original message
 * rides along in case the refusal came before it reached the transcript.
 */
export function failoverPrompt(original: string): string {
  return [
    '[bridge] 上一次处理这条消息时 Claude 账户额度用尽，回答在中途停止了（已经完成的部分在上面的对话里）。',
    'bridge 已切换到另一个账户。请从中断的地方接着完成，不要重复已经做完的步骤，也不要提起这次切换。用户的原消息如下：',
    '',
    original,
  ].join('\n');
}

function mergeRefusal(prev: RateLimitEvent | undefined, next: RateLimitEvent): RateLimitEvent {
  if (!prev) return next;
  return {
    ...prev,
    ...next,
    ...(next.limitType ?? prev.limitType ? { limitType: next.limitType ?? prev.limitType } : {}),
    ...(next.resetsAt ?? prev.resetsAt ? { resetsAt: next.resetsAt ?? prev.resetsAt } : {}),
    ...(next.message ?? prev.message ? { message: next.message ?? prev.message } : {}),
    ...(next.windows ?? prev.windows ? { windows: next.windows ?? prev.windows } : {}),
  };
}

/**
 * Every account is spent: the task waits for whichever frees up first, which
 * need not be the one that refused last (auto-resume reads `resetsAt`).
 */
function soonestReset(refusal: RateLimitEvent, pool: ClaudeAccountPool): RateLimitEvent {
  if (!pool.multi) return refusal;
  const freeAt = pool.nextFreeAt();
  if (freeAt === undefined) return refusal;
  if (refusal.resetsAt !== undefined && refusal.resetsAt <= freeAt) return refusal;
  return { ...refusal, resetsAt: freeAt };
}

function isProgress(evt: AgentEvent): boolean {
  return evt.type === 'text' || evt.type === 'tool_use' || evt.type === 'thinking' || evt.type === 'final_text';
}

function wasInterrupted(held: AgentEvent[]): boolean {
  return held.some((evt) => (evt.type === 'done' || evt.type === 'error') && evt.terminationReason === 'interrupted');
}
