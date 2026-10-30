import type { NormalizedMessage, RawMessageEvent } from '@larksuite/channel';
import type { ActiveRuns, RunHandle } from './active-runs';
import { mediaPlaceholders } from './media-placeholders';

/**
 * Editing a message already sent is a second chance to address the bot: an
 * @ added in the edit should reach it as if the message had carried it from
 * the start, and a message the bot already took in — queued, running, or
 * done — should come back as a supplement or an update to what it asked.
 *
 * Feishu pushes `im.message.updated_v1` only when the app subscribes to it in
 * the developer console ("消息被编辑"). The body has the same `{ sender,
 * message }` shape as `im.message.receive_v1`, carrying the edited content.
 */
export const EDIT_EVENT = 'im.message.updated_v1';

export interface EditEvent {
  messageId: string;
  chatId: string;
  /** Milliseconds since the epoch, as a string on the wire; tells one edit of a message from the next. */
  updateTime?: string;
  /** `user` for people; bots (`app`) edit their own streaming replies all the time. */
  senderType?: string;
  /** The body rebuilt as a receive event, for the SDK's `normalize()`; absent when the sender is missing. */
  event?: RawMessageEvent;
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
export function parseEditEvent(raw: unknown): EditEvent | undefined {
  const d = asRecord(raw);
  const body = d.message === undefined && d.event ? asRecord(d.event) : d;
  const message = asRecord(body.message);
  const messageId = str(message.message_id);
  const chatId = str(message.chat_id);
  if (!messageId || !chatId) return undefined;
  const sender = asRecord(body.sender);
  const senderId = asRecord(sender.sender_id);
  const hasSender = Boolean(str(senderId.open_id) ?? str(senderId.user_id) ?? str(senderId.union_id));
  const updateTime = str(message.update_time);
  const senderType = str(sender.sender_type);
  return {
    messageId,
    chatId,
    ...(updateTime ? { updateTime } : {}),
    ...(senderType ? { senderType } : {}),
    ...(hasSender && typeof message.content === 'string'
      ? { event: { sender, message } as unknown as RawMessageEvent }
      : {}),
  };
}

const EDIT_TTL_MS = 30 * 60_000;

/**
 * Edits already handled. Feishu redelivers an event it thinks went
 * unacknowledged, and one edit must not start two runs; a later edit of the
 * same message carries a new `update_time` and goes through.
 */
export class EditedMessages {
  private readonly keys = new Map<string, number>();

  constructor(private readonly ttlMs: number = EDIT_TTL_MS) {}

  /** True the first time this edit is seen (and remembers it). */
  firstSeen(evt: Pick<EditEvent, 'messageId' | 'updateTime'>, now: number = Date.now()): boolean {
    for (const [key, at] of this.keys) {
      if (now - at > this.ttlMs) this.keys.delete(key);
    }
    const key = `${evt.messageId}:${evt.updateTime ?? ''}`;
    if (this.keys.has(key)) return false;
    this.keys.set(key, now);
    return true;
  }
}

const edited = new WeakSet<NormalizedMessage>();

/** Tag a message built from an edit, so the run that takes it knows to treat it as one. */
export function markEdited(msg: NormalizedMessage): NormalizedMessage {
  edited.add(msg);
  return msg;
}

export function isEdited(msg: NormalizedMessage): boolean {
  return edited.has(msg);
}

/** For a run whose batch has an edited message: it may be new to the agent, or a change to something it already did. */
export function editInstruction(messageIds: string[]): string {
  return (
    `本轮的消息 ${messageIds.join('、')} 是用户在飞书里编辑过的版本（飞书允许修改已发出的消息）。` +
    '如果你在本会话里已经处理过这条消息，把编辑当作对原要求的补充或更新：对比原内容找出改动，按新内容调整，' +
    '已经完成且不受改动影响的部分不用重做；如果之前没处理过（例如编辑时才 @ 你），就当作一条新消息处理。'
  );
}

/** For an edit folded into the run that the message started. */
export function editSupplementInstruction(messageId: string): string {
  return (
    `用户在你执行当前任务的过程中编辑了触发本任务的消息 ${messageId}，下面是编辑后的完整内容，不是新任务：` +
    '对比原内容找出改动，把改动当作对当前任务的补充或更新，按新要求继续；已经完成且不受影响的部分不用重做。'
  );
}

const PREVIEW_MAX = 60;

/** One-line marker for the card where the agent read the edit. */
export function editPreview(content: string): string {
  const text = mediaPlaceholders(content).replace(/\s+/g, ' ').trim();
  const body = text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
  return `✏️ 消息已编辑：${body || '（空消息）'}`;
}

/** The run that took this message in, if one is still going. */
export function runForMessage(
  activeRuns: ActiveRuns,
  messageId: string,
): { scope: string; handle: RunHandle } | undefined {
  for (const { scope, handle } of activeRuns.entries()) {
    if (handle.supplement?.originIds.has(messageId)) return { scope, handle };
  }
  return undefined;
}
