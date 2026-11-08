/**
 * Rest days on the bridge's clock — weekends and China's statutory holidays,
 * with the weekend days moved to work (调休上班) counting as workdays — for the
 * accounts' rest-day switch lines (`offDayLines`, owner's choice 2026-11-08:
 * the accounts' owners hardly use them on rest days, so runs may go further).
 *
 * The holiday calendar is NateScarlet/holiday-cn (per the State Council
 * notices), cached per year as `<dir>/<year>.json`. A year without data — not
 * fetched yet, or not announced — falls back to Saturday and Sunday.
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { log } from '../../core/logger';
import { writeFileAtomic } from '../../platform/atomic-write';

const SOURCES = [
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{y}.json',
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{y}.json',
];
/** How often a missing (or not yet announced) year is fetched again. */
const RETRY_MS = 6 * 3_600_000;
/** A cached year is fetched again after this long (notices are amended now and then). */
const STALE_MS = 7 * 24 * 3_600_000;

interface YearDays {
  stamp: number;
  /** `YYYY-MM-DD` → is a rest day; only the days the notices name. */
  days: Map<string, boolean>;
}

const years = new Map<string, YearDays | null>();
const fetching = new Map<string, number>();

function localDate(now: number): { year: number; key: string; weekday: number } {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    year: d.getFullYear(),
    key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    weekday: d.getDay(),
  };
}

/** The `days` of a holiday-cn year file; undefined when malformed or empty. */
export function parseHolidayYear(text: string): Map<string, boolean> | undefined {
  try {
    const raw = JSON.parse(text) as { days?: unknown };
    if (!Array.isArray(raw.days) || raw.days.length === 0) return undefined;
    const days = new Map<string, boolean>();
    for (const item of raw.days as Array<{ date?: unknown; isOffDay?: unknown }>) {
      if (typeof item?.date === 'string' && typeof item.isOffDay === 'boolean') days.set(item.date, item.isOffDay);
    }
    return days.size > 0 ? days : undefined;
  } catch {
    return undefined;
  }
}

function yearFile(dir: string, year: number): string {
  return join(dir, `${year}.json`);
}

function readYear(dir: string, year: number): YearDays | null {
  const file = yearFile(dir, year);
  let stamp: number;
  try {
    stamp = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const key = file;
  const cached = years.get(key);
  if (cached && cached.stamp === stamp) return cached;
  let days: Map<string, boolean> | undefined;
  try {
    days = parseHolidayYear(readFileSync(file, 'utf8'));
  } catch {
    days = undefined;
  }
  const entry = days ? { stamp, days } : null;
  years.set(key, entry);
  return entry;
}

/** `now` falls on a rest day: a statutory holiday, or a weekend day not moved to work. */
export function isOffDay(now: number, dir: string): boolean {
  const { year, key, weekday } = localDate(now);
  const named = readYear(dir, year)?.days.get(key);
  if (named !== undefined) return named;
  return weekday === 0 || weekday === 6;
}

/**
 * Fetch this year's calendar (and next year's from December) when the cache
 * lacks it or is a week old. Fire and forget; never throws, at most one try
 * per year per {@link RETRY_MS}.
 */
export function refreshHolidays(dir: string, now = Date.now()): void {
  const { year } = localDate(now);
  const wanted = new Date(now).getMonth() === 11 ? [year, year + 1] : [year];
  for (const y of wanted) {
    let age = Infinity;
    try {
      age = now - statSync(yearFile(dir, y)).mtimeMs;
    } catch {
      // Not cached yet.
    }
    if (age < STALE_MS && readYear(dir, y)) continue;
    const key = `${dir}:${y}`;
    if ((fetching.get(key) ?? 0) > now - RETRY_MS) continue;
    fetching.set(key, now);
    void fetchYear(dir, y);
  }
}

async function fetchYear(dir: string, year: number): Promise<void> {
  for (const source of SOURCES) {
    try {
      const res = await fetch(source.replace('{y}', String(year)), { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const text = await res.text();
      // Not announced yet: holiday-cn has an empty list; keep the weekend fallback.
      if (!parseHolidayYear(text)) return;
      mkdirSync(dir, { recursive: true });
      await writeFileAtomic(yearFile(dir, year), text);
      log.info('claude-accounts', 'holidays-cached', { year });
      return;
    } catch (err) {
      log.warn('claude-accounts', 'holidays-fetch-failed', { year, source, err: String(err) });
    }
  }
}
