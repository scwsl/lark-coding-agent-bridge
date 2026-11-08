import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getSecret, removeSecret, setSecret, type KeystorePaths } from '../../config/keystore';
import { log } from '../../core/logger';
import { writeFileAtomic } from '../../platform/atomic-write';
import type { AgentEvent } from '../types';
import type { QuotaReading, QuotaWindow } from '../quota';
import { isOffDay, refreshHolidays } from './off-days';

/**
 * Several Claude subscription accounts behind one profile, so a run can move
 * to another account when the current one is full.
 *
 * Only the credential differs between accounts: an extra account is a
 * long-lived token from `claude setup-token`, handed to the claude process as
 * `CLAUDE_CODE_OAUTH_TOKEN`. Everything else — the config directory, the
 * session transcripts `--resume` reads, settings, skills — stays the CLI's
 * own, so a conversation carries on across accounts. `default` is the CLI's
 * own login and is always on the list.
 *
 * Which account a run gets, in rounds:
 *   1. of the accounts still below their switch lines (one per window:
 *      5-hour and weekly; per account or the profile's default): the one with
 *      the best switch score ({@link switchScore}), checked again before every
 *      run; the main one (first on the list) keeps the run unless another
 *      beats it by more than {@link STICKY_MARGIN}, since every move re-reads
 *      the whole conversation uncached (the prompt cache is per account);
 *   2. once every account is past a line: of those not refused, the same
 *      way — accounts are used up one after another;
 *   3. once every account has been refused: the run waits for the soonest
 *      reset (it pauses and resumes on its own).
 * The account a run moves to becomes the main one (top of the list). An
 * account paused by the owner (`pausedUntil`) takes no part until then and
 * comes back on its own. A window about to reset ({@link graceMs}) has its
 * line opened up to {@link GRACE_LINE}: the room a line keeps back for the
 * account's owner comes back at the reset anyway, so runs may use it first.
 *
 * Files in the profile directory:
 *   - `claude-accounts.json`: the list, in order of preference, and the
 *     switch lines. Re-read whenever it changes, no restart needed.
 *   - `claude-accounts-state.json`: what each account's last run said about
 *     its quota (`rate_limit_event`), and until when a refusal benched it.
 *   - the profile keystore (`secrets.enc`) holds the tokens, as
 *     `claude-oauth-<id>`.
 */

export const DEFAULT_ACCOUNT_ID = 'default';
/** How long a refusal benches an account when the CLI did not say when it resets. */
const UNKNOWN_RESET_MS = 60 * 60_000;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** The windows that limit every model; model-specific weekly windows only count when they refuse. */
export type WindowKind = 'five_hour' | 'seven_day';
export const WINDOW_KINDS: readonly WindowKind[] = ['five_hour', 'seven_day'];
export const WINDOW_LABELS: Record<WindowKind, string> = { five_hour: '5 小时窗口', seven_day: '本周' };
/**
 * Fable's own weekly window (`/usage`: "Current week (Fable)"). It limits Fable
 * runs only, so it stays out of account picks; 自动分级 reads it before climbing to Fable.
 */
export const FABLE_WINDOW = 'seven_day_fable';

/** Fill (1–100%) per window at which runs move to another account. */
export type SwitchLines = Record<WindowKind, number>;

/**
 * A ceiling one run puts on every account's lines (课堂精练 stops using an
 * account at 80% even where chats go on to 98%). A window left out keeps the
 * account's own line; a cap never raises one.
 */
export type LineCap = Partial<Record<WindowKind, number>>;
export const DEFAULT_LINES: SwitchLines = { five_hour: 98, seven_day: 98 };
/**
 * The line a window about to reset ({@link graceMs}) opens up to. What an
 * account's own line keeps back is lost at the reset if nobody uses it, so
 * runs may go past the line until then; a run's cap ({@link LineCap}) still
 * holds.
 */
export const GRACE_LINE = 98;
/**
 * How close to its reset a window counts as about to reset, by the hour of
 * day on the bridge's clock (owner's choice, 2026-10-30; the week's daytime
 * span 2 → 4 hours on 2026-11-06): shorter in the
 * daytime, when the accounts' owners may still want what their line keeps
 * back. `day` is [from, to) in hours.
 */
export const GRACE_SPANS: Record<WindowKind, { day: readonly [number, number]; dayMs: number; otherMs: number }> = {
  five_hour: { day: [8, 21], dayMs: 30 * 60_000, otherMs: 3_600_000 },
  seven_day: { day: [8, 20], dayMs: 4 * 3_600_000, otherMs: 6 * 3_600_000 },
};

/** The near-reset span of `kind` at `now` ({@link GRACE_SPANS}). */
export function graceMs(kind: WindowKind, now: number): number {
  const { day, dayMs, otherMs } = GRACE_SPANS[kind];
  const hour = new Date(now).getHours();
  return hour >= day[0] && hour < day[1] ? dayMs : otherMs;
}

/** A raised line and until when it holds (that window's next reset). */
export interface LineBoost {
  line: number;
  until: number;
}

export interface ClaudeAccountEntry {
  id: string;
  /** Shown on the reply card's `Sponsor:` line. The CLI's own login reads its name from `claude auth status`. */
  label?: string;
  /** This account's own lines; a window left out follows the profile's. */
  lines?: Partial<SwitchLines>;
  /**
   * Lines raised by a switch by name, per window, until that window resets.
   * Dropped as soon as runs move on to another account.
   */
  boost?: Partial<Record<WindowKind, LineBoost>>;
  /** Paused by the owner: no run uses the account until then (epoch ms); it comes back on its own. */
  pausedUntil?: number;
  /**
   * The owner's private names for the account, one per mood ({@link nicknameOf}).
   * Shown only where only the owner sees it — `/accounts`, `/accounts switch`
   * and `/usage` in the owner's own DM, and the local CLI; everywhere else,
   * including the reply card's `Sponsor:` line, keeps `label`.
   */
  nicknames?: Nicknames;
}

/**
 * The moods an account's private name follows, read off its state: `excited`
 * while new runs use it, `happy` when it is ready, `wronged` once past a line
 * (no fault of its own — it waits for the others), `sad` when refused or paused.
 */
export const NICKNAME_MOODS = ['happy', 'excited', 'sad', 'wronged'] as const;
export type NicknameMood = (typeof NICKNAME_MOODS)[number];
export type Nicknames = Partial<Record<NicknameMood, string>>;

/** `高兴` / `happy` → `happy`; undefined for anything else. */
export function parseNicknameMood(raw: string): NicknameMood | undefined {
  const key = raw.trim().toLowerCase();
  const zh: Record<string, NicknameMood> = { 高兴: 'happy', 兴奋: 'excited', 难过: 'sad', 委屈: 'wronged' };
  return (NICKNAME_MOODS as readonly string[]).includes(key) ? (key as NicknameMood) : zh[key];
}

/**
 * The account's private name for a mood; falls back through the other moods
 * (happy first) so one name is enough. Undefined when it has none.
 */
export function nicknameOf(entry: Pick<ClaudeAccountEntry, 'nicknames'>, mood: NicknameMood): string | undefined {
  const names = entry.nicknames;
  if (!names) return undefined;
  return names[mood] ?? names.happy ?? NICKNAME_MOODS.map((m) => names[m]).find(Boolean);
}

/** How a listing names accounts: `private` only for the owner's own eyes. */
export interface AccountNameView {
  /** Use the owner's private names ({@link ClaudeAccountEntry.nicknames}) where set. */
  private?: boolean;
}

