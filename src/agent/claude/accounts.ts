import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getSecret, removeSecret, setSecret, type KeystorePaths } from '../../config/keystore';
import { log } from '../../core/logger';
import { writeFileAtomic } from '../../platform/atomic-write';
import type { AgentEvent } from '../types';
import type { QuotaReading, QuotaWindow } from '../quota';

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
 *      5-hour and weekly; per account or the profile's default): the main
 *      one (first on the list) while it is, else the one with the best
 *      switch score ({@link switchScore});
 *   2. once every account is past a line: of those not refused, the same
 *      way — accounts are used up one after another;
 *   3. once every account has been refused: the run waits for the soonest
 *      reset (it pauses and resumes on its own).
 * The account a run moves to becomes the main one (top of the list), so new
 * runs stay on it until it reaches a line in turn instead of going back and
 * forth as the scores shift.
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

/** Fill (1–100%) per window at which runs move to another account. */
export type SwitchLines = Record<WindowKind, number>;
export const DEFAULT_LINES: SwitchLines = { five_hour: 98, seven_day: 98 };

export interface ClaudeAccountEntry {
  id: string;
  /** Shown on the reply card's `Sponsor:` line. The CLI's own login reads its name from `claude auth status`. */
  label?: string;
  /** This account's own lines; a window left out follows the profile's. */
  lines?: Partial<SwitchLines>;
}

export interface ClaudeAccountsConfig {
  lines: SwitchLines;
  /** Preference order; `default` is always present. */
  accounts: ClaudeAccountEntry[];
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
  let raw: { lines?: unknown; switchAtPercent?: unknown; accounts?: unknown };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    return config;
  }
  if (!raw || typeof raw !== 'object') return config;
  if (isValidLine(raw.switchAtPercent)) config.lines = { five_hour: raw.switchAtPercent, seven_day: raw.switchAtPercent };
  config.lines = { ...config.lines, ...parseLines(raw.lines) };
  const accounts: ClaudeAccountEntry[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw.accounts) ? raw.accounts : []) {
    if (!item || typeof item !== 'object') continue;
    const { id, label, lines, reservePercent } = item as {
      id?: unknown;
      label?: unknown;
      lines?: unknown;
      reservePercent?: unknown;
    };
    if (typeof id !== 'string' || !isValidAccountId(id) || seen.has(id)) continue;
    seen.add(id);
    const legacy =
      typeof reservePercent === 'number' && isValidLine(100 - reservePercent)
        ? { five_hour: 100 - reservePercent, seven_day: 100 - reservePercent }
        : {};
    const own = { ...legacy, ...parseLines(lines) };
    accounts.push({
      id,
      ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
      ...(Object.keys(own).length > 0 ? { lines: own } : {}),
    });
  }
  if (!seen.has(DEFAULT_ACCOUNT_ID)) accounts.unshift({ id: DEFAULT_ACCOUNT_ID });
  config.accounts = accounts;
  return config;
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

