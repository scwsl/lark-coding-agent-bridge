import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKGROUND_FAILOVER_PROMPT,
  failoverPrompt,
  handoverPrompt,
  runWithAccountFailover,
  SWITCH_LINE_PROMPT,
} from '../../../src/agent/claude/account-failover.js';
import {
  accountRows,
  accountsReport,
  accountsTable,
  accountSecretId,
  bestSwitchTarget,
  findAccountRow,
  findPausedAccount,
  pausedNote,
  formatDaysHours,
  formatHoursMinutes,
  parseSwitchQuery,
  switchBoost,
  switchRefusal,
  STICKY_MARGIN,
  switchScore,
  switchToAccount,
  GRACE_LINE,
  reorderAccounts,
  updateDefaultLines,
  claudeAccountsPaths,
  ClaudeAccountPool,
  deleteAccount,
  parseAccountsConfig,
  readAccountsConfig,
  saveAccount,
  updateAccount,
  type PickedAccount,
  type AccountRow,
} from '../../../src/agent/claude/accounts.js';
import { readClaudeQuota } from '../../../src/agent/claude/quota.js';
import { refreshAllQuota, refreshPickQuota } from '../../../src/agent/claude/quota-probe.js';
import { translateEvent } from '../../../src/agent/claude/stream-json.js';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types.js';
import { parsePauseUntil, readVerification } from '../../../src/cli/commands/claude-account.js';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce } from '../../../src/card/run-state.js';
import { getSecret } from '../../../src/config/keystore.js';

