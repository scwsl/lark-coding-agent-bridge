import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getSecret, removeSecret, setSecret, type KeystorePaths } from '../../config/keystore';
import { log } from '../../core/logger';
import { writeFileAtomic } from '../../platform/atomic-write';
import type { AgentEvent } from '../types';
import type { QuotaReading, QuotaWindow } from '../quota';

/**
 * Several Claude subscription accounts behind one profile, so a run can move
 * to another account when the current one's quota runs out.
 *
 * Only the credential differs between accounts: an extra account is a
 * long-lived token from `claude setup-token`, handed to the claude process as
 * `CLAUDE_CODE_OAUTH_TOKEN`. Everything else — the config directory, the
 * session transcripts `--resume` reads, settings, skills — stays the CLI's
 * own, so a conversation carries on across accounts. `default` is the CLI's
 * own login and is always on the list.
 *
 * Files in the profile directory:
 *   - `claude-accounts.json`: the list, in order of preference, and the
 *     switch threshold. Re-read whenever it changes, no restart needed.
 *   - `claude-accounts-state.json`: what each account's last run said about
 *     its quota (`rate_limit_event`), and until when a refusal benched it.
 *   - the profile keystore (`secrets.enc`) holds the tokens, as
 *     `claude-oauth-<id>`.
 */

export const DEFAULT_ACCOUNT_ID = 'default';
export const DEFAULT_SWITCH_AT_PERCENT = 98;
/** How long a refusal benches an account when the CLI did not say when it resets. */
const UNKNOWN_RESET_MS = 60 * 60_000;
/** The windows that limit every model; model-specific weekly windows only count when they refuse. */
const ACCOUNT_WINDOWS: Record<string, string> = { five_hour: '5 小时窗口', seven_day: '本周' };
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export interface ClaudeAccountEntry {
  id: string;
  /** Shown on the reply card's `Sponsor:` line. The CLI's own login reads its name from `claude auth status`. */
  label?: string;
}

export interface ClaudeAccountsConfig {
  /** Move off an account before running once a window is this full (0–100). */
  switchAtPercent: number;
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

export function defaultAccountsConfig(): ClaudeAccountsConfig {
  return { switchAtPercent: DEFAULT_SWITCH_AT_PERCENT, accounts: [{ id: DEFAULT_ACCOUNT_ID }] };
}

/** Tolerant parse: malformed entries are dropped, `default` is added in front when missing. */
export function parseAccountsConfig(text: string): ClaudeAccountsConfig {
  const config = defaultAccountsConfig();
  let raw: { switchAtPercent?: unknown; accounts?: unknown };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    return config;
  }
  if (!raw || typeof raw !== 'object') return config;
  if (typeof raw.switchAtPercent === 'number' && raw.switchAtPercent > 0 && raw.switchAtPercent <= 100) {
    config.switchAtPercent = raw.switchAtPercent;
  }
  const accounts: ClaudeAccountEntry[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw.accounts) ? raw.accounts : []) {
    if (!item || typeof item !== 'object') continue;
    const { id, label } = item as { id?: unknown; label?: unknown };
    if (typeof id !== 'string' || !isValidAccountId(id) || seen.has(id)) continue;
    seen.add(id);
    accounts.push({ id, ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}) });
  }
  if (!seen.has(DEFAULT_ACCOUNT_ID)) accounts.unshift({ id: DEFAULT_ACCOUNT_ID });
  config.accounts = accounts;
  return config;
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

