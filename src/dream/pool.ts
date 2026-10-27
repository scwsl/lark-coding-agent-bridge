/**
 * 候选池（深睡的门槛）: a note the agent only inferred is not written the
 * night it was proposed. It waits here until it proves itself — proposed
 * again on another day or in another conversation (directly, or grouped
 * with it by REM), or its target note gets read — and is dropped after
 * {@link POOL_MAX_AGE_DAYS} days without that. What an admin said in so many
 * words, what a run verified, and every convention (chat / profile memory)
 * skip the pool and are written the same night.
 *
 * The pool is a planning step: {@link planPool} works on a copy, and the
 * service saves the result only once the run's checkpoint is written — a
 * dropped batch reads its input again and must not have counted it already.
 */
import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { sanitizeScopeId } from '../knowledge/store';
import { writeFileAtomic } from '../platform/atomic-write';
import type { DreamSourceRef } from './prompt';
import { normalizeText, type MemoryAddition } from './proposal';
import { localDay } from './recall';

export interface PoolEntry {
  /** Stable key: the hash of the first proposal. */
  key: string;
  scopeId: string;
  note: string;
  /** The latest wording. */
  text: string;
  reason: string;
  sources: DreamSourceRef[];
  /** Every proposal hash folded into this entry. */
  hashes: string[];
  firstAt: number;
  lastAt: number;
  /** Local days it was proposed on (from its source turns). */
  days: string[];
  /** Conversations it came from. */
  sessions: string[];
}

export interface PoolCandidate {
  addition: MemoryAddition;
  /** Local days of its source turns. */
  days: string[];
  /** Conversations of its source turns. */
  sessions: string[];
}

/** REM: tonight's candidates (by index) and pool entries (by key) that are about the same thing. */
export interface PoolTheme {
  candidates: number[];
  entries: string[];
}

export interface PoolPlan {
  /** Promoted tonight: written like any other addition. */
  promote: MemoryAddition[];
  /** Every proposal hash behind the promoted ones, to mark as published. */
  published: string[];
  /** The pool after tonight. */
  entries: PoolEntry[];
  entered: number;
  expired: number;
}

export const POOL_MAX_AGE_DAYS = 30;
/** Read window of a candidate's target note. */
export const POOL_READ_DAYS = 30;
const MIN_DAYS = 2;
const MIN_SESSIONS = 2;
const MIN_READS = 1;
const MAX_ENTRIES = 500;
const MAX_TRACKED = 10;
/** Same note, this close in wording: the same candidate proposed again. */
const SIMILAR = 0.5;
const DAY_MS = 86_400_000;

/** Where an inferred note goes: the pool. Everything else is written the same night. */
export function needsPool(addition: MemoryAddition): boolean {
  return addition.target === 'note' && (addition.evidence ?? 'inferred') === 'inferred';
}

/** The chat a scope belongs to: a topic's family is its group. */
export function scopeFamily(scopeId: string): string {
  const clean = sanitizeScopeId(scopeId);
  const at = clean.indexOf('_omt_');
  return at < 0 ? clean : clean.slice(0, at);
}

/**
 * Tonight's pool: expire the old, fold tonight's candidates in (same
 * proposal, a REM theme, or the same note in near the same words), and
 * promote whatever has now recurred or whose note is being read.
 */
