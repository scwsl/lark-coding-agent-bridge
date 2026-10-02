import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';
import type { RunRecord } from '../runtime/run-registry';

/** Why a run stopped without finishing. Decides the wording only. */
export type InterruptCause = 'restart' | 'shutdown';

function formatElapsed(ms: number): string {
  if (ms < 1000) return '不到 1 秒';
  const total = Math.round(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min === 0) return `${sec} 秒`;
  if (sec === 0) return `${min} 分`;
  return `${min} 分 ${sec} 秒`;
}

/** One line of the prompt, clipped — enough to recognise which task died. */
function clipPreview(preview: string, max = 60): string {
  const oneLine = preview.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}

export function interruptedNoticeText(
  rec: RunRecord,
  cause: InterruptCause,
  now: number = Date.now(),
  autoResume = false,
): string {
  const why = cause === 'shutdown' ? 'bridge 关闭' : 'bridge 重启';
  const elapsed = formatElapsed(Math.max(0, now - rec.startedAt));
  const preview = clipPreview(rec.promptPreview);
  const lines = [
    `⏹ 这轮任务被中断了（${why}），已经跑了 ${elapsed}。`,
    ...(preview ? [`任务：${preview}`] : []),
    autoResume
      ? `会话上下文没丢，bridge 恢复后会按任务台账自动继续（${rec.ledger}），不用再发「继续」。`
      : '会话上下文没丢——回一句「继续」我就接着往下做。',
  ];
  return lines.join('\n');
}

/**
 * Tell a chat that one of its runs died. Best-effort by design: this runs
 * either during shutdown or at boot, and a failed notice must never block
 * either path.
 */
export async function sendInterruptedNotice(
  channel: LarkChannel,
  rec: RunRecord,
  cause: InterruptCause,
  now: number = Date.now(),
  autoResume = false,
): Promise<void> {
  const text = interruptedNoticeText(rec, cause, now, autoResume);
  const opts = {
    replyTo: rec.originMessageId,
    ...(rec.threadId ? { replyInThread: true } : {}),
  };
  try {
    await channel.send(rec.chatId, { text }, opts);
  } catch (err) {
    // The origin message can be gone (recalled, or a chat the bot left).
    // Fall back to an unthreaded send before giving up.
    log.warn('interrupted-notice', 'reply-failed', {
      scope: rec.scope,
      err: String(err),
    });
    try {
      await channel.send(rec.chatId, { text });
    } catch (err2) {
      log.warn('interrupted-notice', 'send-failed', {
        scope: rec.scope,
        err: String(err2),
      });
    }
  }
}

/** Notify every record, one chat at a time, swallowing individual failures. */
export async function reportInterruptedRuns(
  channel: LarkChannel,
  records: RunRecord[],
  cause: InterruptCause,
  now: number = Date.now(),
  autoResumed: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (records.length === 0) return;
  log.info('interrupted-notice', 'reporting', { count: records.length, cause });
  for (const rec of records) {
    await sendInterruptedNotice(channel, rec, cause, now, autoResumed.has(rec.runId));
  }
}
