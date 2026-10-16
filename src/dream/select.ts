import { createHash } from 'node:crypto';
import type { AgentTranscript, TranscriptExchange } from '../agent/session-transcript';
import type { DreamSettings } from '../config/schema';
import type { DreamSessionRecord } from './state';

/**
 * Which conversations a 课堂精练 run reads, and how much of each.
 *
 * Input is only what the bridge itself recorded — conversations it ran (the
 * session catalog, mirrored into {@link DreamSessionRecord}) — read through
 * the agent's own transcript of exactly that conversation. Nothing else on the
 * host is scanned.
 */

export interface DreamSessionInput {
  record: DreamSessionRecord;
  /** Batch-wide label of this conversation in prompts and PRs: `S1`, `S2`… */
  ref: string;
  /** The new exchanges, in order. */
  exchanges: TranscriptExchange[];
  /** Cursor after this run: index of the last included exchange, and its hash. */
  nextConsumed: number;
  nextHash: string;
  /** The transcript no longer matched the cursor and was read from the start. */
  restarted: boolean;
}

export interface DreamScopeInput {
  scopeId: string;
  sessions: DreamSessionInput[];
}

export interface DreamSelection {
  scopes: DreamScopeInput[];
  /** Conversations with nothing new: their cursor only gets a fresh timestamp. */
  idle: DreamSessionRecord[];
  deferred: Array<{ key: string; reason: string }>;
}

/** Characters an exchange costs against the run's input budget. */
export const USER_EXCERPT_CHARS = 3_000;
export const ASSISTANT_EXCERPT_CHARS = 4_000;

/** Scopes that are not chats: scheduled jobs, meetings, doc comments, dream runs. */
const NON_CHAT_SCOPE = /^(?:cron|meeting|comment|dream):/;

export function isChatScope(scopeId: string): boolean {
  return scopeId.length > 0 && !NON_CHAT_SCOPE.test(scopeId);
}

export function exchangeHash(exchange: TranscriptExchange): string {
  return createHash('sha256')
    .update(`${exchange.index}\n${exchange.user}\n${exchange.assistant}`)
    .digest('hex')
    .slice(0, 16);
}

export function exchangeCost(exchange: TranscriptExchange): number {
  return Math.min(exchange.user.length, USER_EXCERPT_CHARS) + Math.min(exchange.assistant.length, ASSISTANT_EXCERPT_CHARS);
}

/**
 * How much unread conversation is waiting, measured the way a run would read
 * it — for 自动整理's 材料够 gate. Reads the same transcripts, moves nothing.
 * `oldestAt` is when the oldest still-unread conversation was first seen.
 */
export async function measureNewInput(opts: {
  records: readonly DreamSessionRecord[];
  settings: DreamSettings;
  read: (record: DreamSessionRecord) => Promise<AgentTranscript | undefined>;
}): Promise<{ scopes: number; sessions: number; chars: number; oldestAt?: number }> {
  const scopes = new Set<string>();
  let sessions = 0;
  let chars = 0;
  let oldestAt: number | undefined;
  for (const record of candidateRecords(opts.records, opts.settings)) {
    const transcript = await opts.read(record);
    if (!transcript) continue;
    const fresh = transcript.exchanges.slice(resumePoint(record, transcript).start);
    if (fresh.length === 0) continue;
    sessions++;
    scopes.add(record.scopeId);
    for (const exchange of fresh) chars += exchangeCost(exchange);
    const since = record.consumedAt ?? record.firstSeenAt;
    oldestAt = oldestAt === undefined ? since : Math.min(oldestAt, since);
  }
  return { scopes: scopes.size, sessions, chars, ...(oldestAt !== undefined ? { oldestAt } : {}) };
}

/** Chat conversations in the allowed scopes with turns since they were last read, newest first. */
function candidateRecords(records: readonly DreamSessionRecord[], settings: DreamSettings): DreamSessionRecord[] {
  const allowed = settings.scopes ? new Set(settings.scopes) : undefined;
  return records
    .filter((record) => isChatScope(record.scopeId) && (!allowed || allowed.has(record.scopeId)))
    // Nothing ran in it since it was last read: no need to open the transcript.
    .filter((record) => record.consumedAt === undefined || record.lastSeenAt > record.consumedAt)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * Where reading resumes: after the cursor, or from the start when the
 * transcript no longer matches it (rewritten or replaced).
 */
function resumePoint(record: DreamSessionRecord, transcript: AgentTranscript): { start: number; restarted: boolean } {
  const start = record.consumed;
  if (start <= 0) return { start: 0, restarted: false };
  const last = transcript.exchanges[start - 1];
  if (!last || (record.consumedHash && exchangeHash(last) !== record.consumedHash)) return { start: 0, restarted: true };
  return { start, restarted: false };
}

export async function selectDreamInputs(opts: {
  records: readonly DreamSessionRecord[];
  settings: DreamSettings;
  now: number;
  /** A run is in flight for the scope right now. */
  isBusy: (scopeId: string) => boolean;
  read: (record: DreamSessionRecord) => Promise<AgentTranscript | undefined>;
}): Promise<DreamSelection> {
  const { settings, now } = opts;
  const candidates = candidateRecords(opts.records, settings);

  const byScope = new Map<string, DreamSessionInput[]>();
  const idle: DreamSessionRecord[] = [];
  const deferred: Array<{ key: string; reason: string }> = [];
  let budget = settings.maxInputChars;
  let taken = 0;
  let refCounter = 0;
  const minIdleMs = settings.minIdleMinutes * 60_000;

  for (const record of candidates) {
    if (taken >= settings.maxSessions) {
      deferred.push({ key: record.key, reason: '超出本轮会话数上限' });
      continue;
    }
    if (opts.isBusy(record.scopeId)) {
      deferred.push({ key: record.key, reason: '会话正在运行' });
      continue;
    }
    const transcript = await opts.read(record);
    if (!transcript) {
      deferred.push({ key: record.key, reason: '找不到或读不了这个会话的转录' });
      continue;
    }
    // A rewritten or replaced transcript is read again from the start; the
    // duplicate check at publish keeps already-merged facts out.
    const { start, restarted } = resumePoint(record, transcript);
    const fresh = transcript.exchanges.slice(start);
    if (fresh.length === 0) {
      idle.push(record);
      continue;
    }
    const lastActivity = transcript.lastActivityAt ?? record.lastSeenAt;
    if (now - lastActivity < minIdleMs) {
      deferred.push({ key: record.key, reason: `仍在进行（空闲不足 ${settings.minIdleMinutes} 分钟）` });
      continue;
    }
    const included: TranscriptExchange[] = [];
    for (const exchange of fresh) {
      const cost = exchangeCost(exchange);
      if (cost > budget) break;
      budget -= cost;
      included.push(exchange);
    }
    if (included.length === 0) {
      deferred.push({ key: record.key, reason: '超出本轮输入预算' });
      continue;
    }
    taken++;
    refCounter++;
    const last = included.at(-1)!;
    const input: DreamSessionInput = {
      record,
      ref: `S${refCounter}`,
      exchanges: included,
      nextConsumed: last.index,
      nextHash: exchangeHash(last),
      restarted,
    };
    const list = byScope.get(record.scopeId) ?? [];
    list.push(input);
    byScope.set(record.scopeId, list);
  }

  return {
    scopes: [...byScope.entries()].map(([scopeId, sessions]) => ({ scopeId, sessions })),
    idle,
    deferred,
  };
}
