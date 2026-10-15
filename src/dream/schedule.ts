import type { DreamAutoSettings } from '../config/schema';

/**
 * When 自动整理 may start a run. Not a daily clock: a run needs enough new
 * material, enough time since the last completed run, the previous batch
 * reviewed, the allowed hours and an idle profile. This file holds the pure
 * parts — the clock and the cheap gates; the service adds the ones that need
 * I/O (profile activity, transcripts, open PRs, quota).
 */

export type DreamAutoBlock =
  | 'off'
  | 'paused'
  | 'outside-window'
  | 'window-used'
  | 'backoff'
  | 'interval'
  | 'running'
  | 'busy'
  | 'recent-activity'
  | 'no-remote'
  | 'restricted'
  | 'material'
  | 'backlog'
  | 'locked'
  | 'quota';

/** The outcome of one automatic check — kept in the state file so any viewer can show why nothing ran. */
export interface DreamAutoCheck {
  at: number;
  /** A run was started by this check. */
  started?: string;
  block?: DreamAutoBlock;
  /** Why not, in words; absent when {@link started}. */
  reason?: string;
  material?: DreamMaterial;
  openPrs?: number;
  quota?: { percent: number; label: string } | { unknown: true };
}

export interface DreamMaterial {
  /** Chat scopes with new exchanges. */
  scopes: number;
  sessions: number;
  /** Characters of the new exchanges, as the run would count them. */
  chars: number;
  /** The fallback (max interval) made a small amount enough. */
  fallback?: boolean;
}

export interface DreamAutoLedger {
  /** {@link dreamWindowAt} key of the window the last automatic run started in. */
  lastWindowKey?: string;
  /** Automatic runs that failed in a row; reset by any run that succeeds, manual ones included. */
  consecutiveFailures: number;
  /** When the last of those failures ended. */
  lastFailedAt?: number;
  /** End of the last run that read input and finished (PR opened or nothing worth submitting). */
  lastCompletedAt?: number;
  lastCheck?: DreamAutoCheck;
}

const DAY_MS = 86_400_000;

/**
 * Where `now` falls relative to the allowed hours in `timezone`. `key` names
 * the window occurrence — the local date it opened on — so "one run per
 * window" holds across midnight for a window like `22:00-06:00`.
 */
export function dreamWindowAt(
  now: number,
  window: DreamAutoSettings['window'],
  timezone: string,
): { inside: boolean; key: string } {
  const { date, minutes } = localClock(now, timezone);
  if (window.start < window.end) {
    return { inside: minutes >= window.start && minutes < window.end, key: date };
  }
  if (minutes >= window.start) return { inside: true, key: date };
  // Early-morning part of a window that opened yesterday evening.
  const opened = localClock(now - (minutes + 1) * 60_000, timezone).date;
  return { inside: minutes < window.end, key: opened };
}

/**
 * The gates that need nothing but the clock and the ledger, in the order a
 * human would ask them. `undefined` means: go on with the expensive checks.
 */
export function cheapDreamGate(input: {
  now: number;
  auto: DreamAutoSettings;
  ledger: DreamAutoLedger;
}): { block: DreamAutoBlock; reason: string } | undefined {
  const { now, auto, ledger } = input;
  if (ledger.consecutiveFailures >= auto.maxAutoFailures) {
    return {
      block: 'paused',
      reason: `自动整理连续失败 ${ledger.consecutiveFailures} 次，已暂停；手动 \`/dream run\` 跑通一次后恢复`,
    };
  }
  const window = dreamWindowAt(now, auto.window, auto.timezone);
  if (!window.inside) return { block: 'outside-window', reason: `不在允许时段（${auto.window.text}，${auto.timezone}）` };
  if (ledger.lastWindowKey === window.key) return { block: 'window-used', reason: '这个时段已经开始过一轮，下个时段再看' };
  if (ledger.consecutiveFailures >= 2 && ledger.lastFailedAt !== undefined) {
    // One failure: the next window. Then 2, 4… days — a window opens at about
    // the same hour each day, so half a day of slack keeps it from slipping
    // by one more day.
    const wait = 2 ** (ledger.consecutiveFailures - 1);
    const days = (now - ledger.lastFailedAt) / DAY_MS;
    if (days < wait - 0.5) {
      return {
        block: 'backoff',
        reason: `自动整理连续失败 ${ledger.consecutiveFailures} 次，退避中（${formatDays(days)}/${wait} 天）`,
      };
    }
  }
  if (ledger.lastCompletedAt !== undefined) {
    const days = (now - ledger.lastCompletedAt) / DAY_MS;
    if (days < auto.minIntervalDays) {
      return { block: 'interval', reason: `距上次整理 ${formatDays(days)}/${auto.minIntervalDays} 天` };
    }
  }
  return undefined;
}

/**
 * 材料够: enough scopes or characters, or — past the longest interval — any
 * new input at all. `since` is the last completed run, or when the oldest
 * unread input appeared if there never was one.
 */
export function materialGate(input: {
  now: number;
  auto: DreamAutoSettings;
  material: DreamMaterial;
  since: number | undefined;
}): { ok: true; material: DreamMaterial } | { ok: false; reason: string } {
  const { auto, material } = input;
  if (material.sessions === 0) return { ok: false, reason: '没有新的已结束会话' };
  if (material.scopes >= auto.minScopes || material.chars >= auto.minInputChars) return { ok: true, material };
  if (auto.maxIntervalDays > 0 && input.since !== undefined && input.now - input.since >= auto.maxIntervalDays * DAY_MS) {
    return { ok: true, material: { ...material, fallback: true } };
  }
  return {
    ok: false,
    reason: `材料不足（${material.scopes}/${auto.minScopes} 个会话范围，${formatChars(material.chars)}/${formatChars(auto.minInputChars)} 字）`,
  };
}

export function formatDays(days: number): string {
  return days >= 10 ? String(Math.floor(days)) : days.toFixed(1).replace(/\.0$/, '');
}

export function formatChars(chars: number): string {
  return chars >= 10_000 ? `${(chars / 10_000).toFixed(1).replace(/\.0$/, '')}万` : String(chars);
}

function localClock(at: number, timezone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  const hour = Number(get('hour')) % 24;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: hour * 60 + Number(get('minute')) };
}
