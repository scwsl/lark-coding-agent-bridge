import { log } from '../../core/logger';
import type { ClaudeAccountPool, PickedAccount } from './accounts';
import { warmAccountWindow } from './quota-probe';

/**
 * Keep the accounts' 5-hour windows evenly staggered.
 *
 * A 5-hour window starts at the first request after the previous one ran out
 * and resets five hours later, whatever was used in it. Left alone, idle
 * accounts' windows open together — one `/accounts` probes them all in the
 * same minute — and so reset together: a big run that drains several of them
 * then waits for all of them at once. Staggered, with N accounts one resets
 * every 5h ÷ N, and the bridge waits at most that long for the next one.
 *
 * How: every account's next window gets a slot on one even grid (spacing
 * 5h ÷ N, laid on the main account's next start: new runs use it, so it is
 * never put off), and when the account's window has run out and its slot
 * comes, one tiny haiku request opens the next window there
 * ({@link warmAccountWindow}). A window can only be opened later, never
 * earlier, so a slot is the next grid time at or after the account's reset;
 * of the ways to lay the accounts on the grid, the one that puts them off
 * least in total wins, accounts in use counting double (idle ones are moved
 * first). Once on the
 * grid, each window is reopened right at its reset and keeps its place —
 * runs land inside an open window and move nothing. A run on an account
 * whose window had run out opens it off the grid; the next reset moves it
 * back. Waiting for its slot costs the account nothing: its window is empty
 * and any run may still use it.
 *
 * Paused accounts take no part. The owner can turn it off
 * (`claude-account stagger off`).
 */

export const FIVE_HOUR_MS = 5 * 3_600_000;
const MIN = 60_000;
/** Opened this long after the reset the last reading gave, so the server has rolled the window over. */
export const AFTER_RESET_MS = MIN;
/**
 * A window starting this close to its slot counts as on it: windows start on
 * a coarse clock (resets come in 10-minute steps), and chasing the last few
 * minutes would only shift the grid round and round.
 */
const SLOT_TOLERANCE_MS = 15 * MIN;
/**
 * How often the plan is checked: a window opens up to this late after its
 * slot (well inside the 5h ÷ N spacing), for a sixth of the wake-ups.
 */
const TICK_MS = 10 * MIN;
/** The plan is exact over subsets of accounts; past this many the rest are left as runs open them. */
const MAX_ACCOUNTS = 12;
/** A warm-up that failed, or did not open a window, is tried again after this. */
const RETRY_MS = 10 * MIN;

export interface StaggerInput {
  id: string;
  /** When the 5-hour window by the last reading resets (epoch ms; past or undefined: none is open). */
  resetsAt?: number;
  /**
   * The main account, which new runs use: never put off — a run would open
   * its window at once anyway, off the grid — and the grid is laid on it.
   */
  main?: boolean;
  /** Something was used in its open window: likely used again soon, so put off only when the idle ones cannot fill the gaps. */
  busy?: boolean;
}

export interface StaggerSlot {
  id: string;
  /** When to open the account's next window (epoch ms). */
  warmAt: number;
  /** How long after its window could first open that is. */
  delayMs: number;
  /** A window is open now (it resets at `warmAt − delayMs − AFTER_RESET_MS`). */
  open: boolean;
}

/** Putting the main account off costs this many times a delay elsewhere: in practice never. */
const MAIN_WEIGHT = 1_000;
const BUSY_WEIGHT = 2;

/**
 * Where each account's next 5-hour window should start so that, with N
 * accounts, one resets every `spanMs ÷ N`. Pure; see the module comment.
 */
export function planStagger(accounts: StaggerInput[], now: number, spanMs = FIVE_HOUR_MS): StaggerSlot[] {
  const n = accounts.length;
  const items = accounts.map((a) => {
    const open = a.resetsAt !== undefined && a.resetsAt + AFTER_RESET_MS > now;
    const weight = a.main ? MAIN_WEIGHT : a.busy && open ? BUSY_WEIGHT : 1;
    return { id: a.id, open, weight, base: open ? a.resetsAt! + AFTER_RESET_MS : now };
  });
  if (n < 2) return items.map((i) => ({ id: i.id, warmAt: i.base, delayMs: 0, open: i.open }));
  const step = spanMs / n;
  const tol = Math.min(SLOT_TOLERANCE_MS, step / 4);
  const delayTo = (slot: number, base: number): number => {
    const d = mod(slot - base, spanMs);
    return d <= tol || d >= spanMs - tol ? 0 : d;
  };
  // Lay the grid on the main account's next start, else on an open window's
  // reset (never on `now` while something is open: it moves); with none, on now.
  const main = items.find((_, i) => accounts[i]!.main);
  const anchors = main ? [main.base] : items.filter((i) => i.open).map((i) => i.base);
  if (anchors.length === 0) anchors.push(now);
  let best: Assignment | undefined;
  for (const anchor of anchors) {
    const delays = items.map((item) => Array.from({ length: n }, (_, j) => delayTo(anchor + j * step, item.base)));
    const found = assign(delays, items.map((i) => i.weight));
    if (!best || found.total < best.total - 1 || (Math.abs(found.total - best.total) <= 1 && found.worst < best.worst)) {
      best = found;
    }
  }
  return items.map((item, i) => {
    const delayMs = best!.delays[i]!;
    return { id: item.id, warmAt: item.base + delayMs, delayMs, open: item.open };
  });
}