const FIXTURES = join(__dirname, '..', '..', 'fixtures');
const dirs: string[] = [];
const pools: ClaudeAccountPool[] = [];
afterEach(async () => {
  // State writes are fire-and-forget; let them land before the directory goes.
  await Promise.all(pools.splice(0).map((pool) => pool.flush()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lcb-accounts-'));
  dirs.push(dir);
  return dir;
}

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 21, 2, 0);

/** A pool over `ids` (after `default`) whose tokens are `tok-<id>`. */
async function poolWith(ids: string[], opts: { switchAtPercent?: number; now?: () => number } = {}) {
  const dir = await tmp();
  const paths = claudeAccountsPaths(dir);
  await writeFile(
    paths.configFile,
    JSON.stringify({
      ...(opts.switchAtPercent ? { switchAtPercent: opts.switchAtPercent } : {}),
      accounts: [{ id: 'default' }, ...ids.map((id) => ({ id, label: `${id}-name` }))],
    }),
  );
  const pool = new ClaudeAccountPool({
    paths,
    now: opts.now ?? (() => NOW),
    readSecret: async (secretId) => `tok-${secretId.replace('claude-oauth-', '')}`,
  });
  await pool.refresh();
  pools.push(pool);
  return { pool, paths, dir };
}

function limit(over: Partial<Extract<AgentEvent, { type: 'rate_limit' }>> = {}): Extract<AgentEvent, { type: 'rate_limit' }> {
  return { type: 'rate_limit', blocked: false, at: NOW, ...over };
}

describe('Claude account list', () => {
  it('keeps valid entries, adds the CLI login in front and defaults the threshold', () => {
    const config = parseAccountsConfig(
      JSON.stringify({ accounts: [{ id: 'b', label: ' Bee ' }, { id: 'bad id' }, { id: 'b' }, 7], switchAtPercent: 400 }),
    );
    expect(config).toEqual({ lines: { five_hour: 98, seven_day: 98 }, accounts: [{ id: 'default' }, { id: 'b', label: 'Bee' }] });
    expect(parseAccountsConfig('not json').accounts).toEqual([{ id: 'default' }]);
  });

  it('stores the token in the profile keystore and removes both again', async () => {
    const dir = await tmp();
    const paths = claudeAccountsPaths(dir);
    await saveAccount(paths, { id: 'b', label: 'Bee', token: 'sk-ant-oat01-secret' });
    expect(await getSecret(accountSecretId('b'), paths.keystore)).toBe('sk-ant-oat01-secret');
    expect(readAccountsConfig(paths).accounts.map((a) => a.id)).toEqual(['default', 'b']);
    expect(await readFile(paths.configFile, 'utf8')).not.toContain('secret');
    await expect(saveAccount(paths, { id: 'default', token: 'x' })).rejects.toThrow();

    expect(await deleteAccount(paths, 'b')).toBe(true);
    expect(await getSecret(accountSecretId('b'), paths.keystore)).toBeUndefined();
    expect(readAccountsConfig(paths).accounts.map((a) => a.id)).toEqual(['default']);
  });
});

describe('ClaudeAccountPool', () => {
  it('without a list has only the CLI login, which runs with an untouched environment', async () => {
    const dir = await tmp();
    const pool = new ClaudeAccountPool({ paths: claudeAccountsPaths(dir), readSecret: async () => undefined });
    await pool.refresh();
    expect(pool.multi).toBe(false);
    expect(pool.pick()).toEqual({ id: 'default', env: {} });
  });

  it('leaves out an account whose token is missing', async () => {
    const dir = await tmp();
    const paths = claudeAccountsPaths(dir);
    await writeFile(paths.configFile, JSON.stringify({ accounts: [{ id: 'default' }, { id: 'b' }] }));
    const pool = new ClaudeAccountPool({ paths, readSecret: async () => undefined });
    await pool.refresh();
    expect(pool.accounts().map((a) => a.id)).toEqual(['default']);
  });

  it('prefers the first account with room, skips a full or refused one, and returns once it resets', async () => {
    let now = NOW;
    const { pool } = await poolWith(['b', 'c'], { now: () => now });
    expect(pool.pick()?.id).toBe('default');

    pool.observe('default', limit({ windows: [{ kind: 'five_hour', usedPercent: 99, resetsAt: NOW + HOUR }] }));
    expect(pool.pick()).toMatchObject({ id: 'b', label: 'b-name', env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-b' } });

    pool.observe('b', limit({ blocked: true, resetsAt: NOW + 2 * HOUR }));
    expect(pool.pick()?.id).toBe('c');

    // A refusal message carries no reset of its own: the earlier one stands.
    pool.observe('b', limit({ blocked: true }));
    expect(pool.refusedUntil('b')).toBe(NOW + 2 * HOUR);

    now = NOW + HOUR + 1;
    expect(pool.pick()?.id).toBe('default');
  });

  it('ignores model-specific windows unless they refuse, and honours the threshold', async () => {
    const { pool } = await poolWith(['b'], { switchAtPercent: 90 });
    pool.observe('default', limit({ windows: [{ kind: 'seven_day_opus', usedPercent: 100, resetsAt: NOW + HOUR }] }));
    expect(pool.pick()?.id).toBe('default');
    pool.observe('default', limit({ windows: [{ kind: 'seven_day', usedPercent: 91, resetsAt: NOW + 3 * 24 * HOUR }] }));
    expect(pool.pick()?.id).toBe('b');
  });

  it('when every account is spent, picks the one that frees up first but has none ready', async () => {
    const { pool } = await poolWith(['b']);
    pool.observe('default', limit({ blocked: true, resetsAt: NOW + 3 * HOUR }));
    pool.observe('b', limit({ blocked: true, resetsAt: NOW + HOUR }));
    expect(pool.pick()?.id).toBe('b');
    expect(pool.pickReady()).toBeUndefined();
  });

  it('an allowed report lifts a refusal', async () => {
    const { pool } = await poolWith(['b']);
    pool.observe('default', limit({ blocked: true, resetsAt: NOW + HOUR }));
    pool.observe('default', limit({ windows: [{ kind: 'five_hour', usedPercent: 5 }] }));
    expect(pool.pick()?.id).toBe('default');
  });

  it('persists what it learned and reads it back in a new process', async () => {
    const { pool, paths } = await poolWith(['b']);
    pool.observe('b', limit({ windows: [{ kind: 'five_hour', usedPercent: 40, resetsAt: NOW + HOUR }] }));
    await pool.flush();
    const again = new ClaudeAccountPool({ paths, now: () => NOW, readSecret: async () => 'tok' });
    await again.refresh();
    expect(again.quotaReading('b')).toEqual({
      windows: [{ label: '5 小时窗口', usedPercent: 40, resets: new Date(NOW + HOUR).toISOString() }],
    });
    expect(again.quotaReading('default')).toBeUndefined();
  });

  it('re-reads the list when the file changes', async () => {
    const { pool, paths } = await poolWith([]);
    expect(pool.multi).toBe(false);
    await writeFile(paths.configFile, JSON.stringify({ accounts: [{ id: 'default' }, { id: 'b' }] }));
    const later = new Date(Date.now() + 5_000);
    await utimes(paths.configFile, later, later);
    await pool.refresh();
    expect(pool.multi).toBe(true);
  });

  it('reports each account for /usage', async () => {
    const { pool } = await poolWith(['b']);
    pool.observe('default', limit({ blocked: true, resetsAt: NOW + HOUR, windows: [{ kind: 'five_hour', usedPercent: 100, resetsAt: NOW + HOUR }] }));
    const lines = accountsReport(pool, 'scwsl.wang', NOW);
    expect(lines[0]).toContain('**scwsl.wang**（主账户，default；切换线 5h 98% · 周 98%）：5 小时窗口 100%');
    expect(lines[0]).toContain('额度用尽');
    expect(lines[1]).toContain('▶ **b-name**（备用 1，b；');
    expect(lines[1]).toContain('还没有运行记录');
  });
});

describe('account table and switching (/accounts)', () => {
  const DAY = 24 * HOUR;
  const MIN = 60_000;

  it('formats resets as hours+minutes for 5 hours and days+hours for the week', () => {
    expect(formatHoursMinutes(4 * HOUR + 32 * MIN)).toBe('4h32m');
    expect(formatHoursMinutes(59 * MIN)).toBe('0h59m');
    expect(formatDaysHours(2 * DAY + 22 * HOUR)).toBe('2d22h');
    expect(formatDaysHours(5 * HOUR)).toBe('0d5h');
  });

  it('scores weekly room, weekly room about to reset, and 5-hour room; an account that never ran counts half full', () => {
    const view = (five: number, week: number, weekResetIn?: number) => ({
      five_hour: { usedPercent: five, line: 80 },
      seven_day: { usedPercent: week, line: 90, ...(weekResetIn !== undefined ? { resetsInMs: weekResetIn } : {}) },
    });
    // 0.30 × 0.8 + 0.45 × 0.8 × 0.5 + 0.25 × 0.5
    expect(switchScore(view(40, 18, 3.5 * DAY), true)).toBeCloseTo(0.545);
    expect(switchScore(view(0, 10, 6 * DAY), true)).toBeGreaterThan(switchScore(view(0, 86, 6 * DAY), true));
    // Same usage: the week that resets sooner wins.
    expect(switchScore(view(0, 50, DAY), true)).toBeGreaterThan(switchScore(view(0, 50, 6 * DAY), true));
    // A busy 5-hour window no longer hides plenty of weekly room about to be lost.
    expect(switchScore(view(70, 17, 18 * HOUR), true)).toBeGreaterThan(switchScore(view(35, 85, 3 * DAY), true));
    // Room is against each account's own lines; at or past either line it scores 0.
    expect(switchScore(view(0, 90, HOUR), true)).toBe(0);
    expect(switchScore(view(80, 0, HOUR), true)).toBe(0);
    expect(switchScore(view(0, 89, HOUR), true)).toBeGreaterThan(0.25);
    expect(switchScore(view(0, 0), false)).toBeCloseTo(0.275);
    // Weekly room about to be lost outweighs a little more room that keeps for days.
    expect(switchScore(view(0, 40, 12 * HOUR), true)).toBeGreaterThan(switchScore(view(0, 20, 6 * DAY), true));
  });

  it('lists every account in one table, one column per figure', async () => {
    const { pool } = await poolWith(['b', 'c']);
    pool.observe('default', limit({ windows: [
      { kind: 'five_hour', usedPercent: 46, resetsAt: NOW + 4 * HOUR + 32 * MIN },
      { kind: 'seven_day', usedPercent: 55, resetsAt: NOW + 2 * DAY + 22 * HOUR },
    ] }));
    pool.observe('b', limit({ windows: [{ kind: 'seven_day', usedPercent: 10, resetsAt: NOW + 5 * DAY }] }));
    const rows = accountRows(pool, 'shilong.wang', NOW);
    const table = accountsTable(rows);
    expect(table.split('\n')[0]).toBe('| 账户 | 5 小时用量 / 重置 | 本周用量 / 重置 | 切换线（5 小时 / 本周） | 得分 | 状态 |');
    expect(table).toContain('| **shilong.wang**（主，default） | 46% / 4h32m | 55% / 2d22h | 98% / 98% | 38 | 可用 |');
    // The best score takes the next run, main account or not.
    expect(table).toContain('| ✅ **b-name**（备 1，b） | — | 10% / 5d0h | 98% / 98% | 63 | 使用中 |');
    expect(table).toContain('| **c-name**（备 2，c） | — | — | 98% / 98% | 28 | 还没运行过 |');
  });

  it('switches without a name to the best-scoring account with room, never the current one', async () => {
    const { pool, paths } = await poolWith(['b', 'c', 'd']);
    pool.observe('default', limit({ windows: [{ kind: 'seven_day', usedPercent: 50, resetsAt: NOW + 3 * DAY }] }));
    pool.observe('b', limit({ windows: [{ kind: 'seven_day', usedPercent: 99, resetsAt: NOW + DAY }] }));
    pool.observe('c', limit({ windows: [{ kind: 'seven_day', usedPercent: 20, resetsAt: NOW + 6 * DAY }] }));
    pool.observe('d', limit({ windows: [{ kind: 'seven_day', usedPercent: 20, resetsAt: NOW + DAY }] }));
    const target = bestSwitchTarget(accountRows(pool, undefined, NOW));
    // b is past its line; c and d are equally full, d resets sooner.
    expect(target?.id).toBe('d');
    await switchToAccount(paths, target!.id);
    await pool.refresh();
    expect(pool.pick()?.id).toBe('d');
    expect(readAccountsConfig(paths).accounts.map((a) => a.id)).toEqual(['d', 'default', 'b', 'c']);
  });

  it('switches to the best-scoring account when the main one is already past its line', async () => {
    const { pool } = await poolWith(['b', 'c']);
    // The main account is past its 5-hour line, so new runs already go to the
    // best score: c, whose weekly room resets two days sooner than b's larger
    // room; a switch must pick c too.
    pool.observe('default', limit({ windows: [{ kind: 'five_hour', usedPercent: 99, resetsAt: NOW + 4 * HOUR }] }));
    pool.observe('b', limit({ windows: [{ kind: 'seven_day', usedPercent: 11, resetsAt: NOW + 6 * DAY }] }));
    pool.observe('c', limit({ windows: [{ kind: 'seven_day', usedPercent: 26, resetsAt: NOW + 4 * DAY }] }));
    const rows = accountRows(pool, undefined, NOW);
    expect(rows.find((r) => r.next)?.id).toBe('c');
    expect(bestSwitchTarget(rows)?.id).toBe('c');
  });

  it('a switch by name obeys the switch lines: an account past one or refused is not switched to', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 80, seven_day: 90 });
    pool.observe('backup2', fiveHour(85));
    pool.observe('backup', limit({ blocked: true, resetsAt: NOW + HOUR }));
    pool.observe('default', fiveHour(79));
    const rows = accountRows(pool, undefined, NOW);
    const row = (id: string): AccountRow => rows.find((r) => r.id === id)!;
    expect(switchRefusal(pool, row('backup2'))).toBe('5 小时窗口用量 85%，已到 80% 的切换线');
    expect(switchRefusal(pool, row('backup'))).toMatch(/^额度用尽，/);
    // Just below the line: it may be switched to (and leaves again at 80%).
    expect(switchRefusal(pool, row('default'))).toBeUndefined();
    // A temporary line asked for with the switch: only one above the usage lets it through.
    expect(switchRefusal(pool, row('backup2'), 85)).toBe('5 小时窗口用量 85%，已到 85% 的切换线');
    expect(switchRefusal(pool, row('backup2'), 95)).toBeUndefined();
    // A refused account stays refused whatever line is asked for.
    expect(switchRefusal(pool, row('backup'), 100)).toMatch(/^额度用尽，/);
  });

  it('a raise already on an account does not let a plain switch past its own line', async () => {
    const { pool, paths } = await poolInOrder(ROSTER, { five_hour: 80, seven_day: 90 });
    pool.observe('backup2', fiveHour(85));
    await switchToAccount(paths, 'backup2', switchBoost(pool, 'backup2', 95, NOW));
    await pool.refresh();
    expect(pool.lineOf('backup2', 'five_hour')).toBe(95);
    // Switching to it again without a line would drop the raise: judged by its own 80%.
    const rows = accountRows(pool, undefined, NOW);
    expect(switchRefusal(pool, rows.find((r) => r.id === 'backup2')!)).toBe('5 小时窗口用量 85%，已到 80% 的切换线');
  });

  it('a temporary line raises only the windows below it, until each window resets, and drops once runs move on', async () => {
    const { pool, paths } = await poolInOrder(ROSTER, { five_hour: 80, seven_day: 90 });
    pool.observe('backup2', fiveHour(85));
    expect(pool.hasRoom('backup2')).toBe(false);
    // The 5-hour window resets in an hour; the weekly one is not known yet: a full week.
    expect(switchBoost(pool, 'backup2', 95, NOW)).toEqual({
      five_hour: { line: 95, until: NOW + HOUR },
      seven_day: { line: 95, until: NOW + 7 * DAY },
    });
    // Only the windows whose own line is below the value rise.
    expect(switchBoost(pool, 'backup2', 85, NOW)).toEqual({ five_hour: { line: 85, until: NOW + HOUR } });
    expect(switchBoost(pool, 'backup2', 80, NOW)).toBeUndefined();
    const boost = switchBoost(pool, 'backup2', 95, NOW);
    await switchToAccount(paths, 'backup2', boost);
    await pool.refresh();
    expect(pool.pick()?.id).toBe('backup2');
    expect(pool.lineOf('backup2', 'five_hour')).toBe(95);
    expect(pool.lineOf('backup2', 'five_hour', NOW + 2 * HOUR)).toBe(80);
    const rows = accountRows(pool, undefined, NOW);
    expect(rows[0]?.boosted).toBe(true);
    expect(accountsTable(rows)).toContain('| 95% / 95%（临时） |');
    // Runs move on (at 95%, or to another account): the raise is gone, in memory and on disk.
    pool.promote('backup');
    expect(pool.lineOf('backup2', 'five_hour')).toBe(80);
    await pool.flush();
    expect(readAccountsConfig(paths).accounts.find((a) => a.id === 'backup2')?.boost).toBeUndefined();
  });

  it('reads a switch query: a name, and a temporary line only after a name', () => {
    expect(parseSwitchQuery(undefined)).toEqual({});
    expect(parseSwitchQuery('  ')).toEqual({});
    expect(parseSwitchQuery('焦银玲')).toEqual({ name: '焦银玲' });
    expect(parseSwitchQuery('焦银玲 95')).toEqual({ name: '焦银玲', line: 95 });
    expect(parseSwitchQuery('焦银玲 95%')).toEqual({ name: '焦银玲', line: 95 });
    expect(parseSwitchQuery('shilong wang 90')).toEqual({ name: 'shilong wang', line: 90 });
    expect(parseSwitchQuery('95')).toEqual({ name: '95' });
    expect(parseSwitchQuery('焦银玲 0')).toEqual({ error: '切换线要是 1–100 的整数：0' });
    expect(parseSwitchQuery('焦银玲 120')).toEqual({ error: '切换线要是 1–100 的整数：120' });
  });

  it('finds an account by id, name or the CLI login, ignoring case', async () => {
    const { pool } = await poolWith(['b']);
    const rows = accountRows(pool, 'Shilong.Wang', NOW);
    expect(findAccountRow(rows, 'B')?.id).toBe('b');
    expect(findAccountRow(rows, 'b-NAME')?.id).toBe('b');
    expect(findAccountRow(rows, 'shilong.wang')?.id).toBe('default');
    expect(findAccountRow(rows, 'nobody')).toBeUndefined();
  });
});

/** A scripted claude attempt. */
function fakeRun(events: AgentEvent[], log: string[] = []): AgentRun {
  return {
    runId: 'r',
    pid: 1,
    events: (async function* () {
      yield* events;
    })(),
    stop: async () => {
      log.push('stop');
    },
    waitForExit: async () => true,
  };
}

/**
 * A scripted claude attempt kept on for its background tasks: after its
 * events it stays up, as the real process does, until it is stopped.
 */
function lingeringRun(events: AgentEvent[], log: string[] = []): AgentRun {
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    runId: 'r',
    pid: 1,
    events: (async function* () {
      yield* events;
      await stopped;
      yield { type: 'done', terminationReason: 'interrupted' } as AgentEvent;
    })(),
    stop: async () => {
      log.push('stop');
      release();
    },
    waitForExit: async () => false,
  };
}

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const evt of run.events) out.push(evt);
  return out;
}

