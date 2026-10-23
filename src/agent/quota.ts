import type { ProfileConfig } from '../config/profile-schema';
import { claudeAccountPool } from './claude/accounts';
import { readClaudeQuota } from './claude/quota';
import { readCodexQuota } from './codex/quota';
import type { AgentKind } from './registry';
import type { AgentRunOptions } from './types';

/**
 * How full the agent account's subscription windows are, for work the bridge
 * starts on its own (自动整理) and must not let eat into the owner's quota.
 * Read-only: nothing here starts a model turn or consumes a reset credit.
 */
export interface QuotaWindow {
  /** `5 小时窗口`, `本周`… */
  label: string;
  /** 0–100. */
  usedPercent: number;
  /** Reset time as the CLI words it (Claude) or epoch ms (Codex), for display only. */
  resets?: string;
}

export interface QuotaReading {
  windows: QuotaWindow[];
  /** The account is already cut off, whatever the percentages say. */
  blocked?: boolean;
}

export interface QuotaReadOptions {
  /** Where to start the CLI: an empty scratch directory. */
  cwd: string;
  /** The profile's state directory (profile-local CODEX_HOME). */
  profileDir?: string;
  timeoutMs?: number;
  /**
   * With several accounts, which window "most room" is judged by: the fullest
   * one (default) or the weekly one — what a caller that only minds the week
   * (课堂精练's `quotaWindow: week`) needs, or it is shown the wrong account.
   */
  window?: 'any' | 'week';
}

const QUOTA_READERS: Record<AgentKind, (profileConfig: ProfileConfig, opts: QuotaReadOptions) => Promise<QuotaReading | undefined>> = {
  claude: (_profileConfig, opts) => readClaudeQuota(opts),
  codex: (profileConfig, opts) => readCodexQuota(profileConfig.codex, opts),
};

/** A per-window ceiling on account switch lines (AgentRunOptions.accountLineCap). */
export type AccountLineCap = NonNullable<AgentRunOptions['accountLineCap']>;

/**
 * Whether some account of the profile is still below `cap` in every capped
 * window, by what the accounts last reported. Undefined when it cannot be
 * told: a single account, or an agent without several accounts. Never throws.
 */
const ACCOUNT_ROOM: Partial<Record<AgentKind, (profileDir: string, cap: AccountLineCap) => Promise<boolean | undefined>>> = {
  claude: async (profileDir, cap) => {
    const pool = claudeAccountPool(profileDir);
    await pool.refresh();
    if (!pool.multi) return undefined;
    return pool.pickReady(undefined, cap) !== undefined;
  },
};

export async function accountRoomUnderCap(
  profileConfig: ProfileConfig,
  profileDir: string | undefined,
  cap: AccountLineCap,
): Promise<boolean | undefined> {
  const check = ACCOUNT_ROOM[profileConfig.agentKind];
  if (!check || !profileDir) return undefined;
  try {
    return await check(profileDir, cap);
  } catch {
    return undefined;
  }
}

/** Undefined when the CLI cannot say — callers must treat that as "unknown", never as 0%. Never throws. */
export async function readAgentQuota(profileConfig: ProfileConfig, opts: QuotaReadOptions): Promise<QuotaReading | undefined> {
  try {
    const reading = await QUOTA_READERS[profileConfig.agentKind]?.(profileConfig, opts);
    return reading && (reading.windows.length > 0 || reading.blocked) ? reading : undefined;
  } catch {
    return undefined;
  }
}

/** The fullest window, or 100% for a blocked account. */
export function fullestQuotaWindow(reading: QuotaReading): QuotaWindow | undefined {
  if (reading.blocked) return { label: '额度已用尽', usedPercent: 100 };
  return [...reading.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * When a window resets, as epoch ms: an ISO time (Codex) or Claude's wording —
 * `Oct 20 at 9am (Asia/Shanghai)`, `Oct 18, 2:59pm (Asia/Shanghai)`. The year
 * is the one that puts it closest after `now`. Undefined when unparseable.
 */
export function quotaResetAt(resets: string | undefined, now: number): number | undefined {
  if (!resets) return undefined;
  const text = resets.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const at = Date.parse(text);
    return Number.isFinite(at) ? at : undefined;
  }
  const match = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,|\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i.exec(text);
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1]!.toLowerCase());
  if (month < 0) return undefined;
  let hour = Number(match[3]) % 12;
  if (match[5]!.toLowerCase() === 'pm') hour += 12;
  const minute = Number(match[4] ?? 0);
  const zone = match[6]?.trim() || 'UTC';
  const year = new Date(now).getUTCFullYear();
  const candidates = [year - 1, year, year + 1]
    .map((y) => zonedTime(y, month, Number(match[2]), hour, minute, zone))
    .filter((at): at is number => at !== undefined);
  // Resets lie ahead; allow a day of slack for a reading taken just before one.
  return candidates.find((at) => at > now - 86_400_000);
}

/** Epoch ms of a wall-clock time in `zone`. */
function zonedTime(year: number, month: number, day: number, hour: number, minute: number, zone: string): number | undefined {
  const guess = Date.UTC(year, month, day, hour, minute);
  const offset = (at: number): number | undefined => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hourCycle: 'h23',
      }).formatToParts(new Date(at));
      const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
      return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute')) - at;
    } catch {
      return undefined;
    }
  };
  const first = offset(guess);
  if (first === undefined) return undefined;
  const second = offset(guess - first) ?? first;
  return guess - second;
}
