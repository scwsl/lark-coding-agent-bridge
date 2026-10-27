/**
 * 召回统计（浅睡）: which notes and skills the agent actually opened. Every
 * run scans what the bridge's conversations did since the last scan — the
 * Markdown paths named in their tool calls — and counts the reads of each
 * note / skill per local day. Ranking the notes index, promoting a pooled
 * candidate into a note that gets read, and archiving notes nobody reads all
 * go by these counts: something kept because it kept being useful, not
 * because it was written down confidently.
 *
 * Only keys and counts are stored — never what was read, asked or answered.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentTranscript } from '../agent/transcript-builder';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import { exchangeHash } from './select';
import type { DreamSessionRecord } from './state';

export interface RecallItem {
  /** Reads per local day (`YYYY-MM-DD`), the last {@link KEEP_DAYS} days only. */
  days: Record<string, number>;
  /** Conversations it was read in, oldest first, at most {@link KEEP_SESSIONS}. */
  sessions: string[];
  /** Latest read (epoch ms). */
  lastAt: number;
}

interface RecallCursor {
  /** Exchanges of the conversation already counted. */
  scanned: number;
  /** Hash of the last counted exchange, to notice a rewritten transcript. */
  hash?: string;
  /** When the conversation was last scanned. */
  at: number;
}

interface RecallData {
  version: 1;
  /** The earliest read time counts cover: before it they say nothing. */
  since?: number;
  cursors: Record<string, RecallCursor>;
  items: Record<string, RecallItem>;
  /** Each note (`note:<scope>/<topic>`) of the knowledge repository as last observed. */
  seen?: Record<string, NoteSeen>;
}

interface NoteSeen {
  /** First observed. */
  first: number;
  /** Hash of its content when last observed. */
  hash: string;
  /** When its content was last seen to differ (or first observed). */
  changed: number;
}

export interface RecallScanResult {
  /** Conversations with something new to count. */
  sessions: number;
  exchanges: number;
  /** Note / skill reads counted (one per key per exchange). */
  reads: number;
}

export interface RecallTop {
  key: string;
  reads: number;
}

const KEEP_DAYS = 90;
const KEEP_SESSIONS = 20;
const DAY_MS = 86_400_000;

/**
 * The recall key of a path a tool call named: `note:<scope>/<topic>` for a
 * topic note of this profile's knowledge directory, `skill:<dir>` for any
 * `skills/<dir>/SKILL.md` (own or a library's), undefined for anything else.
 */
export function recallKey(path: string, knowledgeDir: string, home: string = homedir()): string | undefined {
  const full = path.startsWith('~/') ? join(home, path.slice(2)) : path;
  const notes = `${knowledgeDir.replace(/\/+$/, '')}/notes/`;
  if (full.startsWith(notes)) {
    const match = /^([\w.-]+)\/([a-z0-9][a-z0-9-]*)\.md$/.exec(full.slice(notes.length));
    return match ? `note:${match[1]}/${match[2]}` : undefined;
  }
  const skill = /\/skills\/([\w.:-]+)\/SKILL\.md$/.exec(full);
  return skill ? `skill:${skill[1]}` : undefined;
}

