import type { AgentEvent } from '../types';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeRawEvent {
  type?: string;
  subtype?: string;
  /** On a synthetic assistant message: why the API call failed. */
  error?: string;
  rate_limit_info?: {
    status?: string;
    resetsAt?: number;
    rateLimitType?: string;
  };
  session_id?: string;
  cwd?: string;
  model?: string;
  message?: { content?: ContentBlock[] };
  /** Set on messages from inside a subagent (Agent/Task tool) — the id of the
   * parent's tool_use that spawned it. Absent or null for the main agent. */
  parent_tool_use_id?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as ClaudeRawEvent;

  // A subagent's own text, tool calls and results are its working, not the
  // answer: the main agent gets the subagent's report as the Agent tool's
  // result. Rendering them made one review run's card carry five full
  // subagent reports, past Feishu's card size limit (230025) — every update
  // after that was rejected and the card froze mid-run.
  if (typeof evt.parent_tool_use_id === 'string' && evt.parent_tool_use_id) return;

  if (evt.type === 'system' && evt.subtype === 'init') {
    yield {
      type: 'system',
      sessionId: evt.session_id,
      cwd: evt.cwd,
      model: evt.model,
    };
    return;
  }

  if (evt.type === 'rate_limit_event' && evt.rate_limit_info) {
    const info = evt.rate_limit_info;
    yield {
      type: 'rate_limit',
      blocked: info.status === 'rejected',
      ...(info.rateLimitType ? { limitType: info.rateLimitType } : {}),
      // Claude reports epoch seconds.
      ...(typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt * 1000 } : {}),
      at: Date.now(),
    };
    return;
  }

  // Claude Code turns a quota refusal into an assistant message flagged
  // `error: "rate_limit"` ("You've hit your limit · resets …"). It is the
  // reason the run stopped, not part of the answer.
  if (evt.type === 'assistant' && evt.error === 'rate_limit') {
    const message = (evt.message?.content ?? [])
      .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('')
      .trim();
    yield { type: 'rate_limit', blocked: true, ...(message ? { message } : {}), at: Date.now() };
    return;
  }

  if (evt.type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        yield { type: 'text', delta: block.text };
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        yield { type: 'thinking', delta: block.thinking };
      } else if (block.type === 'tool_use' && block.id && block.name) {
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
    }
    return;
  }

  if (evt.type === 'user' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const output =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        yield {
          type: 'tool_result',
          id: block.tool_use_id,
          output,
          isError: block.is_error === true,
        };
      }
    }
    return;
  }

  if (evt.type === 'result') {
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
        cachedInputTokens: evt.usage.cache_read_input_tokens,
        costUsd: evt.total_cost_usd,
      };
    }
    yield { type: 'done', sessionId: evt.session_id, terminationReason: 'normal' };
  }
}
