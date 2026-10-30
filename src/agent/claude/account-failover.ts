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
 * Every quota report goes to the pool. Ways off an account:
 *
 * - **Refused** (`rate_limit` blocked): the refusal is held back together with
 *   the turn's terminal event. If the attempt ends there and another account
 *   has room, the refused process is let go and a new one resumes the session
 *   on that account, with a note to pick up where the last one stopped.
 *   Otherwise the held events go out unchanged and the run ends `paused`.
 *   A process kept on for background tasks never ends there: the move (or
 *   the pause) is decided at the refused turn's end, and the tasks — on the
 *   spent account too — are brought back on the new one.
 * - **Past its line**: Claude reports the quota once per message, after the
 *   first request. When that report puts the account at or past a switch
 *   line and another account is still below its lines, the run moves — to
 *   the one with the best switch score — at the next point where no tool
 *   call, subagent or background task is in flight; stopping there loses
 *   nothing. With every account past a line it stays put: accounts are then
 *   used up one after another, and only a refusal moves it.
 * - **Refused in the process's own turn** (after the user's turn ended, a
 *   background task reported back and the account refused the follow-up, or
 *   a subagent was cut off by the quota): the background tasks on this
 *   account are lost anyway. With another account runnable, the process is
 *   stopped, a short turn of its own says so in the chat (a card, not a
 *   silent switch), and a new process resumes the session there, asked to
 *   bring the interrupted subagents back (SendMessage) and finish the task —
 *   never re-sending the user's message, which would run the task twice.
 * - **The next user message** ({@link AgentRun.send}) for a process kept for
 *   its background tasks, when its account is refused, is no longer the main
 *   one (`/accounts switch`, or another run promoted its account), or is past
 *   its line with nothing running — and another account can take over:
 *   instead of handing the message to that process, it is stopped and the
 *   message goes to a new one resuming the session on that account, asked
 *   to bring the interrupted subagents back first. Past its line with
 *   background work still running (and still the main account), the process
 *   keeps the message: tasks doing fine are not killed for a line.
 *
 * Moving a session with subagents works because accounts differ only in
 * `CLAUDE_CODE_OAUTH_TOKEN`: every process shares the CLI's config directory,
 * so the session transcript and each subagent's transcript are visible on
 * any account, and the resumed process can continue a subagent by its
 * agentId with SendMessage (checked on 2.1.309, 2026-10-24).
 *
 * The account a run ends up on becomes the main one (see the pool's rounds).
 *
 * A run with `accountLineCap` (课堂精练) sees every line lowered to the cap:
 * it starts on, and moves only to, an account below it; with none left it
 * stays where it is until its turn ends and lets its caller stop there. It
 * never changes which account is the main one.
 *
 * A refusal the agent works past (extra usage, a fallback model) is passed
 * through as soon as work resumes. Nothing moves once the run was stopped.
 */
export function runWithAccountFailover(opts: AgentRunOptions, deps: AccountFailoverDeps): AgentRun {
  const cap = opts.accountLineCap;
  let account = deps.pool.pick(undefined, cap);
  if (!account) throw new Error('no Claude account to run on');
  // A capped run (课堂精练) borrows an account; chats keep their main one.
  const promote = (id: string): void => {
    if (!cap) deps.pool.promote(id);
  };
  promote(account.id);
  let current = deps.spawn(opts, account);
  let stopped = false;
  let tried = new Set<string>();
  // The latest user message: what a refused user turn is retried with.
  let lastPrompt = opts.prompt;
  // Once the user's turn has ended, later turns are the process's own
  // (background tasks reporting back) — until `send` hands it the next one.
  let turnEnded = false;
  // Background tasks the current process last reported.
  let background = 0;
  // A subagent was cut off by the quota: the next account is asked to bring it back.
  let subagentsCut = false;
  // The events loop is still reading the current process.
  let reading = false;
  // The next user message is going to a new process on another account.
  let handover: { prompt: string; to: PickedAccount; reason: string } | undefined;

  /** Another account to move to, never `from`; a capped run only to one below its cap. */
  const elsewhere = (from: string): PickedAccount | undefined => {
    const exclude = new Set([from]);
    return cap ? deps.pool.pickReady(exclude, cap) : deps.pool.pickRunnable(exclude);
  };

  /** Where a refused user turn is retried; a capped run only on an account below its cap. */
  const refusalTarget = (): PickedAccount | undefined =>
    cap ? deps.pool.pickReady(tried, cap) : deps.pool.pickRunnable(tried);

  /** Where the next user message should go instead of the current process, if anywhere. */
  const handoverTarget = (): { to: PickedAccount; reason: string } | undefined => {
    const on = account!;
    if (deps.pool.isRefused(on.id)) {
      const to = elsewhere(on.id);
      return to ? { to, reason: '额度用尽' } : undefined;
    }
    // The owner paused the account while the process was kept.
    if (deps.pool.isPaused(on.id)) {
      const to = elsewhere(on.id);
      return to ? { to, reason: '账户已暂停' } : undefined;
    }
    // The main account changed while the process was kept (`/accounts
    // switch`, or another run moved on and promoted its account): follow it.
    // A capped run (课堂精练) borrows its account and does not follow.
    if (!cap) {
      const main = deps.pool.accounts()[0];
      if (main && main.id !== on.id) {
        const to = deps.pool.pickRunnable();
        if (to && to.id !== on.id) return { to, reason: '已不是主账户' };
      }
    }
    // Past a line only: background tasks that are running fine stay put.
    if (background > 0 || deps.pool.hasRoom(on.id, cap)) return undefined;
    const to = deps.pool.pickReady(new Set([on.id]), cap);
    return to ? { to, reason: lineReason(deps.pool.pastLine(on.id, undefined, cap)) } : undefined;
  };

  async function* events(): AsyncGenerator<AgentEvent> {
    reading = true;
    try {
      yield* attempts();
    } finally {
      reading = false;
    }
  }

  async function* attempts(): AsyncGenerator<AgentEvent> {
    let sessionId = opts.sessionId;
    let switchedFrom: string | undefined;
    let reason: string | undefined;
    // The account event already went out (with the turn that announced the move).
    let announced = false;
    // The attempt starts with a turn of the process's own (a background failover).
    let ownTurn = false;
    for (;;) {
      const attempt = current;
      const on = account!;
      tried.add(on.id);
      // With a single account the card's own Sponsor lookup is enough; don't
      // hold the first event up asking the CLI who is logged in.
      const named = deps.pool.multi || switchedFrom !== undefined;
      const label = named ? ((await deps.labelOf(on).catch(() => undefined)) ?? on.label ?? on.id) : on.id;
      if (named && !announced) {
        yield {
          type: 'account',
          label,
          ...(switchedFrom ? { switchedFrom } : {}),
          ...(switchedFrom && reason ? { reason } : {}),
        };
      }
      announced = false;

      let refusal: RateLimitEvent | undefined;
      const held: AgentEvent[] = [];
      // A refusal in a turn of the process's own, and that turn's end.
      let ownRefusal: RateLimitEvent | undefined;
      const ownHeld: AgentEvent[] = [];
      let moveOwn: PickedAccount | undefined;
      turnEnded = ownTurn;
      // The resumed process may never report its background tasks; the
      // count the bridge assumed for it is taken back with its first turn.
      let assumedBackground = ownTurn;
      ownTurn = false;
      background = 0;
      // Past the switch line: leave at the next quiet point.
      let pastLine = false;
      const inFlight = new Set<string>();
      let leave: PickedAccount | undefined;

      for await (const evt of attempt.events) {
        if (handover) {
          // The process is being stopped for the next user message; what it
          // still prints belongs to no turn the bridge is showing.
          if (evt.type === 'rate_limit') deps.pool.observe(on.id, evt);
          if (evt.type === 'system' && evt.sessionId) sessionId = evt.sessionId;
          if (evt.type === 'done' && evt.sessionId) sessionId = evt.sessionId;
          continue;
        }
        if (evt.type === 'rate_limit') {
          deps.pool.observe(on.id, evt);
          if (evt.blocked && !turnEnded) {
            refusal = mergeRefusal(refusal, evt);
            continue;
          }
          if (evt.blocked && !stopped) {
            ownRefusal = mergeRefusal(ownRefusal, evt);
            continue;
          }
          if (!evt.blocked && !turnEnded && !stopped && !deps.pool.hasRoom(on.id, cap)) pastLine = true;
        }
        if (evt.type === 'subagent_rate_limited') {
          subagentsCut = true;
          // The subagent ran on this account: it is refused, whatever the
          // main agent last heard.
          deps.pool.observe(on.id, { type: 'rate_limit', blocked: true, at: evt.at });
          log.info('agent', 'subagent-rate-limited', { runId: opts.runId, account: on.id, taskId: evt.taskId ?? null });
        }
        if (evt.type === 'system' && evt.sessionId) sessionId = evt.sessionId;
        if (evt.type === 'background') {
          background = evt.count;
          assumedBackground = false;
        }
        if (evt.type === 'tool_use') inFlight.add(evt.id);
        const terminal = evt.type === 'done' || evt.type === 'error';
        if (terminal && evt.type === 'done' && evt.sessionId) sessionId = evt.sessionId;
        if (refusal && terminal) {
          held.push(evt);
          // Kept on for its background tasks, the process does not exit after
          // the refused turn: decide now instead of when it ends. Waiting held
          // the turn back until the idle timeout killed it (2026-10-29: four
          // subagents cut off with the main turn on a spent account).
          if (background > 0 && !stopped && !wasInterrupted(held)) {
            if (refusalTarget()) break;
            // Nowhere to go: the turn ends paused; its tasks report back as before.
            yield soonestReset(refusal, deps.pool);
            refusal = undefined;
            turnEnded = true;
            yield* held.splice(0);
          }
          continue;
        }
        if (refusal && isProgress(evt)) {
          // Working again after all: the refusal did not stop the run.
          yield refusal;
          refusal = undefined;
          yield* held.splice(0);
        }
        if (ownRefusal && isProgress(evt)) {
          yield ownRefusal;
          ownRefusal = undefined;
          yield* ownHeld.splice(0);
        }
        if (ownRefusal && terminal) {
          ownHeld.push(evt);
          moveOwn = stopped || wasInterrupted(ownHeld) ? undefined : elsewhere(on.id);
          if (moveOwn) break;
          // Nowhere to go: the turn ends paused, as before.
          yield soonestReset(ownRefusal, deps.pool);
          ownRefusal = undefined;
          if (assumedBackground) {
            yield { type: 'background', count: 0 };
            assumedBackground = false;
          }
          yield* ownHeld.splice(0);
          continue;
        }
        if (terminal) {
          // A subagent was cut off by the quota and the turn is over: move
          // before the next turn lands on the refused account too. Only with
          // the process kept on (its own turn, or background work left), so
          // the bridge does not let it go at this turn's end.
          const kept = turnEnded || background > 0;
          if (kept && subagentsCut && !stopped && evt.terminationReason !== 'interrupted' && deps.pool.isRefused(on.id)) {
            moveOwn = elsewhere(on.id);
          }
          if (moveOwn || assumedBackground) {
            yield { type: 'background', count: moveOwn ? Math.max(background, 1) : 0 };
            assumedBackground = false;
          }
          turnEnded = true;
          yield evt;
          if (moveOwn) break;
          continue;
        }
        yield evt;
        if (evt.type === 'tool_result') {
          inFlight.delete(evt.id);
          if (pastLine && !refusal && !stopped && !turnEnded && inFlight.size === 0 && background === 0) {
            leave = deps.pool.pickReady(new Set([...tried, on.id]), cap);
            if (leave) break;
            // Every other account is past a line too: use this one up.
            pastLine = false;
          }
        }
      }

      if (handover) {
        const next = handover;
        handover = undefined;
        await attempt.stop().catch(() => {});
        if (stopped) {
          yield { type: 'done', ...(sessionId ? { sessionId } : {}), terminationReason: 'interrupted' };
          return;
        }
        log.info('agent', 'account-handover', { runId: opts.runId, from: on.id, to: next.to.id, background });
        if (background > 0) yield { type: 'background', count: 0 };
        switchedFrom = label;
        reason = next.reason;
        account = next.to;
        tried = new Set();
        promote(next.to.id);
        current = deps.spawn({ ...opts, ...(sessionId ? { sessionId } : {}), prompt: next.prompt }, next.to);
        continue;
      }

      if (moveOwn) {
        const next = moveOwn;
        log.info('agent', 'account-background-failover', {
          runId: opts.runId,
          from: on.id,
          to: next.id,
          background,
          subagentsCut,
        });
        await attempt.stop();
        if (stopped) {
          if (ownRefusal) yield ownRefusal;
          yield* ownHeld;
          return;
        }
        // A turn of its own that tells the chat, before the resumed work runs:
        // the process keeps counting as busy until that work reports back.
        const nextLabel = (await deps.labelOf(next).catch(() => undefined)) ?? next.label ?? next.id;
        yield { type: 'account', label: nextLabel, switchedFrom: label, reason: '额度用尽，后台任务被中断' };
        yield { type: 'background', count: Math.max(background, 1) };
        yield { type: 'done', ...(sessionId ? { sessionId } : {}), terminationReason: 'normal' };
        subagentsCut = false;
        switchedFrom = label;
        reason = undefined;
        announced = true;
        ownTurn = true;
        account = next;
        tried = new Set();
        promote(next.id);
        current = deps.spawn({ ...opts, ...(sessionId ? { sessionId } : {}), prompt: BACKGROUND_FAILOVER_PROMPT }, next);
        continue;
      }

      if (leave) {
        const line = deps.pool.pastLine(on.id, undefined, cap);
        log.info('agent', 'account-leave', { runId: opts.runId, from: on.id, to: leave.id, window: line?.kind ?? null });
        await attempt.stop();
        if (stopped) {
          yield { type: 'done', ...(sessionId ? { sessionId } : {}), terminationReason: 'interrupted' };
          return;
        }
        switchedFrom = label;
        reason = lineReason(line);
        account = leave;
        promote(leave.id);
        current = deps.spawn({ ...opts, ...(sessionId ? { sessionId } : {}), prompt: SWITCH_LINE_PROMPT }, leave);
        continue;
      }

      if (!refusal) {
        yield* held;
        return;
      }
      const next = stopped || wasInterrupted(held) ? undefined : refusalTarget();
      if (!next) {
        yield soonestReset(refusal, deps.pool);
        yield* held;
        return;
      }
      log.info('agent', 'account-failover', {
        runId: opts.runId,
        from: on.id,
        to: next.id,
        hasSession: Boolean(sessionId),
        background,
        subagentsCut,
      });
      // With background tasks left the process stays up for them: no use waiting.
      if (background > 0 || !(await attempt.waitForExit(deps.exitWaitMs ?? 10_000))) await attempt.stop();
      if (stopped) {
        yield refusal;
        yield* held;
        return;
      }
      // Background tasks die with the refused process; the next one is told.
      const cut = subagentsCut || background > 0;
      if (background > 0) yield { type: 'background', count: 0 };
      subagentsCut = false;
      switchedFrom = label;
      reason = undefined;
      account = next;
      promote(next.id);
      current = deps.spawn(
        { ...opts, ...(sessionId ? { sessionId } : {}), prompt: failoverPrompt(lastPrompt, { subagents: cut }) },
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
    // The next user turn for a process kept for its background tasks — or,
    // when its account can no longer answer, for a new process on another.
    send: (prompt) => {
      if (!current.send) return false;
      const target = reading && !stopped && !handover ? handoverTarget() : undefined;
      if (target) {
        const cut = subagentsCut || background > 0;
        subagentsCut = false;
        handover = { prompt: handoverPrompt(prompt, { subagents: cut }), to: target.to, reason: target.reason };
        lastPrompt = prompt;
        turnEnded = false;
        void current.stop().catch(() => {});
        return true;
      }
      const sent = current.send(prompt);
      if (sent) {
        lastPrompt = prompt;
        turnEnded = false;
      }
      return sent;
    },
  };
}

function lineReason(line: { kind: keyof typeof WINDOW_LABELS; line: number } | undefined): string {
  return line ? `${WINDOW_LABELS[line.kind]}用量到了 ${line.line}% 的切换线` : '到了切换线';
}

const SUBAGENT_RECOVERY =
  '请先检查被中断的后台子任务，用 SendMessage 按原 agentId 恢复它们继续（不要重新派发新的子任务、不要重做已完成部分）';

/**
 * What the next account is asked after a refusal: the conversation it resumes
 * already holds whatever the last one got done, so continue from there. The
 * original message rides along in case the refusal came before it reached the
 * transcript. `subagents`: background subagents were cut off with it.
 */
export function failoverPrompt(original: string, opts: { subagents?: boolean } = {}): string {
  const ask = 'bridge 已切换到另一个账户。请从中断的地方接着完成，不要重复已经做完的步骤，也不要提起这次切换。';
  return [
    '[bridge] 上一次处理这条消息时 Claude 账户额度用尽，回答在中途停止了（已经完成的部分在上面的对话里）。',
    ...(opts.subagents
      ? [ask, `后台子任务也因为原账户额度用尽而中断：${SUBAGENT_RECOVERY}，然后再接着完成。用户的原消息如下：`]
      : [`${ask}用户的原消息如下：`]),
    '',
    original,
  ].join('\n');
}

/**
 * The next user message, for a new process that took the session over from
 * one whose account could no longer answer.
 */
export function handoverPrompt(original: string, opts: { subagents?: boolean } = {}): string {
  return [
    '[bridge] 这个会话原来所在的 Claude 账户已经不能继续使用（额度用尽或到了切换线），bridge 已把会话切换到另一个账户（之前的进展都在上面的对话里）。',
    opts.subagents
      ? `后台子任务所在账户额度用尽中断。${SUBAGENT_RECOVERY}，然后处理用户的新消息。`
      : '请处理用户的新消息。',
    '不要提起这次切换。用户的新消息如下：',
    '',
    original,
  ].join('\n');
}

/**
 * What a process resuming the session is told after its account refused a
 * turn of the process's own (a background task reporting back).
 */
export const BACKGROUND_FAILOVER_PROMPT = [
  '[bridge] 后台子任务所在账户额度用尽中断，bridge 已切换账户（之前的进展都在上面的对话里）。',
  `${SUBAGENT_RECOVERY}，然后接着完成原任务；不要提起这次切换。`,
].join('\n');

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