/** Put the named accounts first, in the order given; the rest keep their order after them. */
export async function reorderAccounts(paths: ClaudeAccountsPaths, ids: string[]): Promise<ClaudeAccountsConfig> {
  const config = readAccountsConfig(paths);
  const known = new Set(config.accounts.map((a) => a.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`没有账户：${unknown.join(', ')}`);
  if (new Set(ids).size !== ids.length) throw new Error('账户重复了');
  const first = ids.map((id) => config.accounts.find((a) => a.id === id)!);
  config.accounts = [...first, ...config.accounts.filter((a) => !ids.includes(a.id))];
  await writeAccountsConfig(paths, config);
  return config;
}

function applyAccountChanges(config: ClaudeAccountsConfig, id: string, changes: AccountChanges): void {
  const entry = config.accounts.find((a) => a.id === id)!;
  const label = changes.label?.trim();
  if (label) entry.label = label;
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

  constructor(private readonly opts: ClaudeAccountPoolOptions) {
    this.now = opts.now ?? Date.now;
    this.readSecret = opts.readSecret ?? ((id) => getSecret(id, opts.paths.keystore));
  }

  /** Re-read the account list when its file changed and decrypt the tokens. Never throws. */
  async refresh(): Promise<void> {
    this.loadState();
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

  /** The profile's lines (accounts without their own follow these). */
  get defaultLines(): SwitchLines {
    return { ...this.config.lines };
  }

  /** The line (1–100) at which runs leave the account in `kind`'s window. */
  lineOf(id: string, kind: WindowKind): number {
    return this.config.accounts.find((a) => a.id === id)?.lines?.[kind] ?? this.config.lines[kind];
  }

  /** Accounts that can run, in order of preference: the CLI's own login and those with a token. */
  accounts(): PickedAccount[] {
    return this.config.accounts
      .filter((a) => a.id === DEFAULT_ACCOUNT_ID || this.tokens.has(a.id))
      .map((a) => this.toPicked(a));
  }

  /** More than one account to choose from. */
  get multi(): boolean {
    return this.accounts().length > 1;
  }

  /**
   * The account a new run should use (see the rounds in the module comment):
   * below its lines, else not refused, else the one whose refusal ends first —
   * tried anyway, the refusal may be over (the run pauses if it is not).
   */
  pick(exclude?: ReadonlySet<string>): PickedAccount | undefined {
    const now = this.now();
    return (
      this.pickRunnable(exclude) ??
      this.accounts()
        .filter((a) => !exclude?.has(a.id))
        .sort((a, b) => (this.refusedUntil(a.id, now) ?? now) - (this.refusedUntil(b.id, now) ?? now))[0]
    );
  }

  /** Round 1, else round 2: never an account that is still refused. */
  pickRunnable(exclude?: ReadonlySet<string>): PickedAccount | undefined {
    const now = this.now();
    return this.pickReady(exclude) ?? this.choose(exclude, (id) => !this.isRefused(id, now), now);
  }

  /** Round 1 only: an account below all its lines. */
  pickReady(exclude?: ReadonlySet<string>): PickedAccount | undefined {
    const now = this.now();
    return this.choose(exclude, (id) => this.underLinesAt(id, now) <= now, now);
  }

  /**
   * Of the accounts `ok` lets through: the main one while it is among them,
   * else the best switch score; ties keep the list's order.
   */
  private choose(
    exclude: ReadonlySet<string> | undefined,
    ok: (id: string) => boolean,
    now: number,
  ): PickedAccount | undefined {
    const all = this.accounts();
    const candidates = all.filter((a) => !exclude?.has(a.id) && ok(a.id));
    if (candidates[0] && candidates[0].id === all[0]?.id) return candidates[0];
    let best: PickedAccount | undefined;
    let bestScore = -1;
    for (const account of candidates) {
      const score = this.score(account.id, now);
      if (score > bestScore) {
        best = account;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * Put `id` at the top of the list once a run moved to it, so new runs stay
   * on it until it reaches a line too. Takes effect at once; the file follows.
   */
  promote(id: string): void {
    const accounts = this.config.accounts;
    const entry = accounts.find((a) => a.id === id);
    if (!entry || accounts[0]?.id === id) return;
    this.config = { ...this.config, accounts: [entry, ...accounts.filter((a) => a.id !== id)] };
    log.info('claude-accounts', 'promote', { id });
    this.writing = this.writing
      .then(() => reorderAccounts(this.opts.paths, [id]))
      .then(() => undefined)
      .catch((err: unknown) => log.warn('claude-accounts', 'promote-write-failed', { id, err: String(err) }));
  }

  /** Each window as the switch score and `/accounts` read it. */
  windowViews(id: string, now = this.now()): Record<WindowKind, AccountWindowView> {
    const state = this.loadState()[id];
    const windows = {} as Record<WindowKind, AccountWindowView>;
    for (const kind of WINDOW_KINDS) {
      const window = state?.windows[kind];
      const line = this.lineOf(id, kind);
      if (!window) {
        windows[kind] = { line };
        continue;
      }
      const reset = window.resetsAt !== undefined && window.resetsAt <= now;
      windows[kind] = {
        line,
        usedPercent: reset ? 0 : window.usedPercent,
        ...(reset ? { reset: true } : window.resetsAt !== undefined ? { resetsInMs: window.resetsAt - now } : {}),
      };
    }
    return windows;
  }

  /** The account's switch score, 0–1 ({@link switchScore}). */
  score(id: string, now = this.now()): number {
    const windows = this.windowViews(id, now);
    return switchScore(windows, windowsKnown(windows));
  }

  /** The account is below all its lines and not refused right now. */
  hasRoom(id: string): boolean {
    const now = this.now();
    return this.underLinesAt(id, now) <= now;
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
  pastLine(id: string, now = this.now()): { kind: WindowKind; line: number } | undefined {
    const state = this.loadState()[id];
    if (!state) return undefined;
    for (const kind of WINDOW_KINDS) {
      const window = state.windows[kind];
      const line = this.lineOf(id, kind);
      if (!window || window.usedPercent < line) continue;
      const until = window.resetsAt ?? state.updatedAt + UNKNOWN_RESET_MS;
      if (until > now) return { kind, line };
    }
    return undefined;
  }

  /** When the account is below all its lines and not refused: now, or the reset that gets it there. */
  underLinesAt(id: string, now = this.now()): number {
    const state = this.loadState()[id];
    if (!state) return now;
    let at = this.refusedUntil(id, now) ?? now;
    for (const kind of WINDOW_KINDS) {
      const window = state.windows[kind];
      if (!window || window.usedPercent < this.lineOf(id, kind)) continue;
      const until = window.resetsAt ?? state.updatedAt + UNKNOWN_RESET_MS;
      if (until > at) at = until;
    }
    return at;
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
export function accountsReport(pool: ClaudeAccountPool, defaultLabel: string | undefined, now = Date.now()): string[] {
  const next = pool.pick()?.id;
  return pool.status().map(({ account, state }, index) => {
    const name = account.id === DEFAULT_ACCOUNT_ID ? (defaultLabel ?? 'CLI 登录') : (account.label ?? account.id);
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
    const refused = pool.refusedUntil(account.id, now);
    const past = pool.pastLine(account.id, now);
    const flag =
      refused !== undefined
        ? ` · ⛔ 额度用尽，${formatClock(refused)} 恢复`
        : past
          ? ` · ⚠️ 已过${WINDOW_LABELS[past.kind]}切换线，其他账户也到线后才轮到它`
          : '';
    return `- ${marker}**${name}**（${role}，${account.id}；${lines}）：${usage}${flag}`;
  });
}

/** `10-21 15:00` in the machine's time zone. */
function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Account table and switching (`/accounts`, `claude-account switch`) ─────

/** Weights of the switch score: room left first, then how soon the tighter window resets. */
export const SWITCH_SCORE_WEIGHTS = { room: 0.6, reset: 0.4 } as const;
/** Room assumed for an account that has never run here (its token is untested). */
const UNKNOWN_ROOM = 0.5;
const WINDOW_MS: Record<WindowKind, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 };

export interface AccountWindowView {
  /** 0–100; undefined when no run reported this window yet. */
  usedPercent?: number;
  /** Until the window resets; undefined when unknown. */
  resetsInMs?: number;
  /** The window reset since the last report, so the usage reads 0. */
  reset?: boolean;
  /** The account's switch line for this window (1–100). */
  line: number;
}

export interface AccountRow {
  id: string;
  /** The label, or the CLI login's name for `default`. */
  name: string;
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
  /** 0–1, see {@link switchScore}. */
  score: number;
}

/**
 * How good a switch target an account is, 0–1:
 * `0.6 × room + 0.4 × resetSoon`, where room is what is left before the
 * tighter of its two lines (1 − the larger of used ÷ line per window), and
 * resetSoon is how close that same window is to resetting (1 − time left ÷
 * window length). Little used wins; between similar ones, the one whose
 * limiting window frees up soonest. An account that never ran here counts as
 * half full with no reset known, so a proven account with room comes first.
 */
export function switchScore(windows: Record<WindowKind, AccountWindowView>, known: boolean): number {
  if (!known) return SWITCH_SCORE_WEIGHTS.room * UNKNOWN_ROOM;
  // The weekly window wins ties: with both empty, its reset is the one worth spending before.
  let tight: WindowKind = 'five_hour';
  let ratio = -1;
  for (const kind of WINDOW_KINDS) {
    const r = (windows[kind].usedPercent ?? 0) / windows[kind].line;
    if (r >= ratio) {
      ratio = r;
      tight = kind;
    }
  }
  const room = clamp01(1 - ratio);
  const left = windows[tight].resetsInMs;
  const soon = left === undefined ? 0 : clamp01(1 - left / WINDOW_MS[tight]);
  return SWITCH_SCORE_WEIGHTS.room * room + SWITCH_SCORE_WEIGHTS.reset * soon;
}

/** Some run on the account reported one of its windows. */
function windowsKnown(windows: Record<WindowKind, AccountWindowView>): boolean {
  return WINDOW_KINDS.some((kind) => windows[kind].usedPercent !== undefined);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Every account with its usage, resets, lines, state and switch score, in preference order. */
export function accountRows(pool: ClaudeAccountPool, defaultLabel: string | undefined, now = Date.now()): AccountRow[] {
  const next = pool.pick()?.id;
  return pool.accounts().map((account, index) => {
    const windows = pool.windowViews(account.id, now);
    const known = windowsKnown(windows);
    const refusedUntil = pool.refusedUntil(account.id, now);
    const pastLine = pool.pastLine(account.id, now)?.kind;
    return {
      id: account.id,
      name: account.id === DEFAULT_ACCOUNT_ID ? (defaultLabel ?? 'CLI 登录') : (account.label ?? account.id),
      index,
      next: account.id === next,
      known,
      windows,
      ...(refusedUntil !== undefined ? { refusedUntil } : {}),
      ...(pastLine ? { pastLine } : {}),
      ready: pool.underLinesAt(account.id, now) <= now,
      score: switchScore(windows, known),
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
  return row.next ? '使用中' : '可用';
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
      `| ${row.next ? '✅ ' : ''}**${row.name}**（${role}，${row.id}） | ${windowCell(five, formatHoursMinutes)} | ${windowCell(week, formatDaysHours)} | ${five.line}% / ${week.line}% | ${Math.round(row.score * 100)} | ${stateCell(row)} |`,
    );
  }
  return out.join('\n');
}

/** The account a switch without a name goes to: the best-scoring ready one other than the current. */
export function bestSwitchTarget(rows: AccountRow[]): AccountRow | undefined {
  return rows
    .filter((row) => !row.next && row.ready)
    .sort((a, b) => b.score - a.score || a.index - b.index)[0];
}

/** An account by id, its label or (for `default`) the CLI login's name; case-insensitive. */
export function findAccountRow(rows: AccountRow[], query: string): AccountRow | undefined {
  const q = query.trim().toLowerCase();
  return rows.find((row) => row.id.toLowerCase() === q) ?? rows.find((row) => row.name.toLowerCase() === q);
}

/** Make `id` the main account: new runs use it first; the rest keep their order. */
export async function switchToAccount(paths: ClaudeAccountsPaths, id: string): Promise<ClaudeAccountsConfig> {
  return reorderAccounts(paths, [id]);
}