const OPTS: AgentRunOptions = { runId: 'r', prompt: 'hello', cwd: '/tmp', sessionId: 's0' };
const refused: AgentEvent[] = [
  { type: 'system', sessionId: 's1' },
  limit({ blocked: true, limitType: 'five_hour', resetsAt: NOW + HOUR }),
  limit({ blocked: true, message: "You've hit your limit" }),
  { type: 'usage', costUsd: 0 },
  { type: 'done', sessionId: 's1', terminationReason: 'normal' },
];

describe('account failover', () => {
  it('passes a normal run through, recording its quota and naming the account', async () => {
    const { pool } = await poolWith(['b']);
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return fakeRun([
          { type: 'system', sessionId: 's1' },
          limit({ windows: [{ kind: 'five_hour', usedPercent: 12, resetsAt: NOW + HOUR }] }),
          { type: 'text', delta: 'hi' },
          { type: 'done', sessionId: 's1', terminationReason: 'normal' },
        ]);
      },
      labelOf: async () => 'scwsl.wang',
    });
    const events = await collect(run);
    expect(spawned).toEqual(['default']);
    expect(events[0]).toEqual({ type: 'account', label: 'scwsl.wang' });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(pool.quotaReading('default')?.windows[0]?.usedPercent).toBe(12);
  });

  it('says nothing about accounts when there is only one', async () => {
    const { pool } = await poolWith([]);
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: () => fakeRun([{ type: 'done', terminationReason: 'normal' }]),
      labelOf: async () => 'me',
    });
    expect((await collect(run)).map((e) => e.type)).toEqual(['done']);
  });

  it('hands the next turn to the current process, so background work is not killed', async () => {
    const { pool } = await poolWith(['b']);
    const sent: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: () => ({
        ...fakeRun([{ type: 'done', terminationReason: 'normal' }]),
        send: (prompt: string) => {
          sent.push(prompt);
          return true;
        },
      }),
      labelOf: async () => 'me',
    });
    await collect(run);
    expect(run.send?.('next')).toBe(true);
    expect(sent).toEqual(['next']);
  });

  it('moves a refused run to the next account and resumes the same session there', async () => {
    const { pool } = await poolWith(['b']);
    const calls: Array<{ account: PickedAccount; opts: AgentRunOptions }> = [];
    const stops: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (opts, account) => {
        calls.push({ account, opts });
        return calls.length === 1
          ? fakeRun(refused, stops)
          : fakeRun([
              { type: 'system', sessionId: 's1' },
              { type: 'text', delta: 'done on b' },
              { type: 'done', sessionId: 's1', terminationReason: 'normal' },
            ]);
      },
      labelOf: async (account) => (account.id === 'default' ? 'scwsl.wang' : account.label),
    });
    const events = await collect(run);

    expect(calls.map((c) => c.account.id)).toEqual(['default', 'b']);
    expect(calls[1]!.account.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-b' });
    expect(calls[1]!.opts).toMatchObject({ sessionId: 's1', prompt: failoverPrompt('hello') });
    expect(calls[1]!.opts.prompt).toContain('hello');
    // The refusal and the refused turn's end never reach the card.
    expect(events.filter((e) => e.type === 'rate_limit')).toEqual([]);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events).toContainEqual({ type: 'account', label: 'b-name', switchedFrom: 'scwsl.wang' });
    expect(pool.refusedUntil('default')).toBe(NOW + HOUR);
    expect(stops).toEqual([]);

    const state = events.reduce(reduce, initialState);
    expect(state.terminal).toBe('done');
    expect(state.sponsor).toBe('b-name');
    const card = JSON.stringify(renderCard(state, { meta: { title: 'Occam', sponsor: 'scwsl.wang' } }));
    expect(card).toContain('Sponsor: b-name');
    expect(card).toContain('已切换到 b-name');
  });

  it('pauses as before when no other account has room, at the soonest reset', async () => {
    const { pool } = await poolWith(['b']);
    pool.observe('b', limit({ blocked: true, resetsAt: NOW + 30 * 60_000 }));
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return fakeRun(refused);
      },
      labelOf: async () => 'me',
    });
    const events = await collect(run);
    expect(spawned).toEqual(['default']);
    const state = events.reduce(reduce, initialState);
    expect(state.terminal).toBe('paused');
    // Account b frees up first: that is when the task can go on.
    expect(events.find((e) => e.type === 'rate_limit')).toMatchObject({ blocked: true, resetsAt: NOW + 30 * 60_000 });
  });

  it('does not switch when the agent works past the refusal', async () => {
    const { pool } = await poolWith(['b']);
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return fakeRun([
          limit({ blocked: true, resetsAt: NOW + HOUR }),
          { type: 'text', delta: 'still going' },
          { type: 'done', terminationReason: 'normal' },
        ]);
      },
      labelOf: async () => 'me',
    });
    const events = await collect(run);
    expect(spawned).toEqual(['default']);
    expect(events.map((e) => e.type)).toEqual(['account', 'rate_limit', 'text', 'done']);
  });

  it('with a single account, a refusal in a background turn ends it paused as before', async () => {
    const { pool } = await poolWith([]);
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return fakeRun([
          { type: 'text', delta: 'answer' },
          { type: 'done', sessionId: 's1', terminationReason: 'normal' },
          limit({ blocked: true, resetsAt: NOW + HOUR }),
          { type: 'done', sessionId: 's1', terminationReason: 'normal' },
        ]);
      },
      labelOf: async () => 'me',
    });
    const events = await collect(run);
    expect(spawned).toEqual(['default']);
    expect(events.map((e) => e.type)).toEqual(['text', 'done', 'rate_limit', 'done']);
    expect(pool.refusedUntil('default')).toBe(NOW + HOUR);
  });

  it('moves a refused background turn to another account, never re-sending the user message', async () => {
    const { pool } = await poolWith(['b']);
    const calls: Array<{ account: string; opts: AgentRunOptions }> = [];
    const stops: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (opts, account) => {
        calls.push({ account: account.id, opts });
        return calls.length === 1
          ? fakeRun(
              [
                { type: 'text', delta: 'answer' },
                { type: 'background', count: 2 },
                { type: 'done', sessionId: 's1', terminationReason: 'normal' },
                limit({ blocked: true, resetsAt: NOW + HOUR }),
                { type: 'error', message: 'claude exited with code 1', terminationReason: 'failed' },
              ],
              stops,
            )
          : fakeRun([{ type: 'text', delta: 'resumed' }, { type: 'done', sessionId: 's1', terminationReason: 'normal' }]);
      },
      labelOf: async (account) => account.label ?? account.id,
    });
    const events = await collect(run);
    expect(calls.map((c) => c.account)).toEqual(['default', 'b']);
    expect(stops).toEqual(['stop']);
    expect(calls[1]!.opts).toMatchObject({ sessionId: 's1', prompt: BACKGROUND_FAILOVER_PROMPT });
    expect(calls[1]!.opts.prompt).not.toContain('hello');
    expect(BACKGROUND_FAILOVER_PROMPT).toContain('SendMessage');
    // user turn | notice turn (the process stays busy) | resumed turn (it reported no tasks)
    expect(events.map((e) => e.type)).toEqual([
      'account', 'text', 'background', 'done',
      'account', 'background', 'done',
      'text', 'background', 'done',
    ]);
    expect(events[4]).toMatchObject({ label: 'b-name', switchedFrom: 'default', reason: expect.stringContaining('后台') });
    expect(events[5]).toEqual({ type: 'background', count: 2 });
    expect(events[8]).toEqual({ type: 'background', count: 0 });
    expect(events.filter((e) => e.type === 'rate_limit' || e.type === 'error')).toEqual([]);
    expect(pool.pick()?.id).toBe('b');
  });

  it('moves when a background subagent is cut off by the quota, asking to resume it', async () => {
    const { pool } = await poolWith(['b']);
    const calls: Array<{ account: string; opts: AgentRunOptions }> = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (opts, account) => {
        calls.push({ account: account.id, opts });
        return calls.length === 1
          ? fakeRun([
              { type: 'background', count: 1 },
              { type: 'done', sessionId: 's1', terminationReason: 'normal' },
              { type: 'subagent_rate_limited', taskId: 'a1', at: NOW },
              { type: 'background', count: 0 },
              { type: 'text', delta: 'the subagent failed' },
              { type: 'done', sessionId: 's1', terminationReason: 'normal' },
            ])
          : fakeRun([{ type: 'done', sessionId: 's1', terminationReason: 'normal' }]);
      },
      labelOf: async (account) => account.label ?? account.id,
    });
    const events = await collect(run);
    expect(calls.map((c) => c.account)).toEqual(['default', 'b']);
    expect(calls[1]!.opts.prompt).toBe(BACKGROUND_FAILOVER_PROMPT);
    expect(pool.isRefused('default')).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'account', switchedFrom: 'default' }));
  });

  it('moves a refused user turn with background subagents at once, not when the kept process ends', async () => {
    const { pool } = await poolWith(['b']);
    const calls: Array<{ account: string; opts: AgentRunOptions }> = [];
    const stops: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (opts, account) => {
        calls.push({ account: account.id, opts });
        return calls.length === 1
          ? lingeringRun(
              [
                { type: 'system', sessionId: 's1' },
                { type: 'background', count: 4 },
                { type: 'subagent_rate_limited', taskId: 'a1', at: NOW },
                limit({ blocked: true, message: "You've hit your 5-hour limit" }),
                { type: 'usage', costUsd: 11 },
                { type: 'done', sessionId: 's1', terminationReason: 'normal' },
              ],
              stops,
            )
          : fakeRun([{ type: 'text', delta: 'resumed on b' }, { type: 'done', sessionId: 's1', terminationReason: 'normal' }]);
      },
      labelOf: async (account) => account.label ?? account.id,
    });
    const events = await collect(run);
    expect(calls.map((c) => c.account)).toEqual(['default', 'b']);
    expect(stops).toEqual(['stop']);
    // The whole session — main agent and every subagent — goes to one account.
    expect(calls[1]!.opts).toMatchObject({ sessionId: 's1', prompt: failoverPrompt('hello', { subagents: true }) });
    expect(calls[1]!.opts.prompt).toContain('SendMessage');
    expect(events.filter((e) => e.type === 'rate_limit')).toEqual([]);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'background')).toEqual([
      { type: 'background', count: 4 },
      { type: 'background', count: 0 },
    ]);
    expect(events).toContainEqual({ type: 'account', label: 'b-name', switchedFrom: 'default' });
    expect(pool.pick()?.id).toBe('b');
  });

  it('with no account to move to, a refused user turn with background tasks pauses at once', async () => {
    const { pool } = await poolWith(['b']);
    pool.observe('b', limit({ blocked: true, resetsAt: NOW + 30 * 60_000 }));
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return lingeringRun([
          { type: 'background', count: 2 },
          limit({ blocked: true, resetsAt: NOW + HOUR }),
          { type: 'done', sessionId: 's1', terminationReason: 'normal' },
        ]);
      },
      labelOf: async () => 'me',
    });
    const seen: AgentEvent[] = [];
    for await (const evt of run.events) {
      seen.push(evt);
      if (evt.type === 'done') break;
    }
    expect(spawned).toEqual(['default']);
    expect(seen.reduce(reduce, initialState).terminal).toBe('paused');
    expect(seen.find((e) => e.type === 'rate_limit')).toMatchObject({ blocked: true, resetsAt: NOW + 30 * 60_000 });
    await run.stop();
  });

  it('a refused background turn of a stopped run stays put', async () => {
    const { pool } = await poolWith(['b']);
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return fakeRun([
          { type: 'background', count: 1 },
          { type: 'done', sessionId: 's1', terminationReason: 'normal' },
          { type: 'subagent_rate_limited', at: NOW },
          limit({ blocked: true, resetsAt: NOW + HOUR }),
          { type: 'done', terminationReason: 'interrupted' },
        ]);
      },
      labelOf: async () => 'me',
    });
    await run.stop();
    await collect(run);
    expect(spawned).toEqual(['default']);
  });

  it('hands the next message to another account when the kept process is refused or no longer the main one', async () => {
    for (const setup of ['refused', 'switched'] as const) {
      const { pool } = await poolWith(['b']);
      const sent: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const calls: Array<{ account: string; opts: AgentRunOptions }> = [];
      const run = runWithAccountFailover(OPTS, {
        pool,
        spawn: (opts, account) => {
          calls.push({ account: account.id, opts });
          if (calls.length > 1) return fakeRun([{ type: 'text', delta: 'on b' }, { type: 'done', sessionId: 's1', terminationReason: 'normal' }]);
          return {
            ...fakeRun([]),
            events: (async function* () {
              yield { type: 'system', sessionId: 's1' } as AgentEvent;
              yield { type: 'background', count: 1 } as AgentEvent;
              yield { type: 'done', sessionId: 's1', terminationReason: 'normal' } as AgentEvent;
              await gate;
              yield { type: 'done', terminationReason: 'interrupted' } as AgentEvent;
            })(),
            stop: async () => release(),
            send: (prompt: string) => {
              sent.push(prompt);
              return true;
            },
          };
        },
        labelOf: async (account) => account.label ?? account.id,
      });
      const it = run.events[Symbol.asyncIterator]();
      const seen: AgentEvent[] = [];
      while (seen.at(-1)?.type !== 'done') seen.push((await it.next()).value as AgentEvent);
      if (setup === 'refused') pool.observe('default', limit({ blocked: true, resetsAt: NOW + HOUR }));
      else pool.promote('b');
      expect(run.send?.('new message')).toBe(true);
      for (let r = await it.next(); !r.done; r = await it.next()) seen.push(r.value);
      expect(sent).toEqual([]);
      expect(calls.map((c) => c.account)).toEqual(['default', 'b']);
      expect(calls[1]!.opts).toMatchObject({ sessionId: 's1', prompt: handoverPrompt('new message', { subagents: true }) });
      expect(seen.filter((e) => e.type === 'done')).toHaveLength(2);
      expect(seen).toContainEqual(expect.objectContaining({ type: 'account', label: 'b-name', switchedFrom: 'default' }));
      expect(seen).toContainEqual({ type: 'text', delta: 'on b' });
    }
  });

  it('does not switch a run that was stopped', async () => {
    const { pool } = await poolWith(['b']);
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return fakeRun([limit({ blocked: true }), { type: 'done', terminationReason: 'interrupted' }]);
      },
      labelOf: async () => 'me',
    });
    await collect(run);
    expect(spawned).toEqual(['default']);
  });
});

