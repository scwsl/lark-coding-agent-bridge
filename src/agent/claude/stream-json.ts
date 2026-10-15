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
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
  num_turns?: number;
  /** `system/background_tasks_changed`: the full list of running background tasks. */
  tasks?: unknown[];
}

/**
 * A `result` that closes a turn in which the model never ran. On `--resume`
 * Claude Code first drains task notifications left over from the previous
 * process (e.g. a background Bash that died when the bridge reaped that
 * process after `done`) and closes that drain with its own `num_turns: 0`
 * result — before our prompt has reached the model. It is not the answer.
 */
export function isNoTurnResult(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const evt = raw as ClaudeRawEvent;
  return evt.type === 'result' && evt.num_turns === 0;
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as ClaudeRawEvent;

  // A subagent's own text, tool calls and results are its working, not the
  // answer: the main agent gets the subagent's report as the Agent tool's
  // result. Rendering them made one review run's card carry five full
  // subagent reports, past Feishu's card size limit (230025) — every update
  // after that was rejected and the card froze mid-run.
  // What it is doing still matters, though: a subagent can work for half an
  // hour while the main agent just waits, and without a sign of life the run
  // looks stuck. So only its activity comes through, never its content.
  if (typeof evt.parent_tool_use_id === 'string' && evt.parent_tool_use_id) {
    if (evt.type !== 'assistant') return;
    const tool = evt.message?.content?.find((b) => b.type === 'tool_use' && b.name);
    const description = (tool?.input as { description?: unknown } | undefined)?.description;
    yield {
      type: 'subagent_activity',
      parentToolUseId: evt.parent_tool_use_id,
      ...(tool?.name ? { tool: tool.name } : {}),
      ...(typeof description === 'string' && description.trim()
        ? { description: description.trim() }
        : {}),
      at: Date.now(),
    };
    return;
  }

  if (evt.type === 'system' && evt.subtype === 'background_tasks_changed') {
    yield { type: 'background', count: Array.isArray(evt.tasks) ? evt.tasks.length : 0 };
    return;
  }

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
      // Claude counts cache reads / writes apart from `input_tokens`; the
      // bridge's usage event reports the whole prompt, cached part included
      // (Codex's convention). `total_cost_usd` is cumulative for the process —
      // the adapter turns it into a per-turn figure.
      const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens } = evt.usage;
      const anyInput =
        input_tokens !== undefined || cache_read_input_tokens !== undefined || cache_creation_input_tokens !== undefined;
      yield {
        type: 'usage',
        inputTokens: anyInput
          ? (input_tokens ?? 0) + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0)
          : undefined,
        outputTokens: evt.usage.output_tokens,
        cachedInputTokens: cache_read_input_tokens,
        costUsd: evt.total_cost_usd,
      };
    }
    yield { type: 'done', sessionId: evt.session_id, terminationReason: 'normal' };
  }
}

/** Encode one prompt as a stream-json user message (`--input-format stream-json`). */
export function encodeUserMessage(prompt: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })}\n`;
}
