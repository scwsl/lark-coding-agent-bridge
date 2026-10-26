import { runCapture } from '../../git/exec';
import { quotaResetAt, type QuotaReading, type QuotaReadOptions, type QuotaWindow } from '../quota';
import { claudeAccountPool, WINDOW_KINDS, WINDOW_LABELS, type ClaudeAccountPool, type WindowKind } from './accounts';

/**
 * Claude Code's subscription windows from `claude -p "/usage"` — a local
 * command that prints the account's usage and starts no model turn. Output
 * (2026-10, real sample in tests/fixtures/claude-usage.txt):
 *
 *   Current session: 4% used · resets Oct 14, 3:19am (Asia/Shanghai)
 *   Current week (all models): 50% used · resets Oct 18, 2:59pm (Asia/Shanghai)
 *   Current week (Fable): 0% used · resets Oct 18, 3pm (Asia/Shanghai)
 *
 * Model-specific weekly windows only limit that model and are left out.
 */
export async function readClaudeQuota(
  opts: QuotaReadOptions,
  binary = 'claude',
  pool: ClaudeAccountPool | undefined = opts.profileDir ? claudeAccountPool(opts.profileDir) : undefined,
): Promise<QuotaReading | undefined> {
  await pool?.refresh();
  if (!pool?.multi) return readUsage(opts, binary, {});
  // Several accounts: the profile has as much room as its emptiest account,
  // since runs move there once the others fill up. An account whose token
  // cannot read `/usage` (setup-token logins may lack the scope) is judged by
  // what its last run reported; one never used yet is left out.
  const readings: QuotaReading[] = [];
  for (const account of pool.accounts()) {
    const fresh = await readUsage(opts, binary, account.env);
    // What `/usage` just said beats what the account's last run reported,
    // which may be days old: account picks read the pool.
    if (fresh) pool.observeUsage(account.id, usageByKind(fresh));
    const reading = fresh ?? pool.quotaReading(account.id);
    if (reading) readings.push(reading);
  }
  return mostRoom(readings, opts.window);
}

/** A `/usage` reading as the pool keeps it: windows by kind, resets as epoch ms. */
export function usageByKind(reading: QuotaReading): Partial<Record<WindowKind, { usedPercent: number; resetsAt?: number }>> {
  const now = Date.now();
  const out: Partial<Record<WindowKind, { usedPercent: number; resetsAt?: number }>> = {};
  for (const kind of WINDOW_KINDS) {
    const window = reading.windows.find((w) => w.label === WINDOW_LABELS[kind]);
    if (!window) continue;
    const resetsAt = quotaResetAt(window.resets, now);
    out[kind] = { usedPercent: window.usedPercent, ...(resetsAt !== undefined ? { resetsAt } : {}) };
  }
  return out;
}

async function readUsage(opts: QuotaReadOptions, binary: string, env: Record<string, string>): Promise<QuotaReading | undefined> {
  const result = await runCapture(binary, opts.cwd, ['-p', '/usage'], {
    timeoutMs: opts.timeoutMs ?? 60_000,
    maxBytes: 64_000,
    env,
  });
  if (!result.ok) return undefined;
  const windows = parseClaudeUsage(result.stdout);
  return windows.length > 0 ? { windows } : undefined;
}

/** The reading whose fullest window is the emptiest; a blocked account counts as full. */
function mostRoom(readings: QuotaReading[], window: 'any' | 'week' = 'any'): QuotaReading | undefined {
  const fullness = (reading: QuotaReading): number => {
    if (reading.blocked) return 100;
    const week = window === 'week' ? reading.windows.find((w) => w.label === WINDOW_LABELS.seven_day) : undefined;
    return week ? week.usedPercent : Math.max(0, ...reading.windows.map((w) => w.usedPercent));
  };
  return [...readings].sort((a, b) => fullness(a) - fullness(b))[0];
}

export function parseClaudeUsage(text: string): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const raw of text.split('\n')) {
    const match = /^\s*Current ([^:]+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/.exec(raw);
    if (!match) continue;
    const scope = match[1]!.trim();
    const label = scope === 'session' ? '5 小时窗口' : scope === 'week (all models)' ? '本周' : undefined;
    if (!label) continue;
    windows.push({ label, usedPercent: Number(match[2]), ...(match[3] ? { resets: match[3] } : {}) });
  }
  return windows;
}