describe('Claude subagent quota failures', () => {
  it('reads a subagent cut off by the quota from its refusal and its failed task notification', () => {
    // Shapes from claude 2.1.309 (stream-json): a background subagent's
    // messages carry parent_tool_use_id + agent_id; a stopped task reports a
    // system/task_notification.
    expect([
      ...translateEvent({
        type: 'assistant',
        parent_tool_use_id: 'toolu_1',
        agent_id: 'a5c3605c87e6b7ee6',
        error: 'rate_limit',
        message: { content: [{ type: 'text', text: "You've hit your session limit · resets 1am (Asia/Shanghai)" }] },
      }),
    ]).toEqual([
      {
        type: 'subagent_rate_limited',
        taskId: 'a5c3605c87e6b7ee6',
        message: "You've hit your session limit · resets 1am (Asia/Shanghai)",
        at: expect.any(Number),
      },
    ]);
    const failed = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'ae33b795da24bc0a8',
      tool_use_id: 'toolu_2',
      status: 'failed',
      summary:
        'Agent "J0" failed: Agent terminated early due to an API error: You\'ve hit your session limit · resets 1am (Asia/Shanghai) (error type rate_limit, HTTP 429, request id req_1)',
    };
    expect([...translateEvent(failed)]).toEqual([
      { type: 'subagent_rate_limited', taskId: 'ae33b795da24bc0a8', message: failed.summary, at: expect.any(Number) },
    ]);
    expect([...translateEvent({ ...failed, status: 'completed', summary: 'hi' })]).toEqual([]);
    expect([...translateEvent({ ...failed, summary: 'Agent "x" failed: tool crashed' })]).toEqual([]);
  });
});

