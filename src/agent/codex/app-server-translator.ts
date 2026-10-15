import { log } from '../../core/logger';
import type { AgentEvent } from '../types';

/**
 * Turns `codex app-server` notifications for one turn into bridge events,
 * with the same shape the `codex exec --json` translator produces: command
 * runs as `command_execution` tool calls, every agent message but the last
 * as progress text, the last one as `final_text`, then usage and `done`.
 *
 * Unlike `exec`, the app-server reports usage per model call
 * (`thread/tokenUsage/updated.last`); the turn's usage is their sum.
 */
export class CodexAppServerTranslator {
  private readonly threadId: string;
  private pendingAgentMessage: string | undefined;
  private lastError: string | undefined;
  private terminal = false;
  private readonly usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  private sawUsage = false;

  constructor(threadId: string) {
    this.threadId = threadId;
  }

  /** The turn's opening event: the session handle the bridge resumes later. */
  start(): AgentEvent[] {
    return [{ type: 'system', threadId: this.threadId }];
  }

  get done(): boolean {
    return this.terminal;
  }

  notification(method: string, params: Record<string, unknown>): AgentEvent[] {
    if (this.terminal) return [];
    switch (method) {
      case 'item/started':
        return this.prependPending(this.itemStarted(record(params.item)));
      case 'item/completed':
        return this.itemCompleted(record(params.item));
      case 'item/reasoning/summaryTextDelta': {
        const delta = str(params.delta);
        return delta ? [{ type: 'thinking', delta }] : [];
      }
      case 'thread/tokenUsage/updated':
        this.addUsage(record(record(params.tokenUsage)?.last));
        return [];
      case 'error': {
        const message = str(record(params.error)?.message);
        if (message) {
          this.lastError = message;
          log.warn('codex-app-server', 'error_event', { message: message.slice(0, 500), willRetry: params.willRetry === true });
        }
        return [];
      }
      case 'turn/completed':
        return this.turnCompleted(record(params.turn));
      default:
        return [];
    }
  }

  /** The process went away mid-turn. */
  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const detail = this.lastError && !message.includes(this.lastError) ? `: ${this.lastError}` : '';
    return this.prependPending([{ type: 'error', message: truncate(`${message}${detail}`), terminationReason: 'failed' }]);
  }

  private itemStarted(item: Record<string, unknown> | undefined): AgentEvent[] {
    const id = str(item?.id);
    if (!item || !id) return [];
    if (item.type === 'commandExecution') {
      return [{ type: 'tool_use', id, name: 'command_execution', input: { command: str(item.command) ?? '' } }];
    }
    if (item.type === 'fileChange') {
      const paths = (Array.isArray(item.changes) ? item.changes : [])
        .map((c) => str(record(c)?.path))
        .filter((p): p is string => Boolean(p));
      return [{ type: 'tool_use', id, name: 'file_change', input: { paths } }];
    }
    return [];
  }

  private itemCompleted(item: Record<string, unknown> | undefined): AgentEvent[] {
    if (!item) return [];
    if (item.type === 'agentMessage') {
      const text = str(item.text);
      return text ? this.queueAgentMessage(text) : [];
    }
    if (item.type === 'fileChange') {
      const id = str(item.id);
      if (!id) return [];
      return this.prependPending([
        { type: 'tool_result', id, output: str(item.status) ?? '', isError: item.status !== 'completed' },
      ]);
    }
    if (item.type !== 'commandExecution') return [];
    const id = str(item.id);
    if (!id) return [];
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
    return this.prependPending([
      {
        type: 'tool_result',
        id,
        output: str(item.aggregatedOutput) ?? '',
        isError: item.status === 'failed' || (exitCode !== undefined && exitCode !== 0),
      },
    ]);
  }

  private turnCompleted(turn: Record<string, unknown> | undefined): AgentEvent[] {
    this.terminal = true;
    const status = str(turn?.status);
    if (status === 'failed') {
      const message = str(record(turn?.error)?.message) ?? this.lastError ?? 'codex turn failed';
      return this.prependPending([{ type: 'error', message: truncate(message), terminationReason: 'failed' }]);
    }
    const events: AgentEvent[] = [];
    if (status === 'interrupted') {
      if (this.pendingAgentMessage) events.push({ type: 'text', delta: this.pendingAgentMessage });
    } else if (this.pendingAgentMessage) {
      events.push({ type: 'final_text', content: this.pendingAgentMessage });
    }
    this.pendingAgentMessage = undefined;
    if (this.sawUsage) events.push({ type: 'usage', ...this.usage });
    events.push({
      type: 'done',
      threadId: this.threadId,
      terminationReason: status === 'interrupted' ? 'interrupted' : 'normal',
    });
    return events;
  }

  private addUsage(last: Record<string, unknown> | undefined): void {
    if (!last) return;
    this.sawUsage = true;
    this.usage.inputTokens += num(last.inputTokens);
    this.usage.cachedInputTokens += num(last.cachedInputTokens);
    this.usage.outputTokens += num(last.outputTokens);
    this.usage.reasoningOutputTokens += num(last.reasoningOutputTokens);
  }

  private queueAgentMessage(message: string): AgentEvent[] {
    if (message === this.pendingAgentMessage) return [];
    const events: AgentEvent[] = this.pendingAgentMessage ? [{ type: 'text', delta: this.pendingAgentMessage }] : [];
    this.pendingAgentMessage = message;
    return events;
  }

  private prependPending(events: AgentEvent[]): AgentEvent[] {
    if (events.length === 0 || !this.pendingAgentMessage) return events;
    const pending = this.pendingAgentMessage;
    this.pendingAgentMessage = undefined;
    return [{ type: 'text', delta: pending }, ...events];
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function truncate(value: string, max = 4096): string {
  return value.length > max ? value.slice(0, max) : value;
}
