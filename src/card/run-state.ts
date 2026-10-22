import type { AgentEvent } from '../agent/types';
import { stripNewSessionMarker } from '../session/smart-session';

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
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
 * Drop a trailing `[[NEW_SESSION…]]` marker (会话智能压缩) from the answer the
 * user sees — complete, or still streaming in on a live text block. The
 * request itself is read from the raw state by the channel.
 */
export function stripSessionMarker(state: RunState): RunState {
  let changed = false;
  const blocks = state.blocks.map((b) => {
    if (b.kind !== 'text') return b;
    const content = stripNewSessionMarker(b.content, b.streaming);
    if (content === b.content) return b;
    changed = true;
    return { ...b, content };
  });
  const finalText = state.finalText !== undefined ? stripNewSessionMarker(state.finalText) : undefined;
  if (finalText !== state.finalText) changed = true;
  if (!changed) return state;
  return {
    ...state,
    blocks: blocks.filter((b) => !(b.kind === 'text' && b.content.trim() === '')),
    finalText: finalText?.trim() ? finalText : undefined,
  };
}

/** Both agent-side reply markers: `[[NO_REPLY]]` answers and a trailing `[[NEW_SESSION…]]`. */
export function stripControlMarkers(state: RunState): RunState {
  return stripNoReply(stripSessionMarker(state));
}
