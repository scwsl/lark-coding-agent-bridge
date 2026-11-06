import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { staggerNote } from '../../../src/agent/account.js';
import {
  accountRows,
  claudeAccountsPaths,
  ClaudeAccountPool,
  updateStagger,
  type PickedAccount,
} from '../../../src/agent/claude/accounts.js';
import { refreshAllQuota, refreshPickQuota } from '../../../src/agent/claude/quota-probe.js';
import {
  AFTER_RESET_MS,
  FIVE_HOUR_MS,
  planStagger,
  startWindowStagger,
} from '../../../src/agent/claude/window-stagger.js';
import type { AgentEvent } from '../../../src/agent/types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 6, 16, 55);

const dirs: string[] = [];
const pools: ClaudeAccountPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.flush()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fiveHour(resetsAt: number, usedPercent = 0): Extract<AgentEvent, { type: 'rate_limit' }> {
  return { type: 'rate_limit', blocked: false, at: NOW, windows: [{ kind: 'five_hour', usedPercent, resetsAt }] };
}

async function poolOf(ids: string[], opts: { now: () => number; stagger?: false; paused?: string[] } = { now: () => NOW }) {
  const dir = await mkdtemp(join(tmpdir(), 'lcb-stagger-'));
  dirs.push(dir);
  const paths = claudeAccountsPaths(dir);
  const accounts = ids.map((id) => ({
    id,
    label: id,
    ...(opts.paused?.includes(id) ? { pausedUntil: NOW + 24 * HOUR } : {}),
  }));
  await writeFile(paths.configFile, JSON.stringify({ accounts, ...(opts.stagger === false ? { stagger: false } : {}) }));
  const pool = new ClaudeAccountPool({
    paths,
    now: opts.now,
    readSecret: async (secretId) => `tok-${secretId.replace('claude-oauth-', '')}`,
  });
  await pool.refresh();
  pools.push(pool);
  return { pool, paths };
}

/** Distance between neighbouring window starts, going round the 5 hours. */
function gaps(starts: number[]): number[] {
  const phases = starts.map((s) => ((s % FIVE_HOUR_MS) + FIVE_HOUR_MS) % FIVE_HOUR_MS).sort((a, b) => a - b);
  return phases.map((p, i) => (i + 1 < phases.length ? phases[i + 1]! : phases[0]! + FIVE_HOUR_MS) - p);
}