describe('Claude rate_limit_event', () => {
  it('reads every window from a real sample', async () => {
    const raw = JSON.parse(await readFile(join(FIXTURES, 'claude-rate-limit-event.json'), 'utf8'));
    const [evt] = [...translateEvent(raw)];
    expect(evt).toMatchObject({
      type: 'rate_limit',
      blocked: false,
      limitType: 'five_hour',
      windows: [
        { kind: 'five_hour', usedPercent: 14, resetsAt: 1792563600_000 },
        { kind: 'seven_day', usedPercent: 11, resetsAt: 1793062800_000 },
      ],
    });
  });
});

describe('claude-account add verification', () => {
  it('accepts a token that answered, reporting its quota', async () => {
    const raw = await readFile(join(FIXTURES, 'claude-rate-limit-event.json'), 'utf8');
    const out = [raw.trim(), JSON.stringify({ type: 'result', subtype: 'success', is_error: false })].join('\n');
    expect(readVerification(out)).toEqual({ ok: true, message: 'ok', quota: '5 小时窗口 14% · 本周 11%' });
  });

  it('rejects a token the API refused', () => {
    const out = [
      JSON.stringify({ type: 'assistant', error: 'authentication_failed', message: { content: [] } }),
      JSON.stringify({ type: 'result', is_error: true, result: 'Invalid bearer token' }),
    ].join('\n');
    expect(readVerification(out)).toMatchObject({ ok: false, message: 'authentication_failed' });
  });
});

