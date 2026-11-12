import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AutoTopicPreference } from '../config/schema';
import { log } from '../core/logger';
import { lookupMessageThreadId } from './thread-id';

/**
 * 前缀开话题: a message that opens with `/new-topic` or a rung of the
 * 自动分级 ladder (`/xhigh 帮我…`) is a task of its own. Outside a topic, the bot replies
 * under that very message in thread — the message becomes the topic's first
 * post, so its sender follows the topic without being @-ed — and the message
 * runs in the topic's conversation instead of the chat's. Inside a topic
 * (topic groups included) it runs where it is: Feishu has no topic within a
 * topic.
 *
 * A rung prefix stays in the text: 自动分级 reads it to pin the rung. The
 * `/new-topic` prefix comes off, or the agent would take it for the skill of
 * that name and open yet another topic.
 */

export const NEW_TOPIC_COMMAND = 'new-topic';

export interface TopicPrefix {
  /** `new-topic`, the rung label as configured, or the pinned model. */
  label: string;
  kind: 'new-topic' | 'effort' | 'auto' | 'model';
  /** The text after the prefix. */
  rest: string;
}

/**
 * The topic prefix `text` opens with, if any. Case-insensitive; the prefix
 * must stand alone. A bare prefix with nothing to do — no text, attachment or
 * quoted message — is not one: there is no task to give a topic.
 */
export function matchTopicPrefix(
  text: string,
  effortLabels: readonly string[],
  extras: { attachments?: number; quoted?: boolean } = {},
): TopicPrefix | undefined {
  const m = /^\s*\/([A-Za-z][\w-]*)(?:\s+|$)/.exec(text);
  if (!m) return undefined;
  const name = m[1]!.toLowerCase();
  const rest = text.slice(m[0].length).trim();
  if (!rest && !(extras.attachments ?? 0) && !extras.quoted) return undefined;
  if (name === NEW_TOPIC_COMMAND) return { label: NEW_TOPIC_COMMAND, kind: 'new-topic', rest };
  const label = effortLabels.find((l) => l.toLowerCase() === name);
  return label ? { label, kind: 'effort', rest } : undefined;
}

/** The prefix an 自动开话题 message runs under: no prefix, the text as sent. */
export function autoTopicPrefix(text: string): TopicPrefix {
  return { label: 'auto', kind: 'auto', rest: text };
}

/** Whether 自动开话题 is on for `chatId`. */
export function autoTopicEnabled(pref: boolean | AutoTopicPreference | undefined, chatId: string): boolean {
  if (!pref) return false;
  if (pref === true) return true;
  if (pref.exceptChats?.includes(chatId)) return false;
  return !pref.chats?.length || pref.chats.includes(chatId);
}

/** The line the bot opens the topic with. */
export function topicOpenedText(prefix: TopicPrefix): string {
  if (prefix.kind === 'effort') return `🧵 已开话题，按「/${prefix.label}」档在这里处理。`;
  if (prefix.kind === 'model') return `🧵 已开话题，本话题固定用 ${prefix.label} 模型处理。`;
  return '🧵 已开话题，在这里处理。';
}

/** The message text the topic's run gets: `/new-topic` and `/model <name>` taken off, a rung prefix kept. */
export function topicRunText(text: string, prefix: TopicPrefix): string {
  if (prefix.kind !== 'new-topic' && prefix.kind !== 'model') return text;
  return prefix.rest || '请处理我引用的消息或发来的附件。';
}

/** The reply that opened a topic under a message, and the topic's id — missing when Feishu gave none back. */
export interface OpenedTopic {
  threadId: string | undefined;
  openerId: string;
}

/**
 * Reply under `msg` in thread and return the topic it opened. Undefined when
 * the reply could not be sent; no `threadId` when Feishu gave none back —
 * either way the caller runs the message where it was.
 */
export async function openTopicUnder(
  channel: LarkChannel,
  msg: Pick<NormalizedMessage, 'chatId' | 'messageId'>,
  content: string | { card: object },
  retryDelayMs = 800,
): Promise<OpenedTopic | undefined> {
  let openerId: string;
  try {
    const sent = await channel.send(
      msg.chatId,
      typeof content === 'string' ? { text: content } : content,
      { replyTo: msg.messageId, replyInThread: true },
    );
    openerId = sent.messageId;
  } catch (err) {
    log.warn('topic-prefix', 'open-failed', { msgId: msg.messageId, err: String(err) });
    return undefined;
  }
  // The reply does not carry the thread id; the message it went under does.
  let threadId = await lookupMessageThreadId(channel, msg.messageId);
  if (!threadId && retryDelayMs > 0) {
    await new Promise((r) => setTimeout(r, retryDelayMs));
    threadId = await lookupMessageThreadId(channel, msg.messageId);
  }
  if (!threadId) log.warn('topic-prefix', 'thread-id-missing', { msgId: msg.messageId });
  return { threadId, openerId };
}

const spawned = new WeakSet<NormalizedMessage>();

/** Tag a message moved into a topic of its own, so its first run reads back the conversation it left. */
export function markSpawnedTopic(msg: NormalizedMessage): NormalizedMessage {
  spawned.add(msg);
  return msg;
}

export function isSpawnedTopic(msg: NormalizedMessage): boolean {
  return spawned.has(msg);
}
