import type { ActiveRuns, RunHandle } from './active-runs';

/**
 * Recalling a message sent to the bot takes back what it asked for: a queued
 * message never runs, a run whose every message was recalled is cancelled,
 * and a run that still has other messages to go on is told to disregard the
 * recalled one (what the agent already read cannot be taken back).
 *
 * Feishu pushes `im.message.recalled_v1` only when the app subscribes to it in
 * the developer console ("消息被撤回").
 */
export const RECALL_EVENT = 'im.message.recalled_v1';

export interface RecallEvent {
  messageId: string;
  chatId?: string;
  /** Who recalled it: message_owner / group_owner / group_manager / enterprise_manager. */
  recallType?: string;
  /** Milliseconds since the epoch, as a string on the wire. */
  recallTime?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * The SDK dispatcher hands raw handlers the event body with the v2 envelope's
 * header fields flattened in; the nested `{ header, event }` shape is accepted
 * too in case that ever changes.
 */
export function parseRecallEvent(raw: unknown): RecallEvent | undefined {
  const d = asRecord(raw);
  const body = d.message_id === undefined && d.event ? asRecord(d.event) : d;
  const messageId = str(body.message_id);
  if (!messageId) return undefined;
  const chatId = str(body.chat_id);
  const recallType = str(body.recall_type);
  const recallTime = str(body.recall_time);
  return {
    messageId,
    ...(chatId ? { chatId } : {}),
    ...(recallType ? { recallType } : {}),
    ...(recallTime ? { recallTime } : {}),
  };
}

const RECALLED_TTL_MS = 30 * 60_000;

/**
 * Messages recalled lately. A recall can land while its message is in neither
 * place {@link applyRecall} looks — still going through intake, or flushed
 * from the queue but not yet registered as a run — so those steps check here.
 */
export class RecalledMessages {
  private readonly ids = new Map<string, number>();

  constructor(private readonly ttlMs: number = RECALLED_TTL_MS) {}

  add(messageId: string, now: number = Date.now()): void {
    for (const [id, at] of this.ids) {
      if (now - at > this.ttlMs) this.ids.delete(id);
    }
    this.ids.set(messageId, now);
  }

  has(messageId: string, now: number = Date.now()): boolean {
    const at = this.ids.get(messageId);
    return at !== undefined && now - at <= this.ttlMs;
  }
}

export type RecallOutcome =
  /** Taken out of the queue before it ran. */
  | { action: 'dequeued'; scope: string }
  /** Every message the run was given is recalled: the run is stopped. */
  | { action: 'cancelled'; scope: string }
  /** The run goes on with its other messages; the agent was told (when it could still take input). */
  | { action: 'voided'; scope: string; injected: boolean }
  | { action: 'none' };

/** What the card shows where the agent read the note. */
export const RECALL_PREVIEW = '↩️ 撤回了一条消息，已让 agent 忽略它';

export function recallNote(messageId: string): string {
  return (
    `[bridge] 用户撤回了消息 ${messageId}。它的内容作废：忽略那条消息里的要求和信息，` +
    '按其余消息继续当前任务；因它而做、且其余消息并不需要的事，不要再做下去。'
  );
}

interface RecallDeps {
  activeRuns: ActiveRuns;
  recalled: RecalledMessages;
}

/**
 * Settle a recalled message against the run that took it in. The run is
 * cancelled only once every message it was given — the batch that started it
 * and any supplements folded in since — has been recalled.
 */
export function settleRecall(
  scope: string,
  handle: RunHandle,
  messageId: string,
  deps: RecallDeps,
): RecallOutcome {
  const origin = handle.supplement?.originIds;
  if (!origin?.has(messageId)) return { action: 'none' };
  if ([...origin].every((id) => deps.recalled.has(id))) {
    deps.activeRuns.interrupt(scope, 'recalled');
    return { action: 'cancelled', scope };
  }
  const injected = handle.run.inject?.(recallNote(messageId), RECALL_PREVIEW) ?? false;
  return { action: 'voided', scope, injected };
}

/** Apply a recall to the queue and the runs; remembered either way for messages still on their way. */
export function applyRecall(
  messageId: string,
  deps: RecallDeps & { pending: { remove(messageId: string): string | undefined } },
): RecallOutcome {
  deps.recalled.add(messageId);
  const queuedIn = deps.pending.remove(messageId);
  if (queuedIn) return { action: 'dequeued', scope: queuedIn };
  for (const { scope, handle } of deps.activeRuns.entries()) {
    if (handle.supplement?.originIds.has(messageId)) return settleRecall(scope, handle, messageId, deps);
  }
  return { action: 'none' };
}

/**
 * For a run just registered: settle messages of its batch that were recalled
 * while it was being prepared. Stops at a cancel — nothing is left to tell.
 */
export function settleEarlyRecalls(scope: string, handle: RunHandle, deps: RecallDeps): RecallOutcome[] {
  const outcomes: RecallOutcome[] = [];
  for (const id of [...(handle.supplement?.originIds ?? [])]) {
    if (!deps.recalled.has(id)) continue;
    const outcome = settleRecall(scope, handle, id, deps);
    outcomes.push(outcome);
    if (outcome.action === 'cancelled') break;
  }
  return outcomes;
}