describe('quota across accounts', () => {
  it('speaks for the account with the most room, by its last report when /usage cannot answer', { skip: process.platform === 'win32', timeout: 20_000 }, async () => {
    const { pool, dir } = await poolWith(['b']);
    const broken = join(dir, 'claude-broken');
    await writeFile(broken, `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
    await chmod(broken, 0o755);
    pool.observe('default', limit({ windows: [{ kind: 'seven_day', usedPercent: 85, resetsAt: NOW + HOUR }] }));
    pool.observe('b', limit({ windows: [{ kind: 'seven_day', usedPercent: 10, resetsAt: NOW + HOUR }] }));
    const reading = await readClaudeQuota({ cwd: dir }, broken, pool);
    expect(reading?.windows).toEqual([{ label: '本周', usedPercent: 10, resets: expect.any(String) }]);
  });
});

/** A pool over `accounts` in that order (`default` included where listed), tokens `tok-<id>`. */
async function poolInOrder(accounts: Array<Record<string, unknown>>, lines?: Record<string, number>) {
  const dir = await tmp();
  const paths = claudeAccountsPaths(dir);
  await writeFile(paths.configFile, JSON.stringify({ ...(lines ? { lines } : {}), accounts }));
  const pool = new ClaudeAccountPool({
    paths,
    now: () => NOW,
    readSecret: async (secretId) => `tok-${secretId.replace('claude-oauth-', '')}`,
  });
  await pool.refresh();
  pools.push(pool);
  return { pool, paths };
}

const fiveHour = (usedPercent: number) => limit({ windows: [{ kind: 'five_hour', usedPercent, resetsAt: NOW + HOUR }] });
const weekly = (usedPercent: number) => limit({ windows: [{ kind: 'seven_day', usedPercent, resetsAt: NOW + 48 * HOUR }] });

/** shilong.wang (main) → yu.ou (the CLI login) → Mia; 5h 98 / week 90, Mia's 5h at 80. */
const ROSTER = [
  { id: 'backup', label: 'shilong.wang' },
  { id: 'default' },
  { id: 'backup2', label: 'Mia', lines: { five_hour: 80 } },
];

describe('switch lines and rounds', () => {
  it('reads per-window lines, per account or the profile default', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    expect(pool.lineOf('backup', 'five_hour')).toBe(98);
    expect(pool.lineOf('backup2', 'five_hour')).toBe(80);
    expect(pool.lineOf('backup2', 'seven_day')).toBe(90);
    expect(pool.accounts().map((a) => a.id)).toEqual(['backup', 'default', 'backup2']);
  });

  it('keeps the main account below its lines, then the best score, then in order until refused, then the soonest reset', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    expect(pool.pick()?.id).toBe('backup');
    pool.observe('backup', fiveHour(98));
    expect(pool.pick()?.id).toBe('default');
    pool.observe('default', weekly(90));
    expect(pool.pick()?.id).toBe('backup2');
    pool.observe('backup2', fiveHour(80));
    // Everyone is past a line: start over from the main account and use it up.
    expect(pool.pickReady()).toBeUndefined();
    expect(pool.pick()?.id).toBe('backup');
    pool.observe('backup', limit({ blocked: true, resetsAt: NOW + 3 * HOUR }));
    // Every one left is past a line, so all score 0: the list's order decides.
    expect(pool.pick()?.id).toBe('default');
    pool.observe('default', limit({ blocked: true, resetsAt: NOW + 2 * HOUR }));
    expect(pool.pick()?.id).toBe('backup2');
    pool.observe('backup2', limit({ blocked: true, resetsAt: NOW + 4 * HOUR }));
    // All refused: the soonest reset.
    expect(pool.pickRunnable()).toBeUndefined();
    expect(pool.nextRunnableAt()).toBe(NOW + 2 * HOUR);
    expect(pool.pick()?.id).toBe('default');
  });

  it('reads the older single threshold and reserve settings', async () => {
    const { pool } = await poolInOrder([{ id: 'default' }, { id: 'mia', reservePercent: 20 }], undefined);
    expect(pool.lineOf('mia', 'five_hour')).toBe(80);
    expect(pool.lineOf('mia', 'seven_day')).toBe(80);
    expect(parseAccountsConfig(JSON.stringify({ switchAtPercent: 95 })).lines).toEqual({ five_hour: 95, seven_day: 95 });
  });

  it('sets lines, defaults and order without touching tokens', async () => {
    const dir = await tmp();
    const paths = claudeAccountsPaths(dir);
    await saveAccount(paths, { id: 'backup', token: 'tok-a', label: 'shilong.wang' });
    await saveAccount(paths, { id: 'backup2', token: 'tok-b', lines: { five_hour: 80 } });
    await updateDefaultLines(paths, { five_hour: 98, seven_day: 90 });
    await updateAccount(paths, 'backup2', { label: 'Mia', lines: { seven_day: 85 } });
    await reorderAccounts(paths, ['backup', 'default']);
    let config = readAccountsConfig(paths);
    expect(config.lines).toEqual({ five_hour: 98, seven_day: 90 });
    expect(config.accounts).toEqual([
      { id: 'backup', label: 'shilong.wang' },
      { id: 'default' },
      { id: 'backup2', label: 'Mia', lines: { five_hour: 80, seven_day: 85 } },
    ]);
    await updateAccount(paths, 'backup2', { lines: { five_hour: 0, seven_day: 0 } });
    config = readAccountsConfig(paths);
    expect(config.accounts[2]).toEqual({ id: 'backup2', label: 'Mia' });
    await expect(updateAccount(paths, 'backup2', { lines: { five_hour: 101 } })).rejects.toThrow();
    await expect(reorderAccounts(paths, ['nobody'])).rejects.toThrow();
    expect(await getSecret(accountSecretId('backup2'), paths.keystore)).toBe('tok-b');
  });

  it('reports roles, lines and who is past a line', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    pool.observe('backup2', fiveHour(85));
    const lines = accountsReport(pool, 'yu.ou', NOW);
    expect(lines[0]).toContain('▶ **shilong.wang**（主账户，backup；切换线 5h 98% · 周 90%）');
    expect(lines[1]).toContain('**yu.ou**（备用 1，default；');
    expect(lines[2]).toContain('**Mia**（备用 2，backup2；切换线 5h 80% · 周 90%）：5 小时窗口 85%');
    expect(lines[2]).toContain('已过5 小时窗口切换线');
  });

  it('a run past its line moves to an account below its lines between steps', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    pool.observe('backup', limit({ blocked: true, resetsAt: NOW + HOUR }));
    pool.observe('default', weekly(95));
    // Round 1 gives Mia; her report says 85%, and the main account frees up meanwhile.
    const calls: Array<{ account: PickedAccount; opts: AgentRunOptions }> = [];
    const stops: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (opts, account) => {
        calls.push({ account, opts });
        if (calls.length === 1) {
          pool.observe('backup', fiveHour(10));
          return fakeRun(
            [
              { type: 'system', sessionId: 's1' },
              { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
              fiveHour(85),
              { type: 'tool_result', id: 't1', output: 'ok', isError: false },
              { type: 'text', delta: 'must not run on Mia' },
              { type: 'done', sessionId: 's1', terminationReason: 'normal' },
            ],
            stops,
          );
        }
        return fakeRun([{ type: 'text', delta: 'finished' }, { type: 'done', sessionId: 's1', terminationReason: 'normal' }]);
      },
      labelOf: async (account) => account.label ?? account.id,
    });
    const events = await collect(run);
    expect(calls.map((c) => c.account.id)).toEqual(['backup2', 'backup']);
    expect(calls[1]!.opts).toMatchObject({ sessionId: 's1', prompt: SWITCH_LINE_PROMPT });
    expect(stops).toEqual(['stop']);
    expect(events).not.toContainEqual({ type: 'text', delta: 'must not run on Mia' });
    const card = JSON.stringify(renderCard(events.reduce(reduce, initialState), { meta: { title: 'Occam' } }));
    expect(card).toContain('账户 Mia 5 小时窗口用量到了 80% 的切换线，已切换到 shilong.wang 继续');
    expect(card).toContain('Sponsor: shilong.wang');
  });

  it('waits for a quiet point: no switch while a tool or background task is running', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    pool.observe('backup', limit({ blocked: true, resetsAt: NOW + HOUR }));
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return spawned.length === 1
          ? fakeRun([
              { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
              { type: 'tool_use', id: 't2', name: 'Bash', input: {} },
              fiveHour(99),
              { type: 'background', count: 1 },
              { type: 'tool_result', id: 't1', output: '', isError: false },
              { type: 'tool_result', id: 't2', output: '', isError: false },
              { type: 'text', delta: 'still here' },
              { type: 'background', count: 0 },
              { type: 'tool_use', id: 't3', name: 'Read', input: {} },
              { type: 'tool_result', id: 't3', output: '', isError: false },
              { type: 'text', delta: 'not reached' },
              { type: 'done', terminationReason: 'normal' },
            ])
          : fakeRun([{ type: 'done', terminationReason: 'normal' }]);
      },
      labelOf: async (account) => account.label ?? account.id,
    });
    const events = await collect(run);
    expect(spawned).toEqual(['default', 'backup2']);
    expect(events).toContainEqual({ type: 'text', delta: 'still here' });
    expect(events).not.toContainEqual({ type: 'text', delta: 'not reached' });
  });

  it('with every account past a line, a run stays put and uses its account up', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    pool.observe('default', weekly(93));
    pool.observe('backup2', fiveHour(82));
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return fakeRun([
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          fiveHour(99),
          { type: 'tool_result', id: 't1', output: '', isError: false },
          { type: 'text', delta: 'kept going' },
          { type: 'done', terminationReason: 'normal' },
        ]);
      },
      labelOf: async (account) => account.label ?? account.id,
    });
    const events = await collect(run);
    expect(spawned).toEqual(['backup']);
    expect(events).toContainEqual({ type: 'text', delta: 'kept going' });
  });

  it('a refusal in the second round moves on to the next account that is not refused', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    pool.observe('backup', fiveHour(99));
    pool.observe('default', weekly(95));
    pool.observe('backup2', fiveHour(85));
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return spawned.length === 1 ? fakeRun(refused) : fakeRun([{ type: 'done', terminationReason: 'normal' }]);
      },
      labelOf: async (account) => account.label ?? account.id,
    });
    const events = await collect(run);
    expect(spawned).toEqual(['backup', 'default']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'account', label: 'default', switchedFrom: 'shilong.wang' }));
    expect(events.reduce(reduce, initialState).terminal).toBe('done');
  });

  it('past its line, a run moves to the best score rather than the next on the list, and makes it the main account', async () => {
    const { pool, paths } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    pool.observe('backup', weekly(5));
    pool.observe('default', weekly(60));
    pool.observe('backup2', weekly(10));
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return spawned.length === 1
          ? fakeRun([
              { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
              fiveHour(99),
              { type: 'tool_result', id: 't1', output: '', isError: false },
              { type: 'text', delta: 'never shown' },
            ])
          : fakeRun([{ type: 'done', terminationReason: 'normal' }]);
      },
      labelOf: async (account) => account.label ?? account.id,
    });
    await collect(run);
    expect(spawned).toEqual(['backup', 'backup2']);
    expect(pool.accounts().map((a) => a.id)).toEqual(['backup2', 'backup', 'default']);
    await pool.flush();
    expect(readAccountsConfig(paths).accounts.map((a) => a.id)).toEqual(['backup2', 'backup', 'default']);
    // The new main account keeps the next run while no other beats it by more
    // than STICKY_MARGIN (a move re-reads the conversation uncached)…
    pool.observe('backup2', weekly(50));
    pool.observe('default', weekly(45));
    expect(pool.score('default')).toBeGreaterThan(pool.score('backup2'));
    expect(pool.score('default') - pool.score('backup2')).toBeLessThanOrEqual(STICKY_MARGIN);
    expect(pool.pick()?.id).toBe('backup2');
    // …and every run checks again: a clearly better account takes it.
    pool.observe('default', weekly(0));
    expect(pool.score('default') - pool.score('backup2')).toBeGreaterThan(STICKY_MARGIN);
    expect(pool.pick()?.id).toBe('default');
  });
});

describe('pausing an account', () => {
  it('keeps a paused account out of every pick until the pause ends, then it comes back on its own', async () => {
    let now = NOW;
    const { pool, paths } = await poolWith(['b', 'c'], { now: () => now });
    await updateAccount(paths, 'b', { pausedUntil: NOW + 14 * 24 * HOUR });
    await pool.refresh();
    expect(readAccountsConfig(paths).accounts[1]).toEqual({ id: 'b', label: 'b-name', pausedUntil: NOW + 14 * 24 * HOUR });
    expect(pool.accounts().map((a) => a.id)).toEqual(['default', 'c']);
    expect(pool.isPaused('b')).toBe(true);
    pool.observe('default', limit({ blocked: true, resetsAt: NOW + HOUR }));
    pool.observe('c', limit({ blocked: true, resetsAt: NOW + 2 * HOUR }));
    // Every other account refused: still not the paused one.
    expect(pool.pick()?.id).toBe('default');
    expect(pool.pickRunnable()).toBeUndefined();
    expect(findPausedAccount(pool, 'B-NAME')).toMatchObject({ id: 'b', name: 'b-name' });
    expect(pausedNote(pool)).toContain('b-name（b）到');
    expect(accountsReport(pool, 'yu.ou', NOW).at(-1)).toContain('**b-name**（已暂停，b；');
    expect(accountRows(pool, 'yu.ou', NOW).map((r) => r.id)).toEqual(['default', 'c']);

    now = NOW + 14 * 24 * HOUR + 1;
    expect(pool.isPaused('b')).toBe(false);
    expect(pool.accounts().map((a) => a.id)).toEqual(['default', 'b', 'c']);
    expect(pausedNote(pool)).toBeUndefined();
  });

  it('resumes on request, and never pauses the CLI login', async () => {
    const { pool, paths } = await poolWith(['b']);
    await updateAccount(paths, 'b', { pausedUntil: NOW + HOUR });
    await updateAccount(paths, 'b', { pausedUntil: null });
    await pool.refresh();
    expect(readAccountsConfig(paths).accounts[1]).toEqual({ id: 'b', label: 'b-name' });
    expect(pool.isPaused('b')).toBe(false);
    await expect(updateAccount(paths, 'default', { pausedUntil: NOW + HOUR })).rejects.toThrow();
    expect(parseAccountsConfig(JSON.stringify({ accounts: [{ id: 'default', pausedUntil: NOW + HOUR }] })).accounts).toEqual([
      { id: 'default' },
    ]);
  });

  it('keeps the pause through a switch and a reorder', async () => {
    const { paths } = await poolWith(['b', 'c']);
    await updateAccount(paths, 'b', { pausedUntil: NOW + HOUR });
    await switchToAccount(paths, 'c');
    await reorderAccounts(paths, ['b']);
    expect(readAccountsConfig(paths).accounts.find((a) => a.id === 'b')?.pausedUntil).toBe(NOW + HOUR);
  });

  it('hands the next message elsewhere once the kept process is on an account that got paused', async () => {
    const { pool, paths } = await poolWith(['b']);
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    pool.promote('b');
    await pool.flush();
    // A capped run (课堂精练) does not follow the main account: only the pause moves it.
    const run = runWithAccountFailover({ ...OPTS, accountLineCap: { five_hour: 80 } }, {
      pool,
      spawn: (_opts, account) => {
        calls.push(account.id);
        if (calls.length > 1) return fakeRun([{ type: 'done', sessionId: 's1', terminationReason: 'normal' }]);
        return {
          ...fakeRun([]),
          events: (async function* () {
            yield { type: 'system', sessionId: 's1' } as AgentEvent;
            yield { type: 'done', sessionId: 's1', terminationReason: 'normal' } as AgentEvent;
            await gate;
            yield { type: 'done', terminationReason: 'interrupted' } as AgentEvent;
          })(),
          stop: async () => release(),
          send: (prompt: string) => {
            sent.push(prompt);
            return true;
          },
        };
      },
      labelOf: async (account) => account.label ?? account.id,
    });
    const it = run.events[Symbol.asyncIterator]();
    const seen: AgentEvent[] = [];
    while (seen.at(-1)?.type !== 'done') seen.push((await it.next()).value as AgentEvent);
    // The owner pauses `b` while its process is kept.
    await updateAccount(paths, 'b', { pausedUntil: NOW + HOUR });
    await pool.refresh();
    expect(run.send?.('new message')).toBe(true);
    for (let r = await it.next(); !r.done; r = await it.next()) seen.push(r.value);
    expect(sent).toEqual([]);
    expect(calls).toEqual(['b', 'default']);
    expect(seen).toContainEqual(expect.objectContaining({ type: 'account', switchedFrom: 'b-name', reason: '账户已暂停' }));
  });

  it('reads a pause as a date (local midnight), a date and time, or a number of days', () => {
    const now = new Date(2026, 9, 30, 18, 0).getTime();
    expect(parsePauseUntil({ until: '2026-11-13' }, now)).toBe(new Date(2026, 10, 13).getTime());
    expect(parsePauseUntil({ until: '2026-11-13T09:00' }, now)).toBe(new Date(2026, 10, 13, 9, 0).getTime());
    expect(parsePauseUntil({ days: '14' }, now)).toBe(now + 14 * 24 * HOUR);
    expect(parsePauseUntil({}, now)).toEqual(expect.any(String));
    expect(parsePauseUntil({ until: '2026-11-13', days: '3' }, now)).toEqual(expect.any(String));
    expect(parsePauseUntil({ until: '2026-10-01' }, now)).toEqual(expect.any(String));
    expect(parsePauseUntil({ until: 'soon' }, now)).toEqual(expect.any(String));
    expect(parsePauseUntil({ days: '-1' }, now)).toEqual(expect.any(String));
  });
});

describe('a per-run line cap (课堂精练)', () => {
  const CAP = { seven_day: 80 } as const;

  it('lowers every line for the calls that pass it, and never raises one', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    pool.observe('backup', weekly(85));
    expect(pool.lineOf('backup', 'seven_day', NOW, CAP)).toBe(80);
    expect(pool.lineOf('backup2', 'five_hour', NOW, { five_hour: 95 })).toBe(80);
    expect(pool.hasRoom('backup')).toBe(true);
    expect(pool.hasRoom('backup', CAP)).toBe(false);
    expect(pool.pastLine('backup', NOW, CAP)).toEqual({ kind: 'seven_day', line: 80 });
    expect(pool.pickReady()?.id).toBe('backup');
    expect(pool.pickReady(undefined, CAP)?.id).toBe('default');
  });

  it('takes a fresh /usage reading without lifting a refusal', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    pool.observe('default', limit({ blocked: true, resetsAt: NOW + HOUR }));
    pool.observeUsage('default', { seven_day: { usedPercent: 81, resetsAt: NOW + 2 * HOUR } });
    expect(pool.isRefused('default')).toBe(true);
    expect(pool.pastLine('default', NOW, CAP)).toEqual({ kind: 'seven_day', line: 80 });
  });

  it('moves a capped run off an account at the cap, only to one below it, and leaves the main account alone', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    pool.observe('backup', weekly(70));
    // Past the cap, still below its own 90% line: chats could use it, the capped run may not.
    pool.observe('default', weekly(85));
    // Near-equal to the main account: the run starts on the main one.
    pool.observe('backup2', weekly(68));
    const calls: Array<{ account: PickedAccount; opts: AgentRunOptions }> = [];
    const run = runWithAccountFailover(
      { ...OPTS, accountLineCap: CAP },
      {
        pool,
        spawn: (opts, account) => {
          calls.push({ account, opts });
          if (calls.length === 1) {
            return fakeRun([
              { type: 'system', sessionId: 's1' },
              { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
              weekly(81),
              { type: 'tool_result', id: 't1', output: 'ok', isError: false },
              { type: 'text', delta: 'must not run past the cap' },
              { type: 'done', sessionId: 's1', terminationReason: 'normal' },
            ]);
          }
          return fakeRun([{ type: 'text', delta: 'finished' }, { type: 'done', sessionId: 's1', terminationReason: 'normal' }]);
        },
        labelOf: async (account) => account.label ?? account.id,
      },
    );
    const events = await collect(run);
    expect(calls.map((c) => c.account.id)).toEqual(['backup', 'backup2']);
    expect(calls[1]!.opts).toMatchObject({ sessionId: 's1', prompt: SWITCH_LINE_PROMPT, accountLineCap: CAP });
    expect(events).not.toContainEqual({ type: 'text', delta: 'must not run past the cap' });
    const card = JSON.stringify(renderCard(events.reduce(reduce, initialState), { meta: { title: 'Occam' } }));
    expect(card).toContain('本周用量到了 80% 的切换线');
    // A borrowed account: the capped run does not make it the main one…
    expect(pool.accounts()[0]!.id).toBe('backup');
    // …chats still go by score, and backup2 now clearly beats the main one.
    expect(pool.score('backup2') - pool.score('backup')).toBeGreaterThan(STICKY_MARGIN);
    expect(pool.pick()?.id).toBe('backup2');
  });

  it('with every other account at the cap, finishes its turn where it is', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    pool.observe('backup', weekly(70));
    pool.observe('default', weekly(85));
    pool.observe('backup2', weekly(88));
    const spawned: string[] = [];
    const run = runWithAccountFailover(
      { ...OPTS, accountLineCap: CAP },
      {
        pool,
        spawn: (_opts, account) => {
          spawned.push(account.id);
          return fakeRun([
            { type: 'system', sessionId: 's1' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
            weekly(81),
            { type: 'tool_result', id: 't1', output: 'ok', isError: false },
            { type: 'text', delta: 'finishes here' },
            { type: 'done', sessionId: 's1', terminationReason: 'normal' },
          ]);
        },
        labelOf: async (account) => account.label ?? account.id,
      },
    );
    const events = await collect(run);
    expect(spawned).toEqual(['backup']);
    expect(events).toContainEqual({ type: 'text', delta: 'finishes here' });
  });

  it('after a refusal, moves only to an account below the cap', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    pool.observe('backup', weekly(70));
    pool.observe('default', weekly(85));
    pool.observe('backup2', weekly(88));
    const spawned: string[] = [];
    const run = runWithAccountFailover(
      { ...OPTS, accountLineCap: CAP },
      {
        pool,
        spawn: (_opts, account) => {
          spawned.push(account.id);
          return fakeRun(refused);
        },
        labelOf: async (account) => account.label ?? account.id,
        exitWaitMs: 10,
      },
    );
    await collect(run);
    // Nobody below the cap is left: the refused run ends instead of moving to default or Mia.
    expect(spawned).toEqual(['backup']);
  });
});

describe('most room by the weekly window', () => {
  it('judges "most room" by the week when asked, not by the fullest window', { skip: process.platform === 'win32', timeout: 20_000 }, async () => {
    const { pool, dir } = await poolWith(['b']);
    const broken = join(dir, 'claude-broken');
    await writeFile(broken, `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
    await chmod(broken, 0o755);
    pool.observe('default', limit({ windows: [{ kind: 'five_hour', usedPercent: 5, resetsAt: NOW + HOUR }, { kind: 'seven_day', usedPercent: 85, resetsAt: NOW + HOUR }] }));
    pool.observe('b', limit({ windows: [{ kind: 'five_hour', usedPercent: 90, resetsAt: NOW + HOUR }, { kind: 'seven_day', usedPercent: 60, resetsAt: NOW + HOUR }] }));
    const fullest = await readClaudeQuota({ cwd: dir }, broken, pool);
    expect(fullest?.windows.find((w) => w.label === '本周')?.usedPercent).toBe(85);
    const week = await readClaudeQuota({ cwd: dir, window: 'week' }, broken, pool);
    expect(week?.windows.find((w) => w.label === '本周')?.usedPercent).toBe(60);
  });
});

describe('quota check before a run (refreshPickQuota)', () => {
  const MIN = 60_000;

  it('re-reads the pick when its quota is stale and picks again; fresh or just-checked accounts are left alone', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    pool.observe('backup', weekly(5));
    pool.observe('backup2', weekly(10));
    pool.observe('default', weekly(10));
    const checkedAt = new Map<string, number>();
    const probed: string[] = [];
    // The main account's owner used it meanwhile: past its line now.
    const probe = async (p: typeof pool, account: PickedAccount): Promise<void> => {
      probed.push(account.id);
      p.observe(account.id, weekly(account.id === 'backup' ? 95 : 10));
    };
    // Reported a minute ago: nothing to check.
    await refreshPickQuota(pool, { probe, checkedAt, now: () => NOW + MIN });
    expect(probed).toEqual([]);
    // 20 minutes later: re-read it, move on, and check the new pick too (its
    // report is as old); the reading just taken is then fresh.
    await refreshPickQuota(pool, { probe, checkedAt, now: () => NOW + 20 * MIN });
    expect(probed[0]).toBe('backup');
    expect(probed).toHaveLength(2);
    expect(pool.pick()?.id).toBe(probed[1]);
    // Checked a moment ago, whatever the probe said: not again.
    await refreshPickQuota(pool, { probe, checkedAt, now: () => NOW + 21 * MIN });
    expect(probed).toHaveLength(2);
  });

  it('never throws when a probe fails', async () => {
    const { pool } = await poolInOrder(ROSTER, { five_hour: 98, seven_day: 90 });
    const probe = async (): Promise<void> => {
      throw new Error('offline');
    };
    await expect(refreshPickQuota(pool, { probe, checkedAt: new Map(), now: () => NOW + HOUR })).resolves.toBeUndefined();
  });
});

