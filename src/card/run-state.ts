import type { AgentEvent } from '../agent/types';
import { stripBriefMarker } from '../session/brief-marker';
import { stripNewSessionMarker } from '../session/smart-session';
import { stripTitleMarker, titleOf } from './title-marker';

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
}

export type Block =
  | {
      kind: 'text';
      content: string;
      streaming: boolean;
      /** Set on lines the bridge adds itself (account switch, mid-run supplement), not the agent. */
      note?: 'account' | 'supplement';
    }
  | { kind: 'tool'; tool: ToolEntry };

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;
/** `paused`: the plan's quota ran out mid-task (see {@link RunLimit}). */
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout' | 'paused';

/** Why and until when a run was stopped by the subscription quota. */
export interface RunLimit {
  limitType?: string;
  /** Epoch ms the quota window resets, when known. */
  resetsAt?: number;
  message?: string;
  /** Epoch ms the refusal was seen. */
  at: number;
  /** Set by the bridge when it will resume the task on its own at this time. */
  autoResumeAt?: number;
}

export interface RunState {
  blocks: Block[];
  finalText?: string;
  reasoning: { content: string; active: boolean };
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  /** Set when terminal === 'idle_timeout' — how long claude was idle before
   * the watchdog gave up (so the message can say "N 分钟无响应"). */
  idleTimeoutMinutes?: number;
  /** Latest quota window the agent reported, blocking or not. */
  quota?: { limitType?: string; resetsAt?: number };
  /** What the newest subagent step was, while one is working (footer only). */
  subagent?: { parentToolUseId: string; tool?: string; description?: string; at: number };
  /** Set once a request was refused for quota; the run ends `paused`. */
  limit?: RunLimit;
  /** The account the agent reported paying for the run (last one after a failover). */
  sponsor?: string;
  /** Set when terminal === 'interrupted' because the message that started
   * the run was recalled — the card says so instead of a plain "stopped". */
  interruptReason?: 'recalled';
  /**
   * Background tasks (backgrounded shells, monitors, background subagents)
   * the agent last reported running. Above zero when the turn ends, the task
   * is not over: the process works on and reports back in a later turn.
   */
  background?: number;
  /**
   * The header title the agent gave its answer with `[[TITLE: …]]`, read off
   * when the marker is stripped from the text (see `stripSessionMarker`).
   * Only the final card shows it.
   */
  title?: string;
}

export const initialState: RunState = {
  blocks: [],
  reasoning: { content: '', active: false },
  footer: 'thinking',
  terminal: 'running',
};

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b,
  );
}

export function reduce(state: RunState, evt: AgentEvent): RunState {
  switch (evt.type) {
    case 'text': {
      if (state.limit) state = { ...state, limit: undefined };
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === 'text' && last.streaming) {
        const next: Block = { ...last, content: last.content + evt.delta };
        return {
          ...state,
          blocks: [...state.blocks.slice(0, -1), next],
          reasoning: { ...state.reasoning, active: false },
          footer: 'streaming',
        };
      }
      return {
        ...state,
        blocks: [...state.blocks, { kind: 'text', content: evt.delta, streaming: true }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'streaming',
      };
    }

    case 'final_text':
      return { ...state, finalText: evt.content };

    case 'thinking': {
      return {
        ...state,
        reasoning: { content: state.reasoning.content + evt.delta, active: true },
        footer: 'thinking',
      };
    }

    case 'tool_use': {
      if (state.limit) state = { ...state, limit: undefined };
      const tool: ToolEntry = {
        id: evt.id,
        name: evt.name,
        input: evt.input,
        status: 'running',
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'tool_running',
      };
    }

    case 'tool_result': {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: evt.isError ? ('error' as const) : ('done' as const),
            output: evt.output,
          },
        };
      });
      return { ...state, blocks };
    }

    case 'rate_limit': {
      const quota = {
        limitType: evt.limitType ?? state.quota?.limitType,
        resetsAt: evt.resetsAt ?? state.quota?.resetsAt,
      };
      if (!evt.blocked) return { ...state, quota };
      // A refusal. If the agent still gets work done afterwards (a fallback
      // model, a retry), the text/tool_use cases above clear it again.
      const limit: RunLimit = {
        ...(quota.limitType ? { limitType: quota.limitType } : {}),
        ...(quota.resetsAt ? { resetsAt: quota.resetsAt } : {}),
        ...(evt.message ?? state.limit?.message ? { message: evt.message ?? state.limit?.message } : {}),
        at: evt.at,
      };
      return { ...state, quota, limit };
    }

    case 'account': {
      if (!evt.switchedFrom) return { ...state, sponsor: evt.label };
      // Moved to another account mid-task: say so where it happened, and drop
      // the refusal that caused it — the task goes on, it is not paused.
      const note: Block = {
        kind: 'text',
        content: `🔄 **账户 ${evt.switchedFrom} ${evt.reason ?? '额度用尽'}，已切换到 ${evt.label} 继续**\n\n`,
        streaming: false,
        note: 'account',
      };
      const { limit: _limit, ...rest } = state;
      return {
        ...rest,
        sponsor: evt.label,
        blocks: [...closeStreamingText(state.blocks), note],
        footer: 'thinking',
      };
    }

    case 'subagent_activity':
      return {
        ...state,
        subagent: {
          parentToolUseId: evt.parentToolUseId,
          ...(evt.tool ? { tool: evt.tool } : {}),
          ...(evt.description ? { description: evt.description } : {}),
          at: evt.at,
        },
      };

    case 'supplement': {
      // Mark where in the run the user's mid-run supplement was read, so the
      // card shows which part of the answer already accounts for it.
      const note: Block = {
        kind: 'text',
        content: `➕ **收到补充**：${evt.preview}`,
        streaming: false,
        note: 'supplement',
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), note],
        footer: 'thinking',
      };
    }

    case 'error': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : state.limit
              ? 'paused'
              : 'error';
      return {
        ...state,
        terminal,
        errorMsg: terminal === 'error' ? evt.message : state.errorMsg,
        footer: null,
      };
    }

    case 'background':
      return state.background === evt.count ? state : { ...state, background: evt.count };

    case 'done': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : state.limit
              ? 'paused'
              : 'done';
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal,
        footer: null,
      };
    }

    default:
      return state;
  }
}