/** `YYYY-MM-DD` of a time in a time zone. */
export function localDay(at: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export class RecallStore {
  private data: RecallData = { version: 1, cursors: {}, items: {} };
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(text) as Partial<RecallData>;
      if (parsed && parsed.version === 1) {
        this.data = {
          version: 1,
          ...(typeof parsed.since === 'number' ? { since: parsed.since } : {}),
          cursors: parsed.cursors ?? {},
          items: parsed.items ?? {},
          ...(parsed.seen && typeof parsed.seen === 'object' ? { seen: validSeen(parsed.seen) } : {}),
        };
      }
    } catch (err) {
      log.warn('dream', 'recall-load-failed', { err: String(err) });
    }
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  /** The earliest time the counts cover; undefined before the first scan. */
  since(): number | undefined {
    return this.data.since;
  }

  /**
   * Count the reads of every conversation's exchanges since its cursor. A
   * conversation without a turn since its last scan is not read again. The
   * last exchange waits until the conversation has been idle `idleMs`, since
   * its answer may still be opening files.
   */
  async scan(input: {
    records: readonly DreamSessionRecord[];
    read: (record: DreamSessionRecord) => Promise<AgentTranscript | undefined>;
    knowledgeDir: string;
    now: number;
    timezone: string;
    idleMs: number;
    signal?: AbortSignal;
  }): Promise<RecallScanResult> {
    const result: RecallScanResult = { sessions: 0, exchanges: 0, reads: 0 };
    const live = new Set(input.records.map((record) => record.key));
    for (const key of Object.keys(this.data.cursors)) if (!live.has(key)) delete this.data.cursors[key];
    for (const record of input.records) {
      if (input.signal?.aborted) break;
      const cursor = this.data.cursors[record.key];
      if (cursor && cursor.at >= record.lastSeenAt) continue;
      let transcript: AgentTranscript | undefined;
      try {
        transcript = await input.read(record);
      } catch {
        transcript = undefined;
      }
      if (!transcript) continue;
      const exchanges = transcript.exchanges;
      const settled = transcript.lastActivityAt === undefined || input.now - transcript.lastActivityAt >= input.idleMs;
      const end = settled ? exchanges.length : Math.max(0, exchanges.length - 1);
      let start = cursor?.scanned ?? 0;
      const last = start > 0 ? exchanges[start - 1] : undefined;
      if (start > exchanges.length || (start > 0 && (!last || (cursor?.hash && exchangeHash(last) !== cursor.hash)))) {
        // Rewritten since the last scan: counting it again would count twice.
        start = end;
      }
      let counted = 0;
      for (const exchange of exchanges.slice(start, end)) {
        counted++;
        const at = exchange.at ?? transcript.lastActivityAt ?? input.now;
        const keys = new Set(
          (exchange.reads ?? []).map((path) => recallKey(path, input.knowledgeDir)).filter((key): key is string => Boolean(key)),
        );
        for (const key of keys) {
          this.count(key, record.key, at, input.timezone);
          result.reads++;
        }
        if (this.data.since === undefined || at < this.data.since) this.data.since = at;
      }
      const tail = exchanges[end - 1];
      this.data.cursors[record.key] = {
        scanned: end,
        ...(tail ? { hash: exchangeHash(tail) } : {}),
        // Not settled: look again next time even without a new turn.
        at: settled ? input.now : Math.min(input.now, record.lastSeenAt - 1),
      };
      if (counted > 0) {
        result.sessions++;
        result.exchanges += counted;
      }
    }
    if (this.data.since === undefined) this.data.since = input.now;
    this.prune(input.now, input.timezone);
    this.persist();
    return result;
  }

  /** Reads of `key` within the last `days` local days, today included. */
  readsWithin(key: string, days: number, now: number, timezone: string): number {
    return this.counter(days, now, timezone)(key);
  }

  /** {@link readsWithin} for many keys: the first day of the window worked out once. */
  counter(days: number, now: number, timezone: string): (key: string) => number {
    const from = localDay(now - (days - 1) * DAY_MS, timezone);
    return (key) => {
      const item = this.data.items[key];
      if (!item) return 0;
      let total = 0;
      for (const [day, count] of Object.entries(item.days)) if (day >= from) total += count;
      return total;
    };
  }

  /**
   * Record the notes the knowledge repository has tonight: when each was
   * first seen and when its content last changed. Notes no longer there
   * (merged, archived, deleted) are forgotten; one moved back starts afresh.
   */
  observeNotes(notes: ReadonlyArray<{ key: string; hash: string }>, now: number): void {
    const seen: Record<string, NoteSeen> = {};
    for (const note of notes) {
      const before = this.data.seen?.[note.key];
      seen[note.key] = !before
        ? { first: now, hash: note.hash, changed: now }
        : before.hash === note.hash
          ? before
          : { ...before, hash: note.hash, changed: now };
    }
    this.data.seen = seen;
    this.persist();
  }

  /**
   * Notes first seen, last changed and last read more than `days` days ago,
   * the longest unchanged first — none while the read counts do not yet
   * cover that long, since an unread note then may just be unmeasured.
   */
  archivable(days: number, now: number, timezone: string, limit: number): string[] {
    const cutoff = now - days * DAY_MS;
    if (this.data.since === undefined || this.data.since > cutoff) return [];
    const reads = this.counter(days, now, timezone);
    return Object.entries(this.data.seen ?? {})
      .filter(([key, note]) => note.first <= cutoff && note.changed <= cutoff && reads(key) === 0)
      .sort(([a, x], [b, y]) => x.changed - y.changed || a.localeCompare(b))
      .slice(0, limit)
      .map(([key]) => key);
  }

  item(key: string): RecallItem | undefined {
    return this.data.items[key];
  }

  /** The most read keys with a prefix (`note:` / `skill:`) within the last `days` days. */
  top(prefix: string, days: number, now: number, timezone: string, limit: number): RecallTop[] {
    const reads = this.counter(days, now, timezone);
    return Object.keys(this.data.items)
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, reads: reads(key) }))
      .filter((item) => item.reads > 0)
      .sort((a, b) => b.reads - a.reads || a.key.localeCompare(b.key))
      .slice(0, limit);
  }

  private count(key: string, session: string, at: number, timezone: string): void {
    const item = this.data.items[key] ?? { days: {}, sessions: [], lastAt: 0 };
    const day = localDay(at, timezone);
    item.days[day] = (item.days[day] ?? 0) + 1;
    if (!item.sessions.includes(session)) {
      item.sessions.push(session);
      if (item.sessions.length > KEEP_SESSIONS) item.sessions.splice(0, item.sessions.length - KEEP_SESSIONS);
    }
    item.lastAt = Math.max(item.lastAt, at);
    this.data.items[key] = item;
  }

  private prune(now: number, timezone: string): void {
    const oldest = localDay(now - KEEP_DAYS * DAY_MS, timezone);
    for (const [key, item] of Object.entries(this.data.items)) {
      for (const day of Object.keys(item.days)) if (day < oldest) delete item.days[day];
      if (Object.keys(item.days).length === 0) delete this.data.items[key];
    }
  }

  protected persist(): void {
    const snapshot = `${JSON.stringify(this.data)}\n`;
    this.saving = this.saving
      .then(() => writeFileAtomic(this.path, snapshot, { mode: 0o600 }))
      .catch((err: unknown) => log.fail('dream', err, { step: 'recall-persist' }));
  }
}

function validSeen(raw: object): Record<string, NoteSeen> {
  const out: Record<string, NoteSeen> = {};
  for (const [key, value] of Object.entries(raw)) {
    const note = value as Partial<NoteSeen> | null;
    if (note && typeof note.first === 'number' && typeof note.changed === 'number' && typeof note.hash === 'string') {
      out[key] = { first: note.first, hash: note.hash, changed: note.changed };
    }
  }
  return out;
}