function parseNicknames(raw: unknown): Nicknames | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Nicknames = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const mood = parseNicknameMood(key);
    if (mood && typeof value === 'string' && value.trim()) out[mood] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface ClaudeAccountsConfig {
  lines: SwitchLines;
  /**
   * On rest days (weekends and statutory holidays, `off-days.ts`) every
   * account's line in a window listed here is raised to it (never lowered).
   */
  offDayLines?: Partial<SwitchLines>;
  /**
   * On rest days a window counts as about to reset ({@link GRACE_LINE}) this
   * many hours before its reset, where longer than {@link GRACE_SPANS}; a
   * weekly window in it also scores as the first to use ({@link switchScore}).
   * Owner's choice 2026-11-08: 5-hour 5 (the whole window), weekly 24.
   */
  offDayGraceHours?: Partial<Record<WindowKind, number>>;
  /** Preference order; `default` is always present. */
  accounts: ClaudeAccountEntry[];
  /**
   * `false`: leave the 5-hour windows where runs open them. Otherwise they are
   * kept evenly staggered (see `window-stagger.ts`).
   */
  stagger?: false;
}

export interface AccountQuotaWindow {
  /** 0–100. */
  usedPercent: number;
  /** Epoch ms. */
  resetsAt?: number;
}

export interface AccountQuotaState {
  /** By Claude's window name: `five_hour`, `seven_day`, … */
  windows: Record<string, AccountQuotaWindow>;
  /** A request was refused for quota: the account sits out until then (epoch ms). */
  blockedUntil?: number;
  /** Epoch ms of the last report. */
  updatedAt: number;
}

export interface PickedAccount {
  id: string;
  label?: string;
  /** The owner's private names by mood; see {@link ClaudeAccountEntry.nicknames}. */
  nicknames?: Nicknames;
  /** Extra environment for the claude process: the account's token. Empty for the CLI's own login. */
  env: Record<string, string>;
}

export interface ClaudeAccountsPaths {
  configFile: string;
  stateFile: string;
  keystore: KeystorePaths;
}

export function claudeAccountsPaths(profileDir: string): ClaudeAccountsPaths {
  return {
    configFile: join(profileDir, 'claude-accounts.json'),
    stateFile: join(profileDir, 'claude-accounts-state.json'),
    keystore: { secretsFile: join(profileDir, 'secrets.enc'), keystoreSaltFile: join(profileDir, '.keystore.salt') },
  };
}

export function accountSecretId(id: string): string {
  return `claude-oauth-${id}`;
}

export function isValidAccountId(id: string): boolean {
  return ACCOUNT_ID.test(id);
}

export function isValidLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 100;
}

export function defaultAccountsConfig(): ClaudeAccountsConfig {
  return { lines: { ...DEFAULT_LINES }, accounts: [{ id: DEFAULT_ACCOUNT_ID }] };
}

/**
 * Tolerant parse: malformed entries are dropped, `default` is added in front
 * when missing. Older files' `switchAtPercent` (one line for both windows) and
 * `reservePercent` (lines at 100 − reserve) still read.
 */
export function parseAccountsConfig(text: string): ClaudeAccountsConfig {
  const config = defaultAccountsConfig();
  let raw: { lines?: unknown; offDayLines?: unknown; offDayGraceHours?: unknown; switchAtPercent?: unknown; accounts?: unknown; stagger?: unknown };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    return config;
  }
  if (!raw || typeof raw !== 'object') return config;
  if (isValidLine(raw.switchAtPercent)) config.lines = { five_hour: raw.switchAtPercent, seven_day: raw.switchAtPercent };
  config.lines = { ...config.lines, ...parseLines(raw.lines) };
  const offDay = parseLines(raw.offDayLines);
  if (Object.keys(offDay).length > 0) config.offDayLines = offDay;
  const offDayGrace = parseGraceHours(raw.offDayGraceHours);
  if (offDayGrace) config.offDayGraceHours = offDayGrace;
  if (raw.stagger === false) config.stagger = false;
  const accounts: ClaudeAccountEntry[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw.accounts) ? raw.accounts : []) {
    if (!item || typeof item !== 'object') continue;
    const { id, label, lines, reservePercent, boost, pausedUntil, nicknames } = item as {
      id?: unknown;
      label?: unknown;
      nicknames?: unknown;
      lines?: unknown;
      reservePercent?: unknown;
      boost?: unknown;
      pausedUntil?: unknown;
    };
    if (typeof id !== 'string' || !isValidAccountId(id) || seen.has(id)) continue;
    seen.add(id);
    const legacy =
      typeof reservePercent === 'number' && isValidLine(100 - reservePercent)
        ? { five_hour: 100 - reservePercent, seven_day: 100 - reservePercent }
        : {};
    const own = { ...legacy, ...parseLines(lines) };
    const raised = parseBoost(boost);
    const private_ = parseNicknames(nicknames);
    accounts.push({
      id,
      ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
      ...(Object.keys(own).length > 0 ? { lines: own } : {}),
      ...(raised ? { boost: raised } : {}),
      ...(typeof pausedUntil === 'number' && Number.isFinite(pausedUntil) ? { pausedUntil } : {}),
      ...(private_ ? { nicknames: private_ } : {}),
    });
  }
  if (!seen.has(DEFAULT_ACCOUNT_ID)) accounts.unshift({ id: DEFAULT_ACCOUNT_ID });
  config.accounts = accounts;
  return config;
}

function isValidGraceHours(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 7 * 24;
}