/** Add (or replace the token / label of) an account; new ones go last in the preference order. */
export async function saveAccount(
  paths: ClaudeAccountsPaths,
  account: { id: string; label?: string; token: string },
): Promise<ClaudeAccountsConfig> {
  if (account.id === DEFAULT_ACCOUNT_ID) throw new Error('default 是 CLI 自己的登录，不能存令牌');
  if (!isValidAccountId(account.id)) throw new Error(`账号 id 只能用字母、数字、- 和 _（最长 32 位）：${account.id}`);
  await setSecret(accountSecretId(account.id), account.token, paths.keystore);
  const config = readAccountsConfig(paths);
  const label = account.label?.trim();
  const existing = config.accounts.find((a) => a.id === account.id);
  if (existing) {
    if (label) existing.label = label;
  } else {
    config.accounts.push({ id: account.id, ...(label ? { label } : {}) });
  }
  await writeAccountsConfig(paths, config);
  return config;
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

  get switchAtPercent(): number {
    return this.config.switchAtPercent;
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
   * The account a new run should use: the first in preference order with room
   * left — so the main account is back in use as soon as its window resets.
   * When none has room, the one that frees up first.
   */
  pick(exclude?: ReadonlySet<string>): PickedAccount | undefined {
    const now = this.now();
    const candidates = this.accounts().filter((a) => !exclude?.has(a.id));
    const ready = candidates.find((a) => this.availableAt(a.id, now) <= now);
    if (ready) return ready;
    return [...candidates].sort((a, b) => this.availableAt(a.id, now) - this.availableAt(b.id, now))[0];
  }

  /** Like {@link pick}, but only an account that has room right now. */
  pickReady(exclude?: ReadonlySet<string>): PickedAccount | undefined {
    const now = this.now();
    return this.accounts().find((a) => !exclude?.has(a.id) && this.availableAt(a.id, now) <= now);
  }

  /** When the first account frees up; undefined when one has room now. */
  nextFreeAt(): number | undefined {
    const now = this.now();
    let soonest: number | undefined;
    for (const account of this.accounts()) {
      const at = this.availableAt(account.id, now);
      if (at <= now) return undefined;
      soonest = soonest === undefined ? at : Math.min(soonest, at);
    }
    return soonest;
  }

  /** When the account can take work again: now when it has room, else the reset that frees it. */
  availableAt(id: string, now = this.now()): number {
    const state = this.loadState()[id];
    if (!state) return now;
    let at = now;
    if (state.blockedUntil !== undefined && state.blockedUntil > now) at = state.blockedUntil;
    for (const [kind, window] of Object.entries(state.windows)) {
      if (!(kind in ACCOUNT_WINDOWS) || window.usedPercent < this.config.switchAtPercent) continue;
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
    for (const [kind, label] of Object.entries(ACCOUNT_WINDOWS)) {
      const window = state.windows[kind];
      if (!window) continue;
      const reset = window.resetsAt !== undefined && window.resetsAt <= now;
      windows.push({
        label,
        usedPercent: reset ? 0 : window.usedPercent,
        ...(window.resetsAt !== undefined && !reset ? { resets: new Date(window.resetsAt).toISOString() } : {}),
      });
    }
    const blocked = state.blockedUntil !== undefined && state.blockedUntil > now;
    if (windows.length === 0 && !blocked) return undefined;
    return { windows, ...(blocked ? { blocked: true } : {}) };
  }

  /** Each account with its last known quota, for status displays. */
  status(): Array<{ account: PickedAccount; state?: AccountQuotaState; availableAt: number }> {
    const now = this.now();
    const all = this.loadState();
    return this.accounts().map((account) => ({
      account,
      ...(all[account.id] ? { state: all[account.id] } : {}),
      availableAt: this.availableAt(account.id, now),
    }));
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
 * go to (▶), how full each is by its last report, and until when a spent one
 * sits out. `defaultLabel` names the CLI's own login.
 */
export function accountsReport(pool: ClaudeAccountPool, defaultLabel: string | undefined, now = Date.now()): string[] {
  const next = pool.pick()?.id;
  return pool.status().map(({ account, state, availableAt }) => {
    const name = account.id === DEFAULT_ACCOUNT_ID ? (defaultLabel ?? 'CLI 登录') : (account.label ?? account.id);
    const marker = account.id === next ? '▶ ' : '';
    const windows = Object.entries(ACCOUNT_WINDOWS)
      .map(([kind, label]) => {
        const window = state?.windows[kind];
        if (!window) return undefined;
        const used = window.resetsAt !== undefined && window.resetsAt <= now ? 0 : window.usedPercent;
        return `${label} ${Math.round(used)}%`;
      })
      .filter((part): part is string => part !== undefined);
    const usage = windows.length > 0 ? windows.join(' · ') : '还没有运行记录';
    const rest = availableAt > now ? ` · ⛔ 额度用尽，${formatClock(availableAt)} 恢复` : '';
    return `- ${marker}**${name}**（${account.id}）：${usage}${rest}`;
  });
}

/** `10-21 15:00` in the machine's time zone. */
function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
