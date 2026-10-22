import { log } from '../../core/logger';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { WINDOW_LABELS, type ClaudeAccountPool, type PickedAccount } from './accounts';

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
 * Run on the account the pool picks, and move the same conversation to
 * another account when this one cannot go on.
 *
 * Every quota report goes to the pool. Two ways off an account:
 *
 * - **Refused** (`rate_limit` blocked): the refusal is held back together with
 *   the turn's terminal event. If the attempt ends there and another account
 *   has room, the refused process is let go and a new one resumes the session
 *   on that account, with a note to pick up where the last one stopped.
 *   Otherwise the held events go out unchanged and the run ends `paused`.
 * - **Past its line**: Claude reports the quota once per message, after the
 *   first request. When that report puts the account at or past a switch
 *   line and another account is still below its lines, the run moves — to
 *   the one with the best switch score — at the next point where no tool
 *   call, subagent or background task is in flight; stopping there loses
 *   nothing. With every account past a line it stays put: accounts are then
 *   used up one after another, and only a refusal moves it.
 *
 * The account a run ends up on becomes the main one (see the pool's rounds).
 *
 * A refusal the agent works past (extra usage, a fallback model) is passed
 * through as soon as work resumes. Nothing moves once the user's turn has
 * ended or the run was stopped.
 */
export function runWithAccountFailover(opts: AgentRunOptions, deps: AccountFailoverDeps): AgentRun {
  let account = deps.pool.pick();
  if (!account) throw new Error('no Claude account to run on');
  deps.pool.promote(account.id);
  let current = deps.spawn(opts, account);
  let stopped = false;
  const tried = new Set<string>();

  async function* events(): AsyncGenerator<AgentEvent> {
    let sessionId = opts.sessionId;
    let switchedFrom: string | undefined;
    let reason: string | undefined;
    for (;;) {
      const attempt = current;
      const on = account!;
      tried.add(on.id);
      // With a single account the card's own Sponsor lookup is enough; don't
      // hold the first event up asking the CLI who is logged in.
      const named = deps.pool.multi || switchedFrom !== undefined;
      const label = named ? ((await deps.labelOf(on).catch(() => undefined)) ?? on.label ?? on.id) : on.id;
      if (named) {
        yield {
          type: 'account',
          label,
          ...(switchedFrom ? { switchedFrom } : {}),
          ...(switchedFrom && reason ? { reason } : {}),
        };
      }

      let refusal: RateLimitEvent | undefined;
      const held: AgentEvent[] = [];
      // Once the user's turn has ended, later turns are the process's own
      // (background tasks reporting back): a refusal there is not retried —
      // re-sending the user's message would run the task a second time.
      let turnEnded = false;
      // Past the switch line: leave at the next quiet point.
      let pastLine = false;
      const inFlight = new Set<string>();
      let background = 0;
      let leave: PickedAccount | undefined;

      for await (const evt of attempt.events) {
        if (evt.type === 'rate_limit') {
          deps.pool.observe(on.id, evt);
          if (evt.blocked && !turnEnded) {
            refusal = mergeRefusal(refusal, evt);
            continue;
          }
          if (!evt.blocked && !turnEnded && !stopped && !deps.pool.hasRoom(on.id)) pastLine = true;
        }
        if (evt.type === 'system' && evt.sessionId) sessionId = evt.sessionId;
        if (evt.type === 'background') background = evt.count;
        if (evt.type === 'tool_use') inFlight.add(evt.id);
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
        if (evt.type === 'tool_result') {
          inFlight.delete(evt.id);
          if (pastLine && !refusal && !stopped && !turnEnded && inFlight.size === 0 && background === 0) {
            leave = deps.pool.pickReady(new Set([...tried, on.id]));
            if (leave) break;
            // Every other account is past a line too: use this one up.
            pastLine = false;
          }
        }
      }

      if (leave) {
        const line = deps.pool.pastLine(on.id);
        log.info('agent', 'account-leave', { runId: opts.runId, from: on.id, to: leave.id, window: line?.kind ?? null });
        await attempt.stop();
        if (stopped) {
          yield { type: 'done', ...(sessionId ? { sessionId } : {}), terminationReason: 'interrupted' };
          return;
        }
        switchedFrom = label;
        reason = line ? `${WINDOW_LABELS[line.kind]}用量到了 ${line.line}% 的切换线` : '到了切换线';
        account = leave;
        deps.pool.promote(leave.id);
        current = deps.spawn({ ...opts, ...(sessionId ? { sessionId } : {}), prompt: SWITCH_LINE_PROMPT }, leave);
        continue;
      }

      if (!refusal) {
        yield* held;
        return;
      }
      const next = stopped || wasInterrupted(held) ? undefined : deps.pool.pickRunnable(tried);
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
      reason = undefined;
      account = next;
      deps.pool.promote(next.id);
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
 * What the next account is asked after a refusal: the conversation it resumes
 * already holds whatever the last one got done, so continue from there. The
 * original message rides along in case the refusal came before it reached the
 * transcript.
 */
export function failoverPrompt(original: string): string {
  return [
    '[bridge] 上一次处理这条消息时 Claude 账户额度用尽，回答在中途停止了（已经完成的部分在上面的对话里）。',
    'bridge 已切换到另一个账户。请从中断的地方接着完成，不要重复已经做完的步骤，也不要提起这次切换。用户的原消息如下：',
    '',
    original,
  ].join('\n');
}

/** The move happened between steps: everything so far, the message included, is in the transcript. */
export const SWITCH_LINE_PROMPT = [
  '[bridge] 原账户用到了切换线，bridge 在两个步骤之间把这次任务换到了另一个账户（已经完成的步骤都在上面的对话里）。',
  '请接着完成用户最后一条消息的请求，不要重复已经做完的步骤，也不要提起这次切换。',
].join('\n');

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
  const freeAt = pool.nextRunnableAt();
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