function parseGraceHours(raw: unknown): Partial<Record<WindowKind, number>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Partial<Record<WindowKind, number>> = {};
  for (const kind of WINDOW_KINDS) {
    const value = (raw as Record<string, unknown>)[kind];
    if (isValidGraceHours(value)) out[kind] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseBoost(raw: unknown): ClaudeAccountEntry['boost'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const boost: Partial<Record<WindowKind, LineBoost>> = {};
  for (const kind of WINDOW_KINDS) {
    const value = (raw as Record<string, { line?: unknown; until?: unknown } | undefined>)[kind];
    if (value && isValidLine(value.line) && typeof value.until === 'number' && Number.isFinite(value.until)) {
      boost[kind] = { line: value.line, until: value.until };
    }
  }
  return Object.keys(boost).length > 0 ? boost : undefined;
}

function parseLines(raw: unknown): Partial<SwitchLines> {
  if (!raw || typeof raw !== 'object') return {};
  const lines: Partial<SwitchLines> = {};
  for (const kind of WINDOW_KINDS) {
    const value = (raw as Record<string, unknown>)[kind];
    if (isValidLine(value)) lines[kind] = value;
  }
  return lines;
}

export function readAccountsConfig(paths: ClaudeAccountsPaths): ClaudeAccountsConfig {
  try {
    return parseAccountsConfig(readFileSync(paths.configFile, 'utf8'));
  } catch {
    return defaultAccountsConfig();
  }
}

async function writeAccountsConfig(paths: ClaudeAccountsPaths, config: ClaudeAccountsConfig): Promise<void> {
  await writeFileAtomic(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export interface AccountChanges {
  label?: string;
  /** Per window; `0` drops the account's own line (back to the profile's). */
  lines?: Partial<Record<WindowKind, number>>;
  /** Pause the account until then (epoch ms); `null` resumes it now. */
  pausedUntil?: number | null;
  /** The owner's private names, merged over any before; an empty name drops that mood, `null` drops them all. */
  nicknames?: Partial<Record<NicknameMood, string>> | null;
}

/** Add (or replace the token of) an account; new ones go last in the preference order. */
export async function saveAccount(
  paths: ClaudeAccountsPaths,
  account: { id: string; token: string } & AccountChanges,
): Promise<ClaudeAccountsConfig> {
  if (account.id === DEFAULT_ACCOUNT_ID) throw new Error('default 是 CLI 自己的登录，不能存令牌');
  if (!isValidAccountId(account.id)) throw new Error(`账号 id 只能用字母、数字、- 和 _（最长 32 位）：${account.id}`);
  const config = readAccountsConfig(paths);
  if (!config.accounts.some((a) => a.id === account.id)) config.accounts.push({ id: account.id });
  applyAccountChanges(config, account.id, account);
  await setSecret(accountSecretId(account.id), account.token, paths.keystore);
  await writeAccountsConfig(paths, config);
  return config;
}

/** Change an account's name or lines without touching its token. */
export async function updateAccount(
  paths: ClaudeAccountsPaths,
  id: string,
  changes: AccountChanges,
): Promise<ClaudeAccountsConfig> {
  const config = readAccountsConfig(paths);
  if (!config.accounts.some((a) => a.id === id)) throw new Error(`没有账户 ${id}`);
  applyAccountChanges(config, id, changes);
  await writeAccountsConfig(paths, config);
  return config;
}

/** The profile's lines, for every account without its own. */
export async function updateDefaultLines(
  paths: ClaudeAccountsPaths,
  lines: Partial<SwitchLines>,
): Promise<ClaudeAccountsConfig> {
  const config = readAccountsConfig(paths);
  for (const kind of WINDOW_KINDS) {
    const value = lines[kind];
    if (value === undefined) continue;
    if (!isValidLine(value)) throw new Error(`切换线要在 1–100 之间：${value}`);
    config.lines[kind] = value;
  }
  await writeAccountsConfig(paths, config);
  return config;
}

/** Rest-day lines for every account; `0` drops a window's (it keeps the usual lines on rest days). */
export async function updateOffDayLines(
  paths: ClaudeAccountsPaths,
  lines: Partial<Record<WindowKind, number>>,
  graceHours: Partial<Record<WindowKind, number>> = {},
): Promise<ClaudeAccountsConfig> {
  const config = readAccountsConfig(paths);
  const grace: Partial<Record<WindowKind, number>> = { ...config.offDayGraceHours };
  for (const kind of WINDOW_KINDS) {
    const value = graceHours[kind];
    if (value === undefined) continue;
    if (value === 0) delete grace[kind];
    else if (!isValidGraceHours(value)) throw new Error(`临近重置时长要在 0–168 小时之间：${value}`);
    else grace[kind] = value;
  }
  if (Object.keys(grace).length > 0) config.offDayGraceHours = grace;
  else delete config.offDayGraceHours;
  const next: Partial<SwitchLines> = { ...config.offDayLines };
  for (const kind of WINDOW_KINDS) {
    const value = lines[kind];
    if (value === undefined) continue;
    if (value === 0) delete next[kind];
    else if (!isValidLine(value)) throw new Error(`切换线要在 1–100 之间：${value}`);
    else next[kind] = value;
  }
  if (Object.keys(next).length > 0) config.offDayLines = next;
  else delete config.offDayLines;
  await writeAccountsConfig(paths, config);
  return config;
}

/** Put the named accounts first, in the order given; the rest keep their order after them. */
/** Turn the 5-hour window stagger on or off for the profile. */
export async function updateStagger(paths: ClaudeAccountsPaths, enabled: boolean): Promise<ClaudeAccountsConfig> {
  const config = readAccountsConfig(paths);
  if (enabled) delete config.stagger;
  else config.stagger = false;
  await writeAccountsConfig(paths, config);
  return config;
}

export async function reorderAccounts(paths: ClaudeAccountsPaths, ids: string[]): Promise<ClaudeAccountsConfig> {
  const config = readAccountsConfig(paths);
  const known = new Set(config.accounts.map((a) => a.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`没有账户：${unknown.join(', ')}`);
  if (new Set(ids).size !== ids.length) throw new Error('账户重复了');
  const first = ids.map((id) => config.accounts.find((a) => a.id === id)!);
  config.accounts = [...first, ...config.accounts.filter((a) => !ids.includes(a.id))];
  // Raised lines belong to the main account alone.
  for (const entry of config.accounts.slice(1)) delete entry.boost;
  await writeAccountsConfig(paths, config);
  return config;
}

function applyAccountChanges(config: ClaudeAccountsConfig, id: string, changes: AccountChanges): void {
  const entry = config.accounts.find((a) => a.id === id)!;
  const label = changes.label?.trim();
  if (label) entry.label = label;
  if (changes.nicknames === null) delete entry.nicknames;
  else if (changes.nicknames) {
    const merged: Nicknames = { ...entry.nicknames };
    for (const mood of NICKNAME_MOODS) {
      const value = changes.nicknames[mood];
      if (value === undefined) continue;
      if (value.trim()) merged[mood] = value.trim();
      else delete merged[mood];
    }
    if (Object.keys(merged).length > 0) entry.nicknames = merged;
    else delete entry.nicknames;
  }
  for (const kind of WINDOW_KINDS) {
    const value = changes.lines?.[kind];
    if (value === undefined) continue;
    if (value === 0) {
      if (entry.lines) delete entry.lines[kind];
    } else if (isValidLine(value)) {
      entry.lines = { ...entry.lines, [kind]: value };
    } else {
      throw new Error(`切换线要在 1–100 之间（0 表示跟默认）：${value}`);
    }
  }
  if (entry.lines && Object.keys(entry.lines).length === 0) delete entry.lines;
  if (changes.pausedUntil === null) {
    delete entry.pausedUntil;
  } else if (changes.pausedUntil !== undefined) {
    if (!Number.isFinite(changes.pausedUntil)) throw new Error(`暂停截止时间无效：${changes.pausedUntil}`);
    // Some account has to stay in rotation, or every run would fail to start.
    const now = Date.now();
    if (!config.accounts.some((a) => a.id !== id && !isPausedEntry(a, now))) {
      throw new Error('至少要留一个没暂停的账户');
    }
    entry.pausedUntil = changes.pausedUntil;
  }
}

export async function deleteAccount(paths: ClaudeAccountsPaths, id: string): Promise<boolean> {
  if (id === DEFAULT_ACCOUNT_ID) throw new Error('default 是 CLI 自己的登录，不能删除');
  const config = readAccountsConfig(paths);
  const before = config.accounts.length;
  config.accounts = config.accounts.filter((a) => a.id !== id);
  const removedSecret = await removeSecret(accountSecretId(id), paths.keystore).catch(() => false);
  if (config.accounts.length !== before) await writeAccountsConfig(paths, config);
  return removedSecret || config.accounts.length !== before;
}

export interface ClaudeAccountPoolOptions {
  paths: ClaudeAccountsPaths;
  now?: () => number;
  /** Decrypt one token. Injected in tests. */
  readSecret?: (id: string) => Promise<string | undefined>;
  /** `now` is a rest day ({@link ClaudeAccountsConfig.offDayLines}). Injected in tests; else `off-days.ts`. */
  isOffDay?: (now: number) => boolean;
}

type RateLimitEvent = Extract<AgentEvent, { type: 'rate_limit' }>;

export class ClaudeAccountPool {
  private config: ClaudeAccountsConfig = defaultAccountsConfig();
  private configStamp: number | undefined;
  private tokens = new Map<string, string>();
  private state: Record<string, AccountQuotaState> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly readSecret: (id: string) => Promise<string | undefined>;
  private readonly holidaysDir: string;
  private readonly offDay: (now: number) => boolean;

  constructor(private readonly opts: ClaudeAccountPoolOptions) {
    this.now = opts.now ?? Date.now;
    this.readSecret = opts.readSecret ?? ((id) => getSecret(id, opts.paths.keystore));
    this.holidaysDir = join(dirname(opts.paths.configFile), 'holidays');
    this.offDay = opts.isOffDay ?? ((now) => isOffDay(now, this.holidaysDir));
  }

  /** Re-read the account list when its file changed and decrypt the tokens. Never throws. */
  async refresh(): Promise<void> {
    this.loadState();
    if ((this.config.offDayLines || this.config.offDayGraceHours) && !this.opts.isOffDay) refreshHolidays(this.holidaysDir, this.now());
    let stamp = 0;
    try {
      stamp = statSync(this.opts.paths.configFile).mtimeMs;
    } catch {
      // No file: only the CLI's own login.
    }
    if (stamp === this.configStamp) return;
    const config = stamp ? readAccountsConfig(this.opts.paths) : defaultAccountsConfig();
    const tokens = new Map<string, string>();
    for (const account of config.accounts) {
      if (account.id === DEFAULT_ACCOUNT_ID) continue;
      const token = await this.readSecret(accountSecretId(account.id)).catch((err: unknown) => {
        log.warn('claude-accounts', 'token-unreadable', { id: account.id, err: String(err) });
        return undefined;
      });
      if (token) tokens.set(account.id, token);
      else log.warn('claude-accounts', 'token-missing', { id: account.id });
    }
    this.config = config;
    this.tokens = tokens;
    this.configStamp = stamp;
  }

  /** The 5-hour windows are kept staggered (see `window-stagger.ts`); on unless the owner turned it off. */
  get staggerEnabled(): boolean {
    return this.config.stagger !== false;
  }

  /** When the account's 5-hour window resets by the last reading (epoch ms, possibly past); undefined when never read. */
  fiveHourResetsAt(id: string): number | undefined {
    return this.loadState()[id]?.windows.five_hour?.resetsAt;
  }

  /**
   * A token account whose 5-hour window has run out waits for the stagger to
   * open its next one at its slot: a quota probe on a token is a model request
   * and would open the window right away — on `/accounts`, every idle account
   * in the same minute, which is how their resets bunched up. The CLI's own
   * login reads `/usage`, which opens nothing, so it is never held.
   */
  heldForStagger(id: string, now = this.now()): boolean {
    if (!this.staggerEnabled || !this.multi || id === DEFAULT_ACCOUNT_ID || !this.tokens.has(id)) return false;
    const resetsAt = this.fiveHourResetsAt(id);
    return resetsAt !== undefined && resetsAt <= now;
  }

  /** The profile's lines (accounts without their own follow these). */
  get defaultLines(): SwitchLines {
    return { ...this.config.lines };
  }

  /** The rest-day lines, if the owner set any. */
  get offDayLines(): Partial<SwitchLines> | undefined {
    return this.config.offDayLines ? { ...this.config.offDayLines } : undefined;
  }

  /** The rest-day near-reset spans in hours, if the owner set any. */
  get offDayGraceHours(): Partial<Record<WindowKind, number>> | undefined {
    return this.config.offDayGraceHours ? { ...this.config.offDayGraceHours } : undefined;
  }

  /** `now` is a rest day and rest-day lines or spans are set: they are in force. */
  offDayLinesActive(now = this.now()): boolean {
    return (this.config.offDayLines !== undefined || this.config.offDayGraceHours !== undefined) && this.offDay(now);
  }

  /** The rest-day span of `kind` in ms when it is in force at `now` and longer than the usual one. */
  private offDayGraceMs(kind: WindowKind, now: number): number | undefined {
    const hours = this.config.offDayGraceHours?.[kind];
    if (hours === undefined) return undefined;
    const ms = hours * 3_600_000;
    return ms > graceMs(kind, now) && this.offDay(now) ? ms : undefined;
  }

  /** How close to its reset `kind`'s window counts as about to reset at `now`: {@link graceMs}, longer on rest days. */
  graceSpanMs(kind: WindowKind, now = this.now()): number {
    return this.offDayGraceMs(kind, now) ?? graceMs(kind, now);
  }

  /** The line (1–100) at which runs leave the account in `kind`'s window, a raised one included, under `cap`. */
  lineOf(id: string, kind: WindowKind, now = this.now(), cap?: LineCap): number {
    const own = this.ownLineOf(id, kind, now);
    return withCap(this.inGrace(id, kind, now) ? Math.max(own, GRACE_LINE) : own, kind, cap);
  }

  /** The line before any near-reset opening: the account's own, raised by a switch by name. */
  private ownLineOf(id: string, kind: WindowKind, now: number): number {
    const base = this.baseLineOf(id, kind, now);
    const boost = this.config.accounts.find((a) => a.id === id)?.boost?.[kind];
    return boost && boost.until > now ? Math.max(base, boost.line) : base;
  }

  /** The window resets within {@link graceMs}: its line is open up to {@link GRACE_LINE}. */
  inGrace(id: string, kind: WindowKind, now = this.now()): boolean {
    const resetsAt = this.loadState()[id]?.windows[kind]?.resetsAt;
    return resetsAt !== undefined && resetsAt > now && resetsAt - now < this.graceSpanMs(kind, now);
  }

  /** The account's own line, or the profile's, raised to the rest-day line on rest days; no other raise. */
  baseLineOf(id: string, kind: WindowKind, now = this.now()): number {
    const line = this.config.accounts.find((a) => a.id === id)?.lines?.[kind] ?? this.config.lines[kind];
    const offDay = this.config.offDayLines?.[kind];
    return offDay !== undefined && offDay > line && this.offDay(now) ? offDay : line;
  }

  /** Some window's line is raised right now (a switch by name). */
  isBoosted(id: string, now = this.now()): boolean {
    return WINDOW_KINDS.some((kind) => this.ownLineOf(id, kind, now) > this.baseLineOf(id, kind, now));
  }

  /**
   * Accounts that can run, in order of preference: the CLI's own login and
   * those with a token, less any the owner paused.
   */
  accounts(): PickedAccount[] {
    const now = this.now();
    return this.config.accounts
      .filter((a) => a.id === DEFAULT_ACCOUNT_ID || this.tokens.has(a.id))
      .filter((a) => !isPausedEntry(a, now))
      .map((a) => this.toPicked(a));
  }

  /** Accounts the owner paused, with until when, in order of preference. */
  pausedAccounts(): Array<{ account: PickedAccount; until: number }> {
    const now = this.now();
    return this.config.accounts
      .filter((a) => isPausedEntry(a, now))
      .map((a) => ({ account: this.toPicked(a), until: a.pausedUntil! }));
  }

  /** The owner paused the account and the pause has not ended. */
  isPaused(id: string, now = this.now()): boolean {
    const entry = this.config.accounts.find((a) => a.id === id);
    return entry !== undefined && isPausedEntry(entry, now);
  }

  /**
   * Runs go through account tokens rather than the CLI's own login alone:
   * more than one account to choose from, or the CLI login paused so the one
   * left is a backup.
   */
  get multi(): boolean {
    const accounts = this.accounts();
    return accounts.length > 1 || (accounts.length === 1 && accounts[0]!.id !== DEFAULT_ACCOUNT_ID);
  }

  /**
   * The account a new run should use (see the rounds in the module comment):
   * below its lines, else not refused, else the one whose refusal ends first —
   * tried anyway, the refusal may be over (the run pauses if it is not).
   */
  pick(exclude?: ReadonlySet<string>, cap?: LineCap): PickedAccount | undefined {
    const now = this.now();
    return (
      this.pickRunnable(exclude, cap) ??
      this.accounts()
        .filter((a) => !exclude?.has(a.id))
        .sort((a, b) => (this.refusedUntil(a.id, now) ?? now) - (this.refusedUntil(b.id, now) ?? now))[0]
    );
  }

  /** Round 1, else round 2: never an account that is still refused. */
  pickRunnable(exclude?: ReadonlySet<string>, cap?: LineCap): PickedAccount | undefined {
    const now = this.now();
    return this.pickReady(exclude, cap) ?? this.choose(exclude, (id) => !this.isRefused(id, now), now, cap);
  }

  /** Round 1 only: an account below all its lines (under `cap`). */
  pickReady(exclude?: ReadonlySet<string>, cap?: LineCap): PickedAccount | undefined {
    const now = this.now();
    return this.choose(exclude, (id) => this.underLinesAt(id, now, cap) <= now, now, cap);
  }

  /**
   * Of the accounts `ok` lets through: the best switch score, ties keeping the
   * list's order — except that the main one stays while no other beats it by
   * more than {@link STICKY_MARGIN}.
   */
  private choose(
    exclude: ReadonlySet<string> | undefined,
    ok: (id: string) => boolean,
    now: number,
    cap?: LineCap,
  ): PickedAccount | undefined {
    const all = this.accounts();
    const candidates = all.filter((a) => !exclude?.has(a.id) && ok(a.id));
    let best: PickedAccount | undefined;
    let bestScore = -1;
    for (const account of candidates) {
      const score = this.score(account.id, now, cap);
      if (score > bestScore) {
        best = account;
        bestScore = score;
      }
    }
    const main = candidates[0] && candidates[0].id === all[0]?.id ? candidates[0] : undefined;
    if (main && best && best.id !== main.id && bestScore - this.score(main.id, now, cap) <= STICKY_MARGIN) return main;
    return best;
  }

  /** When a run or `/usage` last reported the account's quota (epoch ms); undefined when never. */
  reportedAt(id: string): number | undefined {
    return this.loadState()[id]?.updatedAt;
  }

  /**
   * Put `id` at the top of the list once a run moved to it, so new runs stay
   * on it until it reaches a line too; raised lines end with the move. Takes
   * effect at once; the file follows.
   */
  promote(id: string): void {
    const accounts = this.config.accounts;
    const entry = accounts.find((a) => a.id === id);
    if (!entry || accounts[0]?.id === id) return;
    this.config = { ...this.config, accounts: withMain(accounts, id) };
    log.info('claude-accounts', 'promote', { id });
    this.writing = this.writing
      .then(() => switchToAccount(this.opts.paths, id))
      .then(() => undefined)
      .catch((err: unknown) => log.warn('claude-accounts', 'promote-write-failed', { id, err: String(err) }));
  }

  /** Each window as the switch score and `/accounts` read it. */
  windowViews(id: string, now = this.now(), cap?: LineCap): Record<WindowKind, AccountWindowView> {
    const state = this.loadState()[id];
    const windows = {} as Record<WindowKind, AccountWindowView>;
    for (const kind of WINDOW_KINDS) {
      const window = state?.windows[kind];
      const line = this.lineOf(id, kind, now, cap);
      if (!window) {
        windows[kind] = { line };
        continue;
      }
      const reset = window.resetsAt !== undefined && window.resetsAt <= now;
      const own = withCap(this.ownLineOf(id, kind, now), kind, cap);
      const restDaySpan = this.offDayGraceMs(kind, now);
      windows[kind] = {
        line,
        usedPercent: reset ? 0 : window.usedPercent,
        ...(reset ? { reset: true } : window.resetsAt !== undefined ? { resetsInMs: window.resetsAt - now } : {}),
        ...(line > own ? { graceFrom: own } : {}),
        ...(restDaySpan !== undefined ? { graceSpanMs: restDaySpan } : {}),
        ...(restDaySpan !== undefined && !reset && this.inGrace(id, kind, now) ? { restDayGrace: true } : {}),
      };
    }
    return windows;
  }

  /** The account's switch score, 0–1 ({@link switchScore}). */
  score(id: string, now = this.now(), cap?: LineCap): number {
    const windows = this.windowViews(id, now, cap);
    return switchScore(windows, windowsKnown(windows), now);
  }

  /** The account is below all its lines (under `cap`) and not refused right now. */
  hasRoom(id: string, cap?: LineCap): boolean {
    const now = this.now();
    return this.underLinesAt(id, now, cap) <= now;
  }

  /** A request on the account was refused and its window has not reset yet. */
  isRefused(id: string, now = this.now()): boolean {
    return this.refusedUntil(id, now) !== undefined;
  }

  /** When the account's refusal ends; undefined when it is not refused. */
  refusedUntil(id: string, now = this.now()): number | undefined {
    const until = this.loadState()[id]?.blockedUntil;
    return until !== undefined && until > now ? until : undefined;
  }

  /** When the first account stops being refused; undefined when one is not refused now. */
  nextRunnableAt(): number | undefined {
    const now = this.now();
    let soonest: number | undefined;
    for (const account of this.accounts()) {
      const until = this.refusedUntil(account.id, now);
      if (until === undefined) return undefined;
      soonest = soonest === undefined ? until : Math.min(soonest, until);
    }
    return soonest;
  }

  /** The first window the account is at or past its line in, with that line. */
  pastLine(id: string, now = this.now(), cap?: LineCap): { kind: WindowKind; line: number } | undefined {
    const state = this.loadState()[id];
    if (!state) return undefined;
    for (const kind of WINDOW_KINDS) {
      const window = state.windows[kind];
      const line = this.lineOf(id, kind, now, cap);
      if (!window || window.usedPercent < line) continue;
      const until = window.resetsAt ?? state.updatedAt + UNKNOWN_RESET_MS;
      if (until > now) return { kind, line };
    }
    return undefined;
  }

  /** When the account is below all its lines and not refused: now, or the reset that gets it there. */
  underLinesAt(id: string, now = this.now(), cap?: LineCap): number {
    const state = this.loadState()[id];
    if (!state) return now;
    let at = this.refusedUntil(id, now) ?? now;
    for (const kind of WINDOW_KINDS) {
      const window = state.windows[kind];
      if (!window || window.usedPercent < this.lineOf(id, kind, now, cap)) continue;
      const until = window.resetsAt ?? state.updatedAt + UNKNOWN_RESET_MS;
      if (until > at) at = until;
    }
    return at;
  }

  /**
   * Record a fresh `/usage` reading of `id` (windows by kind, reset as epoch
   * ms). Leaves a refusal alone: `/usage` does not say whether requests go
   * through.
   */
  observeUsage(id: string, windows: Partial<Record<WindowKind, { usedPercent: number; resetsAt?: number }>>): void {
    const kinds = WINDOW_KINDS.filter((kind) => windows[kind] !== undefined);
    if (kinds.length === 0) return;
    const now = this.now();
    const all = this.loadState();
    const state: AccountQuotaState = all[id] ?? { windows: {}, updatedAt: now };
    for (const kind of kinds) {
      const window = windows[kind]!;
      state.windows[kind] = {
        usedPercent: window.usedPercent,
        ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
      };
    }
    state.updatedAt = now;
    all[id] = state;
    this.persist();
  }

  /** Record a model-specific window of `id` (e.g. {@link FABLE_WINDOW}); account picks ignore it. */
  observeModelWindow(id: string, kind: string, window: { usedPercent: number; resetsAt?: number }): void {
    const now = this.now();
    const all = this.loadState();
    const state: AccountQuotaState = all[id] ?? { windows: {}, updatedAt: now };
    state.windows[kind] = {
      usedPercent: window.usedPercent,
      ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    };
    all[id] = state;
    this.persist();
  }

  /** How full `kind` of `id` is by the last reading (0 once its reset passed); undefined when never read. */
  windowUsed(id: string, kind: string, now = this.now()): number | undefined {
    const window = this.loadState()[id]?.windows[kind];
    if (!window) return undefined;
    return window.resetsAt !== undefined && window.resetsAt <= now ? 0 : window.usedPercent;
  }

  /** Record what a run on `id` reported about its quota. */
  observe(id: string, evt: RateLimitEvent): void {
    const now = this.now();
    const all = this.loadState();
    const state: AccountQuotaState = all[id] ?? { windows: {}, updatedAt: now };
    for (const window of evt.windows ?? []) {
      state.windows[window.kind] = {
        usedPercent: window.usedPercent,
        ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
      };
    }
    if (evt.blocked) {
      // The refusal message itself carries no reset; keep the one the
      // rate_limit_event before it gave.
      const stillBlocked = state.blockedUntil !== undefined && state.blockedUntil > now;
      state.blockedUntil = evt.resetsAt ?? (stillBlocked ? state.blockedUntil : now + UNKNOWN_RESET_MS);
    } else {
      delete state.blockedUntil;
    }
    state.updatedAt = now;
    all[id] = state;
    this.persist();
  }

  /** What the account's runs last said about its quota, as a quota reading. Undefined when they never said. */
  quotaReading(id: string, now = this.now()): QuotaReading | undefined {
    const state = this.loadState()[id];
    if (!state) return undefined;
    const windows: QuotaWindow[] = [];
    for (const kind of WINDOW_KINDS) {
      const window = state.windows[kind];
      if (!window) continue;
      const reset = window.resetsAt !== undefined && window.resetsAt <= now;
      windows.push({
        label: WINDOW_LABELS[kind],
        usedPercent: reset ? 0 : window.usedPercent,
        ...(window.resetsAt !== undefined && !reset ? { resets: new Date(window.resetsAt).toISOString() } : {}),
      });
    }
    const blocked = this.isRefused(id, now);
    if (windows.length === 0 && !blocked) return undefined;
    return { windows, ...(blocked ? { blocked: true } : {}) };
  }

  /** Each account with its last known quota, for status displays. */
  status(): Array<{ account: PickedAccount; state?: AccountQuotaState }> {
    const all = this.loadState();
    return this.accounts().map((account) => ({ account, ...(all[account.id] ? { state: all[account.id] } : {}) }));
  }

  /** Wait for pending state writes (tests, shutdown). */
  async flush(): Promise<void> {
    await this.writing;
  }

  private toPicked(entry: ClaudeAccountEntry): PickedAccount {
    const token = this.tokens.get(entry.id);
    return {
      id: entry.id,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.nicknames ? { nicknames: entry.nicknames } : {}),
      env: token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {},
    };
  }

  private loadState(): Record<string, AccountQuotaState> {
    if (this.state) return this.state;
    try {
      const raw = JSON.parse(readFileSync(this.opts.paths.stateFile, 'utf8')) as { accounts?: unknown };
      this.state =
        raw.accounts && typeof raw.accounts === 'object' ? (raw.accounts as Record<string, AccountQuotaState>) : {};
    } catch {
      this.state = {};
    }
    return this.state;
  }

  private persist(): void {
    const body = `${JSON.stringify({ accounts: this.loadState() }, null, 2)}\n`;
    this.writing = this.writing
      .then(() => writeFileAtomic(this.opts.paths.stateFile, body, { mode: 0o600 }))
      .catch((err: unknown) => log.warn('claude-accounts', 'state-write-failed', { err: String(err) }));
  }
}

function isPausedEntry(entry: ClaudeAccountEntry, now: number): boolean {
  return entry.pausedUntil !== undefined && entry.pausedUntil > now;
}

const pools = new Map<string, ClaudeAccountPool>();

/** The one pool per profile directory, shared by the adapter, quota reads and the Sponsor lookup. */
export function claudeAccountPool(profileDir: string): ClaudeAccountPool {
  const key = resolve(profileDir);
  let pool = pools.get(key);
  if (!pool) {
    pool = new ClaudeAccountPool({ paths: claudeAccountsPaths(key) });
    pools.set(key, pool);
  }
  return pool;
}

/**
 * The accounts as Markdown lines for `/usage` and the CLI: which one new runs
 * go to (▶), each one's lines, how full it is by its last report, and whether
 * it is past a line or refused. `defaultLabel` names the CLI's own login.
 */
export function accountsReport(
  pool: ClaudeAccountPool,
  defaultLabel: string | undefined,
  now = Date.now(),
  view: AccountNameView = {},
): string[] {
  const next = pool.pick()?.id;
  const paused = pool
    .pausedAccounts()
    .map(
      ({ account, until }) =>
        `- **${displayName(account, defaultLabel, view, 'sad')}**（已暂停，${account.id}；切换线 5h ${pool.lineOf(account.id, 'five_hour')}% · 周 ${pool.lineOf(account.id, 'seven_day')}%）：⏸ 暂停到 ${formatClock(until)}，到期自动恢复`,
    );
  const active = pool.status().map(({ account, state }, index) => {
    const refusedAt = pool.refusedUntil(account.id, now);
    const name = displayName(
      account,
      defaultLabel,
      view,
      refusedAt !== undefined ? 'sad' : account.id === next ? 'excited' : pool.pastLine(account.id, now) ? 'wronged' : 'happy',
    );
    const marker = account.id === next ? '▶ ' : '';
    const role = index === 0 ? '主账户' : `备用 ${index}`;
    const lines = `切换线 5h ${pool.lineOf(account.id, 'five_hour')}% · 周 ${pool.lineOf(account.id, 'seven_day')}%`;
    const usage =
      WINDOW_KINDS.map((kind) => {
        const window = state?.windows[kind];
        if (!window) return undefined;
        const used = window.resetsAt !== undefined && window.resetsAt <= now ? 0 : window.usedPercent;
        return `${WINDOW_LABELS[kind]} ${Math.round(used)}%`;
      })
        .filter((part): part is string => part !== undefined)
        .join(' · ') || '还没有运行记录';
    const fable = pool.windowUsed(account.id, FABLE_WINDOW, now);
    const fablePart = fable !== undefined ? ` · 本周 Fable ${Math.round(fable)}%` : '';
    const refused = pool.refusedUntil(account.id, now);
    const past = pool.pastLine(account.id, now);
    const flag =
      refused !== undefined
        ? ` · ⛔ 额度用尽，${formatClock(refused)} 恢复`
        : past
          ? ` · ⚠️ 已过${WINDOW_LABELS[past.kind]}切换线，其他账户也到线后才轮到它`
          : '';
    return `- ${marker}**${name}**（${role}，${account.id}；${lines}）：${usage}${fablePart}${flag}`;
  });
  return [...active, ...paused];
}

/**
 * `🏖 休息日（周末和法定节假日）…` — the rest-day rules and whether they are in
 * force now; undefined when none are set.
 */
export function offDayNote(pool: ClaudeAccountPool, now = Date.now()): string | undefined {
  const lines = pool.offDayLines;
  const grace = pool.offDayGraceHours;
  if (!lines && !grace) return undefined;
  const parts: string[] = [];
  if (lines) {
    const each = WINDOW_KINDS.filter((kind) => lines[kind] !== undefined).map((kind) => `${WINDOW_LABELS[kind]} ${lines[kind]}%`);
    parts.push(`切换线至少 ${each.join(' · ')}`);
  }
  if (grace) {
    const each = WINDOW_KINDS.filter((kind) => grace[kind] !== undefined).map(
      (kind) => `${WINDOW_LABELS[kind]}重置前 ${grace[kind]} 小时`,
    );
    parts.push(`临近重置放开到 ${GRACE_LINE}% 并优先使用：${each.join(' · ')}`);
  }
  const active = pool.offDayLinesActive(now) ? '今天是休息日，正在生效' : '今天是工作日，未生效';
  return `🏖 休息日（周末和法定节假日，调休上班日除外）：${parts.join('；')}（${active}）`;
}

/** `⏸ 已暂停：Mia（backup2）到 11-13 00:00 …` under the `/accounts` table; undefined when none is paused. */
export function pausedNote(pool: ClaudeAccountPool, view: AccountNameView = {}): string | undefined {
  const paused = pool.pausedAccounts();
  if (paused.length === 0) return undefined;
  const names = paused.map(({ account, until }) => `${displayName(account, undefined, view, 'sad')}（${account.id}）到 ${formatClock(until)}`);
  return `⏸ 已暂停：${names.join('、')}，期间不参与选号，到期自动恢复。`;
}

/** A paused account by id or label, ignoring case: why a switch by name may not go to it. */
export function findPausedAccount(
  pool: ClaudeAccountPool,
  query: string,
  view: AccountNameView = {},
): { id: string; name: string; until: number } | undefined {
  const q = query.trim().toLowerCase();
  const hit = pool
    .pausedAccounts()
    .find(
      ({ account }) =>
        account.id.toLowerCase() === q ||
        account.label?.toLowerCase() === q ||
        (view.private && Object.values(account.nicknames ?? {}).some((n) => n.toLowerCase() === q)),
    );
  return hit ? { id: hit.account.id, name: displayName(hit.account, undefined, view, 'sad'), until: hit.until } : undefined;
}

/** `已暂停到 11-13 00:00` — the reason a switch by name does not go to a paused account. */
export function pausedRefusal(until: number): string {
  return `已暂停到 ${formatClock(until)}，到期自动恢复`;
}

/** `10-21 15:00` in the machine's time zone. */
function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Account table and switching (`/accounts`, `claude-account switch`) ─────

/** Weights of the switch score's three terms (see {@link switchScore}). */
export const SWITCH_SCORE_WEIGHTS = { weekExpiring: 0.6, weekRoom: 0.15, fiveHourRoom: 0.25 } as const;
/**
 * Weekly room (as a share of the line) below which an account's coming reset
 * counts for less: a few points left are not worth a move (every move re-reads
 * the conversation uncached) — they are used once the account comes up anyway.
 */
export const WORTH_MOVING_ROOM = 0.1;
/**
 * How much better than the main account another has to score to take the next
 * run from it. Moving costs a full uncached read of the conversation (the
 * prompt cache is per account), so near-equal scores don't trade places.
 */
export const STICKY_MARGIN = 0.05;
/** Room assumed for an account that has never run here (its token is untested). */
const UNKNOWN_ROOM = 0.5;
const WINDOW_MS: Record<WindowKind, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 };
const WEEK_MS = WINDOW_MS.seven_day;

export interface AccountWindowView {
  /** 0–100; undefined when no run reported this window yet. */
  usedPercent?: number;
  /** Until the window resets; undefined when unknown. */
  resetsInMs?: number;
  /** The window reset since the last report, so the usage reads 0. */
  reset?: boolean;
  /** The account's switch line for this window (1–100). */
  line: number;
  /** The window is about to reset, so its line is open up to {@link GRACE_LINE}: the line it had before. */
  graceFrom?: number;
  /** A rest day's longer near-reset span ({@link ClaudeAccountsConfig.offDayGraceHours}) is in force for it. */
  graceSpanMs?: number;
  /** Within that rest-day span of its reset. */
  restDayGrace?: boolean;
}

export interface AccountRow {
  id: string;
  /** The label, or the CLI login's name for `default`; in the owner's view, its private name for its mood. */
  name: string;
  /** Other names a switch by name finds it by: the label, and in the owner's view all private names. */
  aliases?: string[];
  /** Position in the preference order: 0 is the main account. */
  index: number;
  /** New runs go to this account (▶). */
  next: boolean;
  /** Some run on this account reported its quota. */
  known: boolean;
  windows: Record<WindowKind, AccountWindowView>;
  refusedUntil?: number;
  pastLine?: WindowKind;
  /** Below all its lines and not refused: a run would use it right now. */
  ready: boolean;
  /** Its lines are raised for now by a switch by name. */
  boosted: boolean;
  /** 0–1, see {@link switchScore}. */
  score: number;
}

/**
 * How good a switch target an account is, 0–1, built so that no weekly quota
 * is left unused at a reset — the weekly room that expires first is spent
 * first (owner's ask, 2026-11-03: an account two days from its reset with
 * half its week left lost to one six days out with more room):
 *
 *   0.60 × weekResetSoon × worth + 0.15 × weekRoom + 0.25 × fiveHourRoom
 *
 * - weekResetSoon = 1 − time to the weekly reset ÷ 7 days, the heaviest term:
 *   room left at a reset is gone for good, while room that resets later can
 *   still be used after; so whichever week ends first goes first (earliest
 *   deadline first, the order that leaves the least unused whatever the
 *   demand), as long as it has room. How much room it has does not change
 *   that order — the accounts that reset later get their turn afterwards;
 * - worth = min(1, weekRoom ÷ {@link WORTH_MOVING_ROOM}): with less than a
 *   tenth of its line left, an account's near reset counts for less, the few
 *   points are not worth a move;
 * - weekRoom = 1 − weekly used ÷ weekly line: of weeks ending about the same
 *   time, the one with more left;
 * - fiveHourRoom = 1 − 5-hour used ÷ 5-hour line: don't move to an account
 *   that is about to hit its 5-hour line and move again. Near the 5-hour
 *   reset ({@link graceMs}) it rises towards 1 (by 1 − time to the reset ÷
 *   that span): what is left comes back in full at the reset, so an account
 *   about to reset is as good as an empty one.
 *
 * Room is measured against the account's switch lines (opened up to
 * {@link GRACE_LINE} for a window about to reset), and an account
 * at or past either line scores 0: it is not a switch target until that
 * window resets. All clamped to 0–1. An account that never ran here counts as
 * half full with no reset known, so a proven account with room comes first.
 */
export function switchScore(windows: Record<WindowKind, AccountWindowView>, known: boolean, now = Date.now()): number {
  const room = (kind: WindowKind): number =>
    known ? clamp01(1 - (windows[kind].usedPercent ?? 0) / windows[kind].line) : UNKNOWN_ROOM;
  if (WINDOW_KINDS.some((kind) => room(kind) === 0)) return 0;
  const soon = (kind: WindowKind, span: number): number => {
    const left = windows[kind].resetsInMs;
    return !known || left === undefined ? 0 : clamp01(1 - left / span);
  };
  const weekRoom = room('seven_day');
  const fiveHourRoom = room('five_hour');
  // A rest day's weekly near-reset span: whatever is left goes at the reset
  // and its owner is not using it, so it is the first to use, few points or many.
  const weekGrace = known && windows.seven_day.restDayGrace === true;
  const worth = weekGrace ? 1 : Math.min(1, weekRoom / WORTH_MOVING_ROOM);
  const weekSoon = weekGrace ? 1 : soon('seven_day', WEEK_MS);
  const fiveHourSpan = windows.five_hour.graceSpanMs ?? graceMs('five_hour', now);
  return (
    SWITCH_SCORE_WEIGHTS.weekExpiring * weekSoon * worth +
    SWITCH_SCORE_WEIGHTS.weekRoom * weekRoom +
    SWITCH_SCORE_WEIGHTS.fiveHourRoom * (fiveHourRoom + (1 - fiveHourRoom) * soon('five_hour', fiveHourSpan))
  );
}

/** Some run on the account reported one of its windows. */
function windowsKnown(windows: Record<WindowKind, AccountWindowView>): boolean {
  return WINDOW_KINDS.some((kind) => windows[kind].usedPercent !== undefined);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** `line` under a run's cap for that window, if any; a cap never raises a line. */
function withCap(line: number, kind: WindowKind, cap: LineCap | undefined): number {
  const ceiling = cap?.[kind];
  return ceiling !== undefined ? Math.min(line, ceiling) : line;
}

/** The name an account goes by: its label (for `default` without one, the CLI login's name), or today's private name for the owner. */
function displayName(
  account: Pick<ClaudeAccountEntry, 'id' | 'label' | 'nicknames'>,
  defaultLabel: string | undefined,
  view: AccountNameView,
  mood: NicknameMood,
): string {
  const nickname = view.private ? nicknameOf(account, mood) : undefined;
  if (nickname) return nickname;
  if (account.label) return account.label;
  return account.id === DEFAULT_ACCOUNT_ID ? (defaultLabel ?? 'CLI 登录') : account.id;
}

/** Every account with its usage, resets, lines, state and switch score, in preference order. */
export function accountRows(
  pool: ClaudeAccountPool,
  defaultLabel: string | undefined,
  now = Date.now(),
  view: AccountNameView = {},
): AccountRow[] {
  const next = pool.pick()?.id;
  return pool.accounts().map((account, index) => {
    const windows = pool.windowViews(account.id, now);
    const known = windowsKnown(windows);
    const refusedUntil = pool.refusedUntil(account.id, now);
    const pastLine = pool.pastLine(account.id, now)?.kind;
    return {
      id: account.id,
      name: displayName(
        account,
        defaultLabel,
        view,
        refusedUntil !== undefined ? 'sad' : account.id === next ? 'excited' : pastLine ? 'wronged' : 'happy',
      ),
      aliases: [
        account.label,
        account.id === DEFAULT_ACCOUNT_ID ? defaultLabel : undefined,
        ...(view.private ? Object.values(account.nicknames ?? {}) : []),
      ].filter((n): n is string => Boolean(n)),
      index,
      next: account.id === next,
      known,
      windows,
      ...(refusedUntil !== undefined ? { refusedUntil } : {}),
      ...(pastLine ? { pastLine } : {}),
      ready: pool.underLinesAt(account.id, now) <= now,
      boosted: pool.isBoosted(account.id, now),
      score: switchScore(windows, known, now),
    };
  });
}

/** `4h32m` — for the 5-hour window. */
export function formatHoursMinutes(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** `2d22h` — for the weekly window. */
export function formatDaysHours(ms: number): string {
  const hours = Math.max(0, Math.round(ms / 3_600_000));
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** `18% / 4h19m`; `0% / 已重置` after a reset; `—` when no run reported the window. */
function windowCell(view: AccountWindowView, format: (ms: number) => string): string {
  if (view.usedPercent === undefined) return '—';
  const reset = view.reset ? '已重置' : view.resetsInMs === undefined ? '—' : format(view.resetsInMs);
  return `${Math.round(view.usedPercent)}% / ${reset}`;
}

function stateCell(row: AccountRow): string {
  if (row.refusedUntil !== undefined) return `⛔ 额度用尽，${formatClock(row.refusedUntil)} 恢复`;
  if (row.pastLine) return `⚠️ 已过${WINDOW_LABELS[row.pastLine]}切换线`;
  if (!row.known) return '还没运行过';
  const state = row.next ? '使用中' : '可用';
  const opened = WINDOW_KINDS.filter((kind) => row.windows[kind].graceFrom !== undefined);
  return opened.length > 0 ? `${state}（${opened.map((kind) => WINDOW_LABELS[kind]).join('、')}临近重置，切换线放宽）` : state;
}

/** `60%`, or `60→98%` while the window is about to reset and its line is opened. */
function lineCell(view: AccountWindowView): string {
  return view.graceFrom !== undefined ? `${view.graceFrom}→${view.line}%` : `${view.line}%`;
}

/** The accounts as one Markdown table; ✅ marks the account new runs use. */
export function accountsTable(rows: AccountRow[]): string {
  const out = [
    '| 账户 | 5 小时用量 / 重置 | 本周用量 / 重置 | 切换线（5 小时 / 本周） | 得分 | 状态 |',
    '|---|---|---|---|---|---|',
  ];
  for (const row of rows) {
    const five = row.windows.five_hour;
    const week = row.windows.seven_day;
    const role = row.index === 0 ? '主' : `备 ${row.index}`;
    out.push(
      `| ${row.next ? '✅ ' : ''}**${row.name}**（${role}，${row.id}） | ${windowCell(five, formatHoursMinutes)} | ${windowCell(week, formatDaysHours)} | ${lineCell(five)} / ${lineCell(week)}${row.boosted ? '（临时）' : ''} | ${Math.round(row.score * 100)} | ${stateCell(row)} |`,
    );
  }
  return out.join('\n');
}

/**
 * `⏳ 先到期先用：**汤欢** 本周 2d20h 后重置，离切换线还有 39 个百分点，新任务先用它。` —
 * the ready account whose weekly room runs out first, so `/accounts` says why
 * it leads, or why it does not take the next run. Undefined when no ready
 * account has a known weekly reset.
 */
export function expiringFirstNote(rows: AccountRow[]): string | undefined {
  const left = (row: AccountRow): number => row.windows.seven_day.line - (row.windows.seven_day.usedPercent ?? 0);
  const first = rows
    .filter((row) => row.ready && row.known && row.windows.seven_day.resetsInMs !== undefined)
    .sort((a, b) => a.windows.seven_day.resetsInMs! - b.windows.seven_day.resetsInMs! || a.index - b.index)[0];
  if (!first) return undefined;
  const head = `⏳ 先到期先用：**${first.name}** 本周 ${formatDaysHours(first.windows.seven_day.resetsInMs!)} 后重置，离切换线还有 ${Math.round(left(first))} 个百分点`;
  if (first.next) return `${head}，新任务先用它。`;
  const using = rows.find((row) => row.next);
  if (!using) return `${head}。`;
  const why =
    left(first) / first.windows.seven_day.line < WORTH_MOVING_ROOM
      ? '只剩这点不值得专门换号'
      : first.score > using.score
        ? `得分领先不到 ${Math.round(STICKY_MARGIN * 100)} 分，换号要整段对话重读一遍，不值得`
        : '它的 5 小时窗口余量不多，得分没拉开';
  return `${head}；${why}，新任务暂时还用 **${using.name}**。`;
}

/**
 * The account a switch without a name goes to: the best-scoring ready one
 * other than the main account. Not "other than the one new runs would use":
 * once the main account is past a line, that one is already the best ready
 * account — excluding it handed the switch to the second best.
 */
export function bestSwitchTarget(rows: AccountRow[]): AccountRow | undefined {
  return rows
    .filter((row) => row.index !== 0 && row.ready)
    .sort((a, b) => b.score - a.score || a.index - b.index)[0];
}

/** An account by id, its label or (for `default`) the CLI login's name; case-insensitive. */
export function findAccountRow(rows: AccountRow[], query: string): AccountRow | undefined {
  const q = query.trim().toLowerCase();
  return (
    rows.find((row) => row.id.toLowerCase() === q) ??
    rows.find((row) => row.name.toLowerCase() === q) ??
    rows.find((row) => row.aliases?.some((alias) => alias.toLowerCase() === q))
  );
}

/**
 * Make `id` the main account: new runs use it first; the rest keep their
 * order. Any raised lines end here; `boost` raises the new main account's.
 */
export async function switchToAccount(
  paths: ClaudeAccountsPaths,
  id: string,
  boost?: ClaudeAccountEntry['boost'],
): Promise<ClaudeAccountsConfig> {
  const config = readAccountsConfig(paths);
  if (!config.accounts.some((a) => a.id === id)) throw new Error(`没有账户：${id}`);
  config.accounts = withMain(config.accounts, id);
  if (boost && Object.keys(boost).length > 0) config.accounts[0]!.boost = boost;
  await writeAccountsConfig(paths, config);
  return config;
}

/** `id` first, the rest in order, nobody's lines raised. */
function withMain(accounts: ClaudeAccountEntry[], id: string): ClaudeAccountEntry[] {
  const plain = accounts.map(({ boost: _raised, ...entry }) => entry);
  return [...plain.filter((a) => a.id === id), ...plain.filter((a) => a.id !== id)];
}

/**
 * A temporary line the owner asked for with a switch by name (`/accounts
 * switch <name> 95`): each window whose own line is below `line` goes up to
 * it until that window's next reset (a full window length when the reset is
 * not known). Undefined when nothing rises. A switch never raises a line on
 * its own: without `line`, the account keeps its lines.
 */
export function switchBoost(pool: ClaudeAccountPool, id: string, line: number, now = Date.now()): ClaudeAccountEntry['boost'] {
  const windows = pool.windowViews(id, now);
  const boost: Partial<Record<WindowKind, LineBoost>> = {};
  for (const kind of WINDOW_KINDS) {
    if (pool.baseLineOf(id, kind, now) >= line) continue;
    boost[kind] = { line, until: now + (windows[kind].resetsInMs ?? WINDOW_MS[kind]) };
  }
  return Object.keys(boost).length > 0 ? boost : undefined;
}

/**
 * `焦银玲` / `焦银玲 95` / `焦银玲 95%`: the account a switch names and the
 * temporary line asked for with it, if any. A trailing number is a line only
 * after a name; on its own it is a name.
 */
export function parseSwitchQuery(query: string | undefined): { name?: string; line?: number } | { error: string } {
  const words = (query ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return {};
  const last = words.length > 1 ? /^(\d{1,3})%?$/.exec(words[words.length - 1]!) : null;
  if (!last) return { name: words.join(' ') };
  const line = Number(last[1]);
  if (line < 1 || line > 100) return { error: `切换线要是 1–100 的整数：${words[words.length - 1]}` };
  return { name: words.slice(0, -1).join(' '), line };
}

/**
 * Why a switch by hand may not make `row` the main account, or undefined
 * when it may: switches obey the switch lines like every automatic move. The
 * account must not be refused and must be below each line it will have after
 * the switch — its own line, or `line` where the owner raised it for now. A
 * raise already on the account does not count: a switch replaces it.
 */
export function switchRefusal(pool: ClaudeAccountPool, row: AccountRow, line?: number): string | undefined {
  if (row.refusedUntil !== undefined) return `额度用尽，${formatClock(row.refusedUntil)} 恢复`;
  for (const kind of WINDOW_KINDS) {
    const used = row.windows[kind].usedPercent;
    const limit = Math.max(pool.baseLineOf(row.id, kind), pool.inGrace(row.id, kind) ? GRACE_LINE : 0, line ?? 0);
    if (used !== undefined && used >= limit) return `${WINDOW_LABELS[kind]}用量 ${Math.round(used)}%，已到 ${limit}% 的切换线`;
  }
  return undefined;
}