describe('a window about to reset opens its switch line', () => {
  const MIN = 60_000;
  const DAY = 24 * HOUR;
  /** The 2026-10-30 19:05 `/accounts` table: 焦银玲 past her 60% 5-hour line, 5 minutes from its reset. */
  async function screenshot() {
    const { pool, paths } = await poolInOrder(
      [
        { id: 'backup', label: 'shilong.wang' },
        { id: 'backup3', label: '汤欢', lines: { five_hour: 60, seven_day: 90 } },
        { id: 'backup4', label: '焦银玲', lines: { five_hour: 60, seven_day: 90 } },
        { id: 'default', lines: { five_hour: 80, seven_day: 90 } },
      ],
      { five_hour: 98, seven_day: 98 },
    );
    pool.observe('backup', limit({ windows: [
      { kind: 'five_hour', usedPercent: 21, resetsAt: NOW + HOUR + 55 * MIN },
      { kind: 'seven_day', usedPercent: 64, resetsAt: NOW + 3 * DAY + 14 * HOUR },
    ] }));
    pool.observe('backup3', limit({ windows: [
      { kind: 'five_hour', usedPercent: 40, resetsAt: NOW + 3 * HOUR },
      { kind: 'seven_day', usedPercent: 0, resetsAt: NOW + 6 * DAY },
    ] }));
    pool.observe('backup4', limit({ windows: [
      { kind: 'five_hour', usedPercent: 61, resetsAt: NOW + 5 * MIN },
      { kind: 'seven_day', usedPercent: 35, resetsAt: NOW + 5 * DAY + 10 * HOUR },
    ] }));
    pool.observe('default', limit({ windows: [{ kind: 'seven_day', usedPercent: 79, resetsAt: NOW + 2 * DAY }] }));
    return { pool, paths };
  }

  it('lets runs go past the line until the reset, and scores what comes back at the reset as room', async () => {
    const { pool } = await screenshot();
    expect(pool.lineOf('backup4', 'five_hour', NOW)).toBe(GRACE_LINE);
    expect(pool.pastLine('backup4', NOW)).toBeUndefined();
    expect(pool.isBoosted('backup4', NOW)).toBe(false);
    const rows = accountRows(pool, 'yu.ou', NOW);
    const table = accountsTable(rows);
    // Was 0 (past its line): now the best, far enough ahead of the main account to take the next run.
    expect(table).toContain('| ✅ **焦银玲**（备 2，backup4） | 61% / 0h5m | 35% / 5d10h | 60→98% / 90% | 48 | 使用中（5 小时窗口临近重置，切换线放宽） |');
    expect(table).toContain('| **shilong.wang**（主，backup） | 21% / 1h55m | 64% / 3d14h | 98% / 98% | 38 | 可用 |');
    expect(pool.pick()?.id).toBe('backup4');
    expect(switchRefusal(pool, findAccountRow(rows, '焦银玲')!)).toBeUndefined();
  });

  it('keeps the line while the reset is further off, and never past 98% or a run cap', async () => {
    const { pool } = await screenshot();
    // An hour and ten minutes before the reset: still the account's own line.
    const early = NOW - HOUR - 5 * MIN;
    expect(pool.lineOf('backup4', 'five_hour', early)).toBe(60);
    expect(pool.pastLine('backup4', early)?.kind).toBe('five_hour');
    expect(pool.score('backup4', early)).toBe(0);
    // The run's cap (课堂精练 stops at 80%) still holds.
    expect(pool.lineOf('backup4', 'five_hour', NOW, { five_hour: 50 })).toBe(50);
    // 98% and up is past the opened line too.
    pool.observe('backup4', limit({ windows: [{ kind: 'five_hour', usedPercent: 98, resetsAt: NOW + 5 * MIN }] }));
    expect(pool.pastLine('backup4', NOW)?.kind).toBe('five_hour');
    // The week opens in its last 12 hours.
    pool.observe('default', limit({ windows: [{ kind: 'seven_day', usedPercent: 93, resetsAt: NOW + 11 * HOUR }] }));
    expect(pool.lineOf('default', 'seven_day', NOW)).toBe(GRACE_LINE);
    expect(pool.pastLine('default', NOW)).toBeUndefined();
    pool.observe('default', limit({ windows: [{ kind: 'seven_day', usedPercent: 93, resetsAt: NOW + 13 * HOUR }] }));
    expect(pool.pastLine('default', NOW)?.kind).toBe('seven_day');
  });

  it('scores 5-hour room near the reset as nearly full', () => {
    const view = (five: number, fiveResetIn: number) => ({
      five_hour: { usedPercent: five, line: 98, resetsInMs: fiveResetIn },
      seven_day: { usedPercent: 30, line: 90, resetsInMs: 3 * DAY },
    });
    expect(switchScore(view(40, 10 * MIN), true)).toBeGreaterThan(switchScore(view(40, 2 * HOUR), true));
    expect(switchScore(view(40, 2 * HOUR), true)).toBeCloseTo(switchScore(view(40, HOUR), true));
    expect(switchScore(view(90, 1), true)).toBeCloseTo(switchScore(view(0, 1), true), 3);
  });
});