export function planPool(input: {
  entries: readonly PoolEntry[];
  candidates: readonly PoolCandidate[];
  themes?: readonly PoolTheme[];
  now: number;
  timezone: string;
  /** Reads of a note (`<scope>/<topic>`, sanitized scope) within {@link POOL_READ_DAYS}. */
  reads: (note: string) => number;
}): PoolPlan {
  const { now } = input;
  const cutoff = now - POOL_MAX_AGE_DAYS * DAY_MS;
  const entries = input.entries.filter((entry) => entry.firstAt >= cutoff).map(cloneEntry);
  let expired = input.entries.length - entries.length;
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const recurring = new Set<string>();
  const placed = new Set<number>();
  let entered = 0;

  const fold = (entry: PoolEntry, candidate: PoolCandidate, scopeId: string) => {
    const { addition } = candidate;
    entry.scopeId = scopeId;
    entry.note = addition.note ?? entry.note;
    entry.text = addition.text;
    entry.reason = addition.reason;
    entry.sources = addition.sources;
    if (!entry.hashes.includes(addition.hash)) entry.hashes.push(addition.hash);
    entry.lastAt = now;
    entry.days = merge(entry.days, candidate.days);
    entry.sessions = merge(entry.sessions, candidate.sessions);
  };
  const open = (candidate: PoolCandidate, scopeId: string): PoolEntry => {
    const { addition } = candidate;
    const entry: PoolEntry = {
      key: addition.hash,
      scopeId,
      note: addition.note ?? '',
      text: addition.text,
      reason: addition.reason,
      sources: addition.sources,
      hashes: [addition.hash],
      firstAt: now,
      lastAt: now,
      days: merge([], candidate.days),
      sessions: merge([], candidate.sessions),
    };
    entries.push(entry);
    byKey.set(entry.key, entry);
    entered++;
    return entry;
  };

  // REM themes first: within a theme, one entry per chat; a theme spanning
  // several conversations or days counts as recurrence for all its members.
  for (const theme of input.themes ?? []) {
    const members = theme.candidates.filter((index) => input.candidates[index] && !placed.has(index));
    const known = theme.entries.map((key) => byKey.get(key)).filter((entry): entry is PoolEntry => Boolean(entry));
    if (members.length + known.length < 2) continue;
    const families = new Map<string, { candidates: number[]; entries: PoolEntry[] }>();
    for (const index of members) {
      const family = scopeFamily(input.candidates[index]!.addition.scopeId);
      const group = families.get(family) ?? { candidates: [], entries: [] };
      group.candidates.push(index);
      families.set(family, group);
    }
    for (const entry of known) {
      const family = scopeFamily(entry.scopeId);
      const group = families.get(family) ?? { candidates: [], entries: [] };
      group.entries.push(entry);
      families.set(family, group);
    }
    const touched: PoolEntry[] = [];
    for (const [family, group] of families) {
      const scopes = new Set([
        ...group.candidates.map((index) => sanitizeScopeId(input.candidates[index]!.addition.scopeId)),
        ...group.entries.map((entry) => sanitizeScopeId(entry.scopeId)),
      ]);
      // Several topics of one chat on the same thing: it belongs to the chat.
      const scopeFor = (own: string) => (scopes.size > 1 ? family : own);
      let base = group.entries[0];
      for (const other of group.entries.slice(1)) {
        if (!base) break;
        base.hashes = merge(base.hashes, other.hashes);
        base.days = merge(base.days, other.days);
        base.sessions = merge(base.sessions, other.sessions);
        base.firstAt = Math.min(base.firstAt, other.firstAt);
        removeEntry(entries, byKey, other);
      }
      for (const index of group.candidates) {
        const candidate = input.candidates[index]!;
        if (base) fold(base, candidate, scopeFor(candidate.addition.scopeId));
        else base = open(candidate, scopeFor(candidate.addition.scopeId));
        placed.add(index);
      }
      if (base) {
        if (scopes.size > 1) base.scopeId = family;
        touched.push(base);
      }
    }
    const sessions = new Set(touched.flatMap((entry) => entry.sessions));
    const days = new Set(touched.flatMap((entry) => entry.days));
    if (sessions.size >= MIN_SESSIONS || days.size >= MIN_DAYS) for (const entry of touched) recurring.add(entry.key);
  }

  // The rest: the same proposal again, or the same note in near the same words.
  input.candidates.forEach((candidate, index) => {
    if (placed.has(index)) return;
    const { addition } = candidate;
    const family = scopeFamily(addition.scopeId);
    const key = normalizeText(addition.text);
    const match =
      entries.find((entry) => entry.hashes.includes(addition.hash)) ??
      entries.find(
        (entry) => entry.note === addition.note && scopeFamily(entry.scopeId) === family && similarity(normalizeText(entry.text), key) >= SIMILAR,
      );
    if (match) {
      const scope = sanitizeScopeId(match.scopeId) === sanitizeScopeId(addition.scopeId) ? addition.scopeId : family;
      fold(match, candidate, scope);
    } else open(candidate, addition.scopeId);
  });

  const promote: MemoryAddition[] = [];
  const published: string[] = [];
  const kept: PoolEntry[] = [];
  for (const entry of entries) {
    const read = input.reads(`${sanitizeScopeId(entry.scopeId)}/${entry.note}`) >= MIN_READS;
    if (entry.sessions.length >= MIN_SESSIONS || entry.days.length >= MIN_DAYS || recurring.has(entry.key) || read) {
      promote.push({
        kind: 'add',
        scopeId: entry.scopeId,
        target: 'note',
        note: entry.note,
        text: entry.text,
        reason: entry.reason,
        sources: entry.sources,
        evidence: 'inferred',
        hash: entry.hashes[entry.hashes.length - 1] ?? entry.key,
      });
      published.push(...entry.hashes);
    } else kept.push(entry);
  }
  // A bound on the file: the oldest go first.
  kept.sort((a, b) => a.firstAt - b.firstAt);
  if (kept.length > MAX_ENTRIES) {
    expired += kept.length - MAX_ENTRIES;
    kept.splice(0, kept.length - MAX_ENTRIES);
  }
  return { promote, published, entries: kept, entered, expired };
}