describe('planStagger', () => {
  it('spreads windows that reset together one step apart, keeping the first reset where it is', () => {
    // 11-07 00:55: the main account resets 02:50, three idle ones 03:20 (one
    // `/accounts` opened them together), the CLI login 03:29.
    const plan = planStagger(
      [
        { id: 'backup', resetsAt: NOW + 115 * MIN, main: true, busy: true },
        { id: 'backup3', resetsAt: NOW + 145 * MIN },
        { id: 'backup4', resetsAt: NOW + 145 * MIN },
        { id: 'backup5', resetsAt: NOW + 145 * MIN },
        { id: 'default', resetsAt: NOW + 154 * MIN },
      ],
      NOW,
    );
    const main = plan.find((s) => s.id === 'backup')!;
    expect(main.delayMs).toBe(0);
    expect(main.warmAt).toBe(NOW + 115 * MIN + AFTER_RESET_MS);
    const starts = plan.map((s) => s.warmAt).sort((a, b) => a - b);
    expect(starts.map((s) => (s - starts[0]!) / MIN)).toEqual([0, 60, 120, 180, 240]);
    expect(plan.every((s) => s.open)).toBe(true);
  });

  it('leaves windows that are already staggered alone', () => {
    const plan = planStagger(
      [0, 1, 2, 3, 4].map((k) => ({ id: `a${k}`, resetsAt: NOW + 10 * MIN + k * HOUR })),
      NOW,
    );
    expect(plan.map((s) => s.delayMs)).toEqual([0, 0, 0, 0, 0]);
  });

  it('counts a window within a few minutes of its slot as on it', () => {
    // 6 accounts → 50 minutes apart; one starts 7 minutes late.
    const resets = [0, 50, 100, 157, 200, 250].map((m) => NOW + 20 * MIN + m * MIN);
    const plan = planStagger(resets.map((resetsAt, i) => ({ id: `a${i}`, resetsAt })), NOW);
    expect(plan.map((s) => s.delayMs)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('with no window open, opens one now and the rest a step apart', () => {
    const plan = planStagger([{ id: 'a' }, { id: 'b', resetsAt: NOW - HOUR }, { id: 'c' }], NOW);
    expect(plan.map((s) => s.open)).toEqual([false, false, false]);
    expect(plan.map((s) => (s.warmAt - NOW) / MIN).sort((a, b) => a - b)).toEqual([0, 100, 200]);
  });

  it('fits idle accounts into the gaps between open windows', () => {
    const plan = planStagger(
      [
        { id: 'open1', resetsAt: NOW + 30 * MIN },
        { id: 'open2', resetsAt: NOW + 150 * MIN },
        { id: 'idle1' },
        { id: 'idle2' },
      ],
      NOW,
    );
    // Even, give or take the few minutes a start counts as on its slot.
    for (const gap of gaps(plan.map((s) => s.warmAt))) expect(Math.abs(gap - 75 * MIN)).toBeLessThanOrEqual(15 * MIN);
    for (const slot of plan) expect(slot.warmAt).toBeGreaterThanOrEqual(NOW);
  });

  it('never puts the main account off, and moves idle accounts before busy ones', () => {
    // Without the main flag, delaying `m` 30 minutes would be cheapest overall.
    const inputs = [
      { id: 'm', resetsAt: NOW + 115 * MIN, main: true },
      { id: 'x', resetsAt: NOW + 145 * MIN, busy: true },
      { id: 'y', resetsAt: NOW + 145 * MIN },
    ];
    const plan = planStagger(inputs, NOW);
    expect(plan.find((s) => s.id === 'm')!.delayMs).toBe(0);
    // x (busy) keeps the nearer slot; y (idle) is the one moved further.
    expect(plan.find((s) => s.id === 'x')!.delayMs).toBeLessThan(plan.find((s) => s.id === 'y')!.delayMs);
    expect(gaps(plan.map((s) => s.warmAt))).toEqual([100, 100, 100].map((m) => m * MIN));
  });

  it('puts nothing off for a single account', () => {
    expect(planStagger([{ id: 'a', resetsAt: NOW - MIN }], NOW)).toEqual([{ id: 'a', warmAt: NOW, delayMs: 0, open: false }]);
  });
});

describe('quota probes leave idle windows to the stagger', () => {
  it('/accounts does not probe a token account whose 5-hour window ran out; the CLI login and stagger-off still are', async () => {
    const { pool, paths } = await poolOf(['default', 'b1', 'b2', 'b3'], { now: () => NOW });
    pool.observe('b1', fiveHour(NOW - 10 * MIN));
    pool.observe('b2', fiveHour(NOW + HOUR));
    pool.observe('default', fiveHour(NOW - 10 * MIN));
    const probed: string[] = [];
    const probe = async (_p: ClaudeAccountPool, account: PickedAccount) => {
      probed.push(account.id);
    };
    await refreshAllQuota(pool, { probe, now: () => NOW + 2 * MIN });
    // b1 waits for its slot; b3 was never read, so it is.
    expect(probed.sort()).toEqual(['b2', 'b3', 'default']);

    await updateStagger(paths, false);
    await pool.refresh();
    probed.length = 0;
    await refreshAllQuota(pool, { probe, now: () => NOW + 4 * MIN });
    expect(probed.sort()).toEqual(['b1', 'b2', 'b3', 'default']);
  });

  it('a run about to start does not probe a held account', async () => {
    const { pool } = await poolOf(['b1', 'default'], { now: () => NOW });
    pool.observe('b1', fiveHour(NOW - 10 * MIN));
    const probed: string[] = [];
    await refreshPickQuota(pool, {
      probe: async (_p, account) => {
        probed.push(account.id);
      },
      checkedAt: new Map(),
      now: () => NOW + HOUR,
    });
    expect(probed).toEqual([]);
  });

  it('stagger off is written to the file and read back', async () => {
    const { pool, paths } = await poolOf(['b1', 'default'], { now: () => NOW });
    expect(pool.staggerEnabled).toBe(true);
    await updateStagger(paths, false);
    expect(JSON.parse(await readFile(paths.configFile, 'utf8')).stagger).toBe(false);
    await pool.refresh();
    expect(pool.staggerEnabled).toBe(false);
    await updateStagger(paths, true);
    expect(JSON.parse(await readFile(paths.configFile, 'utf8')).stagger).toBeUndefined();
  });
});

describe('startWindowStagger', () => {
  it('opens each window at its slot, never an open one, and retries a failed warm-up after a while', async () => {
    let now = NOW;
    const { pool } = await poolOf(['b1', 'b2', 'default', 'paused'], { now: () => now, paused: ['paused'] });
    // 3 accounts (the paused one is left out) → 100 minutes apart. b1 resets
    // at +10 min, b2 at +110: already a step apart; `default` is idle and
    // goes in the slot after them.
    pool.observe('b1', fiveHour(NOW + 10 * MIN, 40));
    pool.observe('b2', fiveHour(NOW + 110 * MIN, 5));
    const warmed: string[] = [];
    let fail = new Set<string>(['default']);
    const stagger = startWindowStagger({
      pool,
      now: () => now,
      tickMs: 3_600_000,
      warm: async (p, account) => {
        warmed.push(account.id);
        if (fail.has(account.id)) return false;
        p.observe(account.id, fiveHour(now + FIVE_HOUR_MS));
        return true;
      },
    });
    const at = async (minutes: number): Promise<string[]> => {
      now = NOW + minutes * MIN;
      await stagger.tick();
      return [...warmed];
    };
    try {
      expect(await at(0)).toEqual([]);
      expect(await at(5)).toEqual([]);
      // b1's window ran out: reopened a minute after its reset.
      expect(await at(11)).toEqual(['b1']);
      expect(await at(60)).toEqual(['b1']);
      expect(await at(111)).toEqual(['b1', 'b2']);
      // default's slot: one step after b2. The warm-up fails…
      expect(await at(150)).toEqual(['b1', 'b2']);
      expect(await at(215)).toEqual(['b1', 'b2', 'default']);
      // …and is not tried again for 10 minutes.
      fail = new Set();
      expect(await at(220)).toEqual(['b1', 'b2', 'default']);
      expect(await at(226)).toEqual(['b1', 'b2', 'default', 'default']);
      expect(pool.fiveHourResetsAt('default')).toBe(NOW + 226 * MIN + FIVE_HOUR_MS);
      // Next resets: b1 +311, b2 +411, default +526 — about a step apart
      // (default 15 minutes late for the failed try; its next reset puts it back).
      expect(['b1', 'b2'].map((id) => (pool.fiveHourResetsAt(id)! - NOW) / MIN)).toEqual([311, 411]);
    } finally {
      await stagger.stop();
    }
  });

  it('does nothing when the owner turned it off', async () => {
    const { pool } = await poolOf(['b1', 'b2'], { now: () => NOW, stagger: false });
    const warmed: string[] = [];
    const stagger = startWindowStagger({
      pool,
      now: () => NOW,
      tickMs: 3_600_000,
      warm: async (_p, account) => {
        warmed.push(account.id);
        return true;
      },
    });
    await stagger.tick();
    await stagger.stop();
    expect(warmed).toEqual([]);
  });
});

describe('staggerNote', () => {
  it('lists the next window starts in order and names the accounts held back', async () => {
    const { pool } = await poolOf(['b1', 'b2', 'default'], { now: () => NOW });
    const rows = accountRows(pool, undefined, NOW);
    const note = staggerNote(
      [
        { id: 'b1', warmAt: NOW + 31 * MIN, delayMs: 0, open: true },
        { id: 'b2', warmAt: NOW + 231 * MIN, delayMs: 60 * MIN, open: true },
        { id: 'default', warmAt: NOW + 131 * MIN, delayMs: 0, open: false },
      ],
      rows,
    )!;
    expect(note).toContain('3 个账户每 100 分钟错开一个重置');
    expect(note.indexOf('b1')).toBeLessThan(note.indexOf('b2'));
    expect(note).toMatch(/b2 的窗口要往后挪/);
    expect(staggerNote([{ id: 'b1', warmAt: NOW, delayMs: 0, open: true }], rows)).toBeUndefined();
  });
});