/**
 * Background tasks still running when the run ended `done` — the answer is in,
 * the task is not; 0 otherwise.
 */
export function backgroundLeft(state: RunState | undefined): number {
  return state?.terminal === 'done' ? (state.background ?? 0) : 0;
}

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'interrupted',
    footer: null,
  };
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'idle_timeout',
    footer: null,
    idleTimeoutMinutes: minutes,
  };
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'done',
    footer: null,
  };
}

/**
 * Agent-side opt-out of the final reply. A run whose whole visible answer is
 * this marker has already delivered its result some other way — typically a
 * skill that posted its own interactive card via `lark-cli` (`/show-status`,
 * `/show-tasks`, …). Replying on top of that card only adds a second, empty
 * "card sent" message. The agent host insists on *some* final text, so the
 * skill ends with the marker and the bridge treats it as "nothing to send".
 */
export const NO_REPLY_MARKER = '[[NO_REPLY]]';

/**
 * True when `text` is the marker, or a still-streaming prefix of it. The prefix
 * case keeps a half-arrived `[[NO_` from opening a progress card that would
 * then have to be recalled.
 */
export function isNoReplyText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return t === NO_REPLY_MARKER || (t.startsWith('[[') && NO_REPLY_MARKER.startsWith(t));
}

/** Drop marker-only text (blocks and final text) so every reply path sees an empty answer. */
export function stripNoReply(state: RunState): RunState {
  const blocks = state.blocks.filter((b) => !(b.kind === 'text' && isNoReplyText(b.content)));
  const finalText =
    state.finalText !== undefined && isNoReplyText(state.finalText) ? undefined : state.finalText;
  if (blocks.length === state.blocks.length && finalText === state.finalText) return state;
  return { ...state, blocks, finalText };
}

/**
 * Drop a trailing `[[NEW_SESSION…]]` marker (会话智能压缩), `[[BRIEF…]]` and
 * `[[TITLE…]]` from the answer the user sees — complete, or still streaming in
 * on a live text block. The session request and the brief are read from the
 * raw state by the channel; the title is kept on the state (`title`).
 */
export function stripSessionMarker(state: RunState): RunState {
  let changed = false;
  let title: string | undefined;
  const strip = (text: string, streaming = false): string => {
    title = titleOf(text) ?? title;
    return stripNewSessionMarker(stripTitleMarker(stripBriefMarker(text, streaming), streaming), streaming);
  };
  const blocks = state.blocks.map((b) => {
    if (b.kind !== 'text') return b;
    const content = strip(b.content, b.streaming);
    if (content === b.content) return b;
    changed = true;
    return { ...b, content };
  });
  const finalText = state.finalText !== undefined ? strip(state.finalText) : undefined;
  if (finalText !== state.finalText) changed = true;
  if (!changed) return state;
  return {
    ...state,
    blocks: blocks.filter((b) => !(b.kind === 'text' && b.content.trim() === '')),
    finalText: finalText?.trim() ? finalText : undefined,
    ...((title ?? state.title) ? { title: title ?? state.title } : {}),
  };
}