describe('reading every account for /accounts (refreshAllQuota)', () => {
  const MIN = 60_000;

  it('reads every stale account at once, skips fresh and paused ones, and names the ones that failed', async () => {
    const { pool } = await poolInOrder([...ROSTER, { id: 'backup3', label: '焦银玲', pausedUntil: NOW + 24 * HOUR }]);
    pool.observe('backup', weekly(5));
    const probed: string[] = [];
    let inFlight = 0;
    let most = 0;
    const probe = async (p: typeof pool, account: PickedAccount): Promise<boolean | void> => {
      probed.push(account.id);
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (account.id === 'backup2') return false;
      if (account.id === 'default') throw new Error('offline');
      p.observe(account.id, weekly(40));
    };
    // `backup` reported 30 seconds ago: not read again; the others never reported.
    expect(await refreshAllQuota(pool, { probe, now: () => NOW + MIN / 2 })).toEqual(expect.arrayContaining(['default', 'backup2']));
    expect(probed.sort()).toEqual(['backup2', 'default']);
    expect(most).toBe(2);
    // Two minutes on, everything is stale again; the paused one is never read.
    probed.length = 0;
    const failed = await refreshAllQuota(pool, { probe, now: () => NOW + 2 * MIN });
    expect(probed.sort()).toEqual(['backup', 'backup2', 'default']);
    expect(failed.sort()).toEqual(['backup2', 'default']);
  });
});