interface Assignment {
  /** Per account, its delay (ms) in the chosen slot. */
  delays: number[];
  /** Weighted sum of the delays. */
  total: number;
  /** The longest single delay. */
  worst: number;
}

/**
 * Accounts to slots, one each, by least weighted total delay (then least
 * longest delay): exact, over subsets of slots — a handful of accounts.
 */
function assign(delays: number[][], weights: number[]): Assignment {
  const n = delays.length;
  const size = 1 << n;
  const total = new Array<number>(size).fill(Infinity);
  const worst = new Array<number>(size).fill(Infinity);
  const from = new Array<number>(size).fill(-1);
  total[0] = 0;
  worst[0] = 0;
  for (let mask = 0; mask < size; mask++) {
    if (total[mask] === Infinity) continue;
    const i = popcount(mask);
    if (i >= n) continue;
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      const next = mask | (1 << j);
      const d = delays[i]![j]!;
      const t = total[mask]! + weights[i]! * d;
      const w = Math.max(worst[mask]!, d);
      if (t < total[next]! - 1 || (Math.abs(t - total[next]!) <= 1 && w < worst[next]!)) {
        total[next] = t;
        worst[next] = w;
        from[next] = j;
      }
    }
  }
  const out = new Array<number>(n);
  let mask = size - 1;
  for (let i = n - 1; i >= 0; i--) {
    const j = from[mask]!;
    out[i] = delays[i]![j]!;
    mask &= ~(1 << j);
  }
  return { delays: out, total: total[size - 1]!, worst: worst[size - 1]! };
}

function popcount(mask: number): number {
  let count = 0;
  for (let m = mask; m; m &= m - 1) count++;
  return count;
}

function mod(value: number, span: number): number {
  return ((value % span) + span) % span;
}

/**
 * The accounts the stagger spaces out: every one runs may use, less the
 * paused ones and those refused for longer than a 5-hour window (out of their
 * weekly quota: nothing to open until the week resets).
 */
export function staggerInputs(pool: ClaudeAccountPool, now: number): StaggerInput[] {
  const main = pool.accounts()[0]?.id;
  return pool
    .accounts()
    .filter((account) => (pool.refusedUntil(account.id, now) ?? 0) <= now + FIVE_HOUR_MS)
    .slice(0, MAX_ACCOUNTS)
    .map((account) => {
      const resetsAt = pool.fiveHourResetsAt(account.id);
      return {
        id: account.id,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(account.id === main ? { main: true } : {}),
        ...((pool.windowUsed(account.id, 'five_hour', now) ?? 0) >= 1 ? { busy: true } : {}),
      };
    });
}

/** The current plan, for `/accounts`; empty when the stagger is off or there is one account. */
export function currentStaggerPlan(pool: ClaudeAccountPool, now = Date.now()): StaggerSlot[] {
  if (!pool.staggerEnabled || !pool.multi) return [];
  return planStagger(staggerInputs(pool, now), now);
}

export type WindowWarmer = (pool: ClaudeAccountPool, account: PickedAccount) => Promise<boolean>;

export interface WindowStaggerOptions {
  pool: ClaudeAccountPool;
  /** Opens one account's window; injected in tests. */
  warm?: WindowWarmer;
  binary?: string;
  now?: () => number;
  tickMs?: number;
}

export interface WindowStagger {
  /** One round: open the windows whose slot has come. Exposed for tests. */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

/** Check every 10 minutes and open each account's next window once its slot has come. */
export function startWindowStagger(opts: WindowStaggerOptions): WindowStagger {
  const now = opts.now ?? Date.now;
  const warm = opts.warm ?? ((pool, account) => warmAccountWindow(pool, account, opts.binary));
  const retryAt = new Map<string, number>();
  let running: Promise<void> | undefined;
  let stopped = false;

  const round = async (): Promise<void> => {
    const pool = opts.pool;
    await pool.refresh();
    if (!pool.staggerEnabled || !pool.multi) return;
    const at = now();
    const accounts = new Map(pool.accounts().map((a) => [a.id, a]));
    for (const slot of planStagger(staggerInputs(pool, at), at)) {
      if (stopped) return;
      if (slot.open || slot.warmAt > at) continue;
      if (pool.isRefused(slot.id, at)) continue;
      if ((retryAt.get(slot.id) ?? 0) > at) continue;
      const account = accounts.get(slot.id);
      if (!account) continue;
      const ok = await warm(pool, account).catch((err: unknown) => {
        log.warn('claude-accounts', 'window-warm-failed', { id: slot.id, err: String(err) });
        return false;
      });
      const resetsAt = pool.fiveHourResetsAt(slot.id);
      const opened = ok && resetsAt !== undefined && resetsAt > now();
      if (opened) retryAt.delete(slot.id);
      else retryAt.set(slot.id, now() + RETRY_MS);
      log.info('claude-accounts', 'window-warmed', {
        id: slot.id,
        opened,
        delayMin: Math.round(slot.delayMs / MIN),
        ...(resetsAt !== undefined ? { resetsAt: new Date(resetsAt).toISOString() } : {}),
      });
    }
  };

  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (!running) {
      running = round()
        .catch((err: unknown) => log.warn('claude-accounts', 'window-stagger-failed', { err: String(err) }))
        .finally(() => {
          running = undefined;
        });
    }
    return running;
  };

  const timer = setInterval(() => void tick(), opts.tickMs ?? TICK_MS);
  timer.unref();
  return {
    tick,
    // A warm-up in flight finishes on its own (its reading still lands);
    // shutdown does not wait the up to 30 seconds it may take.
    async stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
