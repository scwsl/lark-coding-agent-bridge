import type { LarkChannel, MentionInfo, SendOptions } from '@larksuite/channel';
import type { Terminal } from '../card/run-state';
import { log } from '../core/logger';

/**
 * 长任务完成提醒. The reply card is created when a run starts and then updated
 * in place, and Feishu doesn't push edits — so a run that finishes twenty
 * minutes later does it silently, and the requester only finds out by looking.
 * A long run therefore ends with one short extra reply, which does push.
 */

export interface LongRunRequester {
  openId: string;
  name?: string;
}

export interface LongRunNoticeInput {
  /** Threshold; `undefined` = the feature is off. */
  thresholdMs: number | undefined;
  /** From the earliest message of the batch to now. */
  elapsedMs: number;
  terminal: Terminal | undefined;
  p2p: boolean;
  /** The answer went out as a message of its own (which already pushed). */
  answerIsNewMessage: boolean;
  /** Humans whose messages started the run; bots are never @-mentioned. */
  requesters: LongRunRequester[];
}

export interface LongRunNotice {
  text: string;
  mentions: MentionInfo[];
}

/**
 * The notice to send, or `undefined` when none is due: the run was short,
 * stopped by the user, or (in a DM) its answer already arrived as a new
 * message. In a group the notice @-mentions the requesters — groups are often
 * muted, and an @ still gets through — so a run only bots asked for gets none.
 */
export function planLongRunNotice(input: LongRunNoticeInput): LongRunNotice | undefined {
  if (input.thresholdMs === undefined || input.elapsedMs < input.thresholdMs) return undefined;
  const outcome =
    input.terminal === 'done'
      ? '✅ 任务完成'
      : input.terminal === 'error' || input.terminal === 'idle_timeout'
        ? '⚠️ 任务异常结束'
        : undefined;
  if (!outcome) return undefined;
  const text = `${outcome}（用时 ${formatElapsed(input.elapsedMs)}），${
    input.terminal === 'done' ? '结果' : '详情'
  }见上方回复。`;
  if (input.p2p) return input.answerIsNewMessage ? undefined : { text, mentions: [] };
  const seen = new Set<string>();
  const mentions: MentionInfo[] = [];
  for (const r of input.requesters) {
    if (!r.openId || seen.has(r.openId)) continue;
    seen.add(r.openId);
    mentions.push({ key: '', openId: r.openId, ...(r.name ? { name: r.name } : {}) });
  }
  return mentions.length > 0 ? { text, mentions } : undefined;
}

/** `12 分钟`, `1 小时 5 分钟` — whole minutes, at least one. */
export function formatElapsed(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

/** Best-effort: a failed notice is logged, never surfaced. */
export async function sendLongRunNotice(
  channel: LarkChannel,
  chatId: string,
  notice: LongRunNotice,
  sendOpts: SendOptions,
  scope: string,
): Promise<void> {
  try {
    await channel.send(
      chatId,
      { text: notice.text },
      { ...sendOpts, ...(notice.mentions.length > 0 ? { mentions: notice.mentions } : {}) },
    );
    log.info('outbound', 'long-run-notice', { scope, mentions: notice.mentions.length });
  } catch (err) {
    log.warn('outbound', 'long-run-notice-failed', {
      scope,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
