import type { AgentSessionProbe } from '../agent/session-probe';
import { promptSection } from '../agent/prompt';
import type { SmartSessionSettings } from '../config/schema';

/**
 * 会话智能压缩 — when the conversation a new message would resume is better
 * left behind. Two signals, both cheap:
 *
 * - idle: the prompt cache has long expired, so resuming re-writes the whole
 *   context at cache-write price before doing anything; with a large context
 *   that one call costs more than starting over (`idle-large`), and after a
 *   long break the old context is rarely what the user is back for
 *   (`idle-long`).
 * - the agent said so: it ended its previous answer with
 *   {@link NEW_SESSION_MARKER} because the task was finished
 *   (`agent-done`).
 *
 * Rotating archives the conversation (it stays in `/resume`) and starts the
 * next turn fresh, with a short hand-off note so the agent knows there was one.
 */
export type RotationReason = 'idle-large' | 'idle-long' | 'agent-done';

export interface RotationVerdict {
  reason: RotationReason;
  /** Minutes since the conversation's last model response, when known. */
  idleMinutes?: number;
  contextTokens?: number;
  /** One-line summary of the archived conversation, when the agent gave one. */
  summary?: string;
  lastUserText?: string;
}

/** A rotation the agent asked for at the end of its last answer, applied on the next message. */
export interface PendingRotation {
  summary?: string;
  /**
   * The conversation (session / thread id) the request closes. The next
   * message honors it only while it would still resume that conversation —
   * after `/new`, `/resume` or `/cd` the request no longer applies.
   */
  handle?: string;
}

export interface DecideRotationInput {
  settings: SmartSessionSettings;
  probe: AgentSessionProbe | undefined;
  pending?: PendingRotation;
  /** The conversation the next message would resume; a pending request for another one is ignored. */
  resumeHandle?: string;
  now: number;
}

export function decideRotation(input: DecideRotationInput): RotationVerdict | undefined {
  const { settings, probe, now } = input;
  const pending =
    input.pending?.handle && input.resumeHandle && input.pending.handle !== input.resumeHandle
      ? undefined
      : input.pending;
  const idleMinutes =
    probe?.lastActivityAt !== undefined ? Math.max(0, Math.floor((now - probe.lastActivityAt) / 60_000)) : undefined;
  const base = {
    ...(idleMinutes !== undefined ? { idleMinutes } : {}),
    ...(probe?.contextTokens !== undefined ? { contextTokens: probe.contextTokens } : {}),
    ...(probe?.lastUserText ? { lastUserText: probe.lastUserText } : {}),
  };
  if (pending) {
    return { reason: 'agent-done', ...base, ...(pending.summary ? { summary: pending.summary } : {}) };
  }
  if (idleMinutes === undefined) return undefined;
  if (idleMinutes >= settings.hardIdleMinutes) return { reason: 'idle-long', ...base };
  if (
    idleMinutes >= settings.idleMinutes &&
    probe?.contextTokens !== undefined &&
    probe.contextTokens >= settings.minContextTokens
  ) {
    return { reason: 'idle-large', ...base };
  }
  return undefined;
}

/**
 * Marker the agent may end an answer with to close the conversation once the
 * reply is out: `[[NEW_SESSION]]`, optionally with a one-line summary —
 * `[[NEW_SESSION: 排查完 ALF… 的校准卡住问题]]`. The bridge strips it from
 * what the user sees.
 */
export const NEW_SESSION_MARKER = '[[NEW_SESSION]]';

const TRAILING_MARKER = /\s*\[\[NEW_SESSION(?:[:：]\s*([^\]\n]*?))?\s*\]\]\s*$/;
/** A marker still arriving at the end of a stream: `[`, `[[NEW_`, `[[NEW_SESSION: 排查`… */
const TRAILING_PARTIAL = /\s*\[(?:\[(?:N(?:E(?:W(?:_(?:S(?:E(?:S(?:S(?:I(?:O(?:N(?:[:：][^\]\n]*)?)?)?)?)?)?)?)?)?)?)?)?)?$/;

/** The agent's request in `text`, if the text ends with the marker. */
export function newSessionRequest(text: string | undefined): PendingRotation | undefined {
  if (!text) return undefined;
  const m = TRAILING_MARKER.exec(text);
  if (!m) return undefined;
  const summary = m[1]?.trim();
  return summary ? { summary: summary.slice(0, 200) } : {};
}

/** `text` without a trailing marker — complete, or still streaming in when `streaming`. */
export function stripNewSessionMarker(text: string, streaming = false): string {
  const done = text.replace(TRAILING_MARKER, '');
  if (done !== text) return done;
  if (!streaming) return text;
  const m = TRAILING_PARTIAL.exec(text);
  // A lone trailing `[` is ordinary text far more often than a marker's start;
  // only hide prefixes that are unmistakably the marker (`[[` onwards).
  return m && m[0].trim().length >= 2 ? text.slice(0, m.index) : text;
}

/** Standing instruction for the agent while 会话智能压缩 is on. */
export const SMART_SESSION_INSTRUCTION =
  '本会话开启了「会话智能压缩」：当你判断这件事已经彻底做完、后续大概率是新话题时，在最终回复的最后单独一行写 ' +
  '`[[NEW_SESSION: 一句话概括这段会话做了什么]]`，bridge 会在回复发出后归档当前会话（/resume 可找回），下一条消息从新会话开始。' +
  '任务还没做完、用户可能追问、或你不确定时不要写。这个标记对用户不可见，不要在正文里提到它。';

/** Hand-off note prepended to the first prompt of the fresh session. */
export function handoffSection(verdict: RotationVerdict): string {
  return promptSection('session_handoff', {
    note:
      '上一段会话已由 bridge 自动归档（会话智能压缩），这是一个新会话，看不到之前的上下文。' +
      '用户如果提到之前的内容，请提示对方用 /resume 找回旧会话。',
    reason: verdict.reason,
    ...(verdict.idleMinutes !== undefined ? { idleMinutes: verdict.idleMinutes } : {}),
    ...(verdict.summary ? { previousSummary: verdict.summary } : {}),
    ...(verdict.lastUserText ? { previousLastRequest: verdict.lastUserText.slice(0, 200) } : {}),
  });
}

/** One grey line under the answer telling the user the conversation was renewed. */
export function rotationNotice(verdict: RotationVerdict): string {
  const facts: string[] = [];
  if (verdict.reason === 'agent-done') facts.push('上一件事已完成');
  else if (verdict.idleMinutes !== undefined) facts.push(`上次对话在 ${humanIdle(verdict.idleMinutes)}前`);
  if (verdict.contextTokens !== undefined) facts.push(`上下文约 ${humanTokens(verdict.contextTokens)} token`);
  const why = facts.length > 0 ? `（${facts.join('，')}）` : '';
  return `已自动开启新会话${why}，旧会话可用 /resume 找回`;
}

export function humanIdle(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

export function humanTokens(tokens: number): string {
  if (tokens >= 10_000) return `${Math.round(tokens / 10_000)} 万`;
  return `${Math.round(tokens / 1000)}k`;
}