/** Local days and conversations of an addition's source turns. */
export function candidateOf(
  addition: MemoryAddition,
  turnAt: (sessionKey: string, index: number) => number | undefined,
  now: number,
  timezone: string,
): PoolCandidate {
  const sessions = merge(
    [],
    addition.sources.map((source) => source.sessionKey),
  );
  const days = merge(
    [],
    addition.sources.map((source) => localDay(turnAt(source.sessionKey, source.index) ?? now, timezone)),
  );
  return { addition, days, sessions };
}

export class CandidatePool {
  private data: PoolEntry[] = [];
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
      const parsed = JSON.parse(text) as { version?: number; entries?: PoolEntry[] };
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) this.data = parsed.entries;
    } catch (err) {
      log.warn('dream', 'pool-load-failed', { err: String(err) });
    }
  }

  entries(): readonly PoolEntry[] {
    return this.data;
  }

  /** Keep tonight's plan: only after the run's checkpoint. */
  replace(entries: readonly PoolEntry[]): void {
    this.data = entries.map(cloneEntry);
    const snapshot = `${JSON.stringify({ version: 1, entries: this.data })}\n`;
    this.saving = this.saving
      .then(() => writeFileAtomic(this.path, snapshot, { mode: 0o600 }))
      .catch((err: unknown) => log.fail('dream', err, { step: 'pool-persist' }));
  }

  async flush(): Promise<void> {
    await this.saving;
  }
}

function cloneEntry(entry: PoolEntry): PoolEntry {
  return { ...entry, sources: [...entry.sources], hashes: [...entry.hashes], days: [...entry.days], sessions: [...entry.sessions] };
}

function removeEntry(entries: PoolEntry[], byKey: Map<string, PoolEntry>, entry: PoolEntry): void {
  const at = entries.indexOf(entry);
  if (at >= 0) entries.splice(at, 1);
  byKey.delete(entry.key);
}

/** Union, order kept, the latest {@link MAX_TRACKED}. */
function merge(into: readonly string[], more: readonly string[]): string[] {
  const out = [...into];
  for (const item of more) if (item && !out.includes(item)) out.push(item);
  return out.slice(-MAX_TRACKED);
}

/** Jaccard similarity of character bigrams — wording, not meaning; fine for one note's entries. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (text: string) => {
    const set = new Set<string>();
    const clean = text.replace(/\s+/g, '');
    for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
    return set;
  };
  const x = grams(a);
  const y = grams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared++;
  return shared / (x.size + y.size - shared);
}
