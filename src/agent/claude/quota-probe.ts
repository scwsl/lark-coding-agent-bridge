import { tmpdir } from 'node:os';
import { runCapture } from '../../git/exec';
import { log } from '../../core/logger';
import type { ClaudeAccountPool, LineCap, PickedAccount } from './accounts';
import { parseClaudeUsage, usageByKind } from './quota';
import { translateEvent } from './stream-json';

/**
 * Quota older than this is checked again before a run starts on the account.
 * Accounts are shared with their owners (claude.ai, their own Claude Code), so
 * what the bridge last saw can be well behind.
 */
export const QUOTA_FRESH_MS = 15 * 60_000;
/** Accounts checked per run start at most: each check can take a few seconds. */
const MAX_PROBES_PER_RUN = 3;
const PROBE_TIMEOUT_MS = 30_000;
/** `/accounts` reads every account afresh, except one a run or probe reported this recently. */
export const ACCOUNTS_FRESH_MS = 60_000;

/** Read one account's quota into the pool; false when the reading failed (void counts as read). */
export type QuotaProbe = (pool: ClaudeAccountPool, account: PickedAccount) => Promise<boolean | void>;

/**
 * Before a run: make sure the account it would get has a recent quota reading,
 * re-reading the stale ones and picking again (the reading can move the pick
 * elsewhere). Accounts checked within {@link QUOTA_FRESH_MS} are not checked
 * again, whatever the outcome. Never throws.
 */
export async function refreshPickQuota(
  pool: ClaudeAccountPool,
  opts: { cap?: LineCap; probe?: QuotaProbe; checkedAt: Map<string, number>; now?: () => number },
): Promise<void> {
  const now = opts.now ?? Date.now;
  const probe = opts.probe ?? probeAccountQuota;
  for (let i = 0; i < MAX_PROBES_PER_RUN; i++) {
    const account = pool.pick(undefined, opts.cap);
    if (!account) return;
    const at = now();
    const seen = Math.max(pool.reportedAt(account.id) ?? 0, opts.checkedAt.get(account.id) ?? 0);
    if (at - seen < QUOTA_FRESH_MS) return;
    opts.checkedAt.set(account.id, at);
    await probe(pool, account).catch((err: unknown) =>
      log.warn('claude-accounts', 'quota-probe-failed', { id: account.id, err: String(err) }),
    );
  }
}

/**
 * `/accounts`: read every account's quota as it is now, all at once, so the
 * table and the switch scores it shows are current — not whatever each
 * account's last run said, which can be hours or days old while the owners
 * use their accounts elsewhere. Paused accounts are left out, and so is one
 * reported within {@link ACCOUNTS_FRESH_MS}. Returns the ids whose reading
 * failed (they keep their last report). Never throws.
 */
export async function refreshAllQuota(
  pool: ClaudeAccountPool,
  opts: { probe?: QuotaProbe; now?: () => number } = {},
): Promise<string[]> {
  const now = opts.now ?? Date.now;
  const probe = opts.probe ?? probeAccountQuota;
  const failed: string[] = [];
  const stale = pool.accounts().filter((account) => now() - (pool.reportedAt(account.id) ?? 0) >= ACCOUNTS_FRESH_MS);
  await Promise.all(
    stale.map(async (account) => {
      const ok = await probe(pool, account).catch((err: unknown) => {
        log.warn('claude-accounts', 'quota-probe-failed', { id: account.id, err: String(err) });
        return false;
      });
      if (ok === false) failed.push(account.id);
    }),
  );
  return failed;
}

/**
 * Read the account's quota as it is now: `/usage` for the CLI's own login (a
 * local command, no model turn), a one-line haiku request for a token account
 * (its token cannot read `/usage`; the reply carries the quota windows).
 */
export async function probeAccountQuota(pool: ClaudeAccountPool, account: PickedAccount, binary = 'claude'): Promise<boolean> {
  const opts = { timeoutMs: PROBE_TIMEOUT_MS, maxBytes: 256_000, env: account.env };
  if (!account.env.CLAUDE_CODE_OAUTH_TOKEN) {
    const result = await runCapture(binary, tmpdir(), ['-p', '/usage'], opts);
    const windows = result.ok ? parseClaudeUsage(result.stdout) : [];
    if (windows.length > 0) pool.observeUsage(account.id, usageByKind({ windows }));
    log.info('claude-accounts', 'quota-probed', { id: account.id, via: 'usage', ok: windows.length > 0 });
    return windows.length > 0;
  }
  const result = await runCapture(
    binary,
    tmpdir(),
    ['-p', 'Reply with exactly: OK', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--no-session-persistence'],
    opts,
  );
  let seen = 0;
  for (const line of result.stdout.split('\n')) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    for (const evt of translateEvent(raw)) {
      if (evt.type !== 'rate_limit') continue;
      pool.observe(account.id, evt);
      seen++;
    }
  }
  log.info('claude-accounts', 'quota-probed', { id: account.id, via: 'haiku', ok: seen > 0 });
  return seen > 0;
}