/** Agent-side reply markers: `[[NO_REPLY]]` answers, `[[BRIEF…]]`, `[[TITLE…]]` and a trailing `[[NEW_SESSION…]]`. */
export function stripControlMarkers(state: RunState): RunState {
  return stripNoReply(stripSessionMarker(state));
}

/**
 * The run cut down to the answer it ends on, for a reply posted once at the
 * end (text mode, and the answer after a CoT bubble, which already showed
 * the work): the final text when the agent reported one (Codex), else
 * the text after the last tool call — what the agent wrote once its work was
 * done. Claude never reports a final text, so without this cut its notes
 * between tool calls ("我先看一下…") end up in the reply.
 *
 * A run that never got past a tool call (stopped, failed or paused in the
 * middle of its work) has no such text: it keeps everything it said, so the
 * terminal notice is not all that is left.
 *
 * Pass the raw state, before `stripControlMarkers` and the `showToolCalls`
 * filter: tool blocks mark where the answer starts, and a `[[NO_REPLY]]`
 * answer has to still be the answer when markers are stripped afterwards —
 * cutting after the strip would fall back to the notes before it.
 */
export function finalAnswerState(state: RunState): RunState {
  const text = (blocks: readonly Block[]): Block[] => blocks.filter((b) => b.kind === 'text');
  let blocks: Block[];
  if (state.finalText) {
    blocks = [{ kind: 'text', content: state.finalText, streaming: false }];
  } else {
    let start = state.blocks.length;
    while (start > 0 && state.blocks[start - 1]?.kind !== 'tool') start--;
    const answer = text(state.blocks.slice(start));
    blocks = answer.length > 0 ? withEarlierAnswer(state.blocks.slice(0, start), answer) : text(state.blocks);
  }
  // A `[[TITLE…]]` the agent wrote before its last tool call is cut off with
  // that text; keep its title for the card (a later marker still wins).
  const title =
    state.title ??
    titleOf([...state.blocks.map((b) => (b.kind === 'text' ? b.content : '')), state.finalText ?? ''].join('\n'));
  return { ...state, blocks, reasoning: { content: '', active: false }, footer: null, ...(title ? { title } : {}) };
}

/** A tail shorter than this reads as a sign-off ("已保存"), not as the answer. */
export const FINAL_ANSWER_SIGN_OFF_MAX = 40;
/** An earlier stretch of text at least this long reads as the answer itself. */
export const FINAL_ANSWER_EARLIER_MIN = 200;

/**
 * The agent often writes its answer, then makes one more tool call to wrap up
 * (save a memory, send a file) and ends on a sign-off. Cutting after the last
 * tool call would post only the sign-off, so when the tail is that short and
 * an earlier stretch of text (between two tool calls) is long enough to be an
 * answer, the longest such stretch goes out before the tail. Short notes
 * ("我先看一下…") never reach the bar, and a `[[NO_REPLY]]` tail stays as is.
 */
function withEarlierAnswer(before: readonly Block[], tail: Block[]): Block[] {
  const own = (blocks: readonly Block[]): string =>
    blocks.map((b) => (b.kind === 'text' && !b.note ? b.content : '')).join('').trim();
  const tailText = own(tail);
  if (tailText.length >= FINAL_ANSWER_SIGN_OFF_MAX || tailText.includes(NO_REPLY_MARKER)) return tail;
  let best: Block[] = [];
  let current: Block[] = [];
  const settle = () => {
    if (own(current).length > own(best).length) best = current;
    current = [];
  };
  for (const b of before) {
    if (b.kind === 'text') current.push(b);
    else settle();
  }
  settle();
  if (own(best).length < FINAL_ANSWER_EARLIER_MIN) return tail;
  const lastOfBest = best[best.length - 1];
  const joint: Block[] =
    lastOfBest?.kind === 'text' && !/\n\s*$/.test(lastOfBest.content)
      ? [{ kind: 'text', content: '\n\n', streaming: false }]
      : [];
  return [...best, ...joint, ...tail];
}

/** The answer text of a run state: its final text, else its last text block. */
export function answerTextOf(state: RunState | undefined): string | undefined {
  if (!state) return undefined;
  if (state.finalText) return state.finalText;
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i];
    if (block?.kind === 'text') return block.content;
  }
  return undefined;
}
