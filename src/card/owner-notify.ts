import type { MentionInfo } from '@larksuite/channel';
import type { Terminal } from './run-state';
import { briefOf, clipBrief as clip, stripBriefMarker } from '../session/brief-marker';
import { stripTitleMarker } from './title-marker';
import type { LongRunRequester } from '../bot/long-run-notice';

export { briefOf, stripBriefMarker };

/**
 * 结果提醒主人 (ownerNotifyChats). In the chats the owner lists — topic groups
 * where scheduled jobs and dev tasks report back — every finished run ends with
 * one short reply that @-mentions the owner and says in a line what happened.
 * The reply card is updated in place and Feishu doesn't push edits, so without
 * this the owner has to go looking for results.
 *
 * The line comes from the agent: it ends its answer with `[[BRIEF: …]]`, which
 * the bridge strips from what is shown. Without one, the answer's first
 * meaningful line stands in.
 */

/** First meaningful line of an answer, markdown stripped — the fallback brief. */
export function fallbackBrief(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const raw of stripTitleMarker(stripBriefMarker(text)).split('\n')) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim();
    if (!line || /^[-=|:\s]+$/.test(line) || line.startsWith('```')) continue;
    return clip(line);
  }
  return undefined;
}

/** Standing instruction for runs in an owner-notify chat. */
export const OWNER_BRIEF_INSTRUCTION =
  '这个群开启了「结果提醒主人」：本轮结束后 bridge 会在话题里单独发一条消息 @ 主人，附上一句话简述。' +
  '请在最终回复的最后单独一行写 `[[BRIEF: 一句话简述本轮结果]]`（50 字以内，写结论和要主人处理的事，比如「巡检完成，2 台设备双中心在线，需确认」），' +
  '如果还要写 `[[NEW_SESSION…]]`，把 BRIEF 放在它前面。这个标记对用户不可见，不要在正文里提到它；不要自己再发 @ 主人的消息。';

export interface OwnerNoticeInput {
  ownerId: string;
  terminal: Terminal | undefined;
  /** The run's answer, markers included. */
  answerText: string | undefined;
  /** Error text for a failed run. */
  error?: string;
  /** Humans whose messages started the run; they are @-mentioned alongside the owner. */
  requesters?: LongRunRequester[];
}

export interface OwnerNotice {
  text: string;
  mentions: MentionInfo[];
}

/**
 * The notice for a finished run, or `undefined` when none is due: the run was
 * stopped by hand, paused on quota (the pause notice speaks for itself) or
 * answered nothing (`[[NO_REPLY]]`).
 */
export function planOwnerNotice(input: OwnerNoticeInput): OwnerNotice | undefined {
  const failed = input.terminal === 'error' || input.terminal === 'idle_timeout';
  if (input.terminal !== 'done' && !failed) return undefined;
  const answer = input.answerText?.trim();
  if (!failed && (!answer || answer === '[[NO_REPLY]]')) return undefined;
  const brief = briefOf(answer) ?? fallbackBrief(answer);
  let text: string;
  if (failed) {
    const reason = input.terminal === 'idle_timeout' ? '长时间无响应被中止' : clip(input.error ?? '异常结束');
    text = `⚠️ 任务异常结束：${reason}${brief ? `\n简述：${brief}` : ''}`;
  } else {
    text = `✅ ${brief ?? '已完成'}`;
  }
  const seen = new Set<string>();
  const mentions: MentionInfo[] = [];
  for (const r of [{ openId: input.ownerId }, ...(input.requesters ?? [])] as LongRunRequester[]) {
    if (!r.openId || seen.has(r.openId)) continue;
    seen.add(r.openId);
    mentions.push({ key: '', openId: r.openId, ...(r.name ? { name: r.name } : {}) });
  }
  return { text, mentions };
}
