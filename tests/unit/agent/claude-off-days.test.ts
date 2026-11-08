import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  claudeAccountsPaths,
  ClaudeAccountPool,
  GRACE_LINE,
  offDayNote,
  parseAccountsConfig,
  readAccountsConfig,
  switchScore,
  updateOffDayLines,
} from '../../../src/agent/claude/accounts.js';
import { isOffDay, parseHolidayYear } from '../../../src/agent/claude/off-days.js';
import type { AgentEvent } from '../../../src/agent/types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const dirs: string[] = [];
const pools: ClaudeAccountPool[] = [];
let tz: string | undefined;
beforeAll(() => {
  tz = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
});
afterAll(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.flush()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lcb-offday-'));
  dirs.push(dir);
  return dir;
}

/** 2026-11-08 08:00 Asia/Shanghai, a Sunday. */
const SUNDAY = new Date('2026-11-08T08:00:00+08:00').getTime();
const MONDAY = SUNDAY + DAY;

function limit(at: number, windows: Array<{ kind: string; usedPercent: number; resetsAt: number }>) {
  return { type: 'rate_limit', blocked: false, at, windows } as Extract<AgentEvent, { type: 'rate_limit' }>;
}

/** The 2026-11-08 07:59 `/accounts` table, with the rest-day rules the owner asked for. */
async function screenshot(now: number, offDay: (now: number) => boolean, rules = true) {
  const dir = await tmp();
  const paths = claudeAccountsPaths(dir);
  await writeFile(
    paths.configFile,
    JSON.stringify({
      lines: { five_hour: 98, seven_day: 90 },
      ...(rules
        ? { offDayLines: { five_hour: 98, seven_day: 98 }, offDayGraceHours: { five_hour: 5, seven_day: 24 } }
        : {}),
      accounts: [
        { id: 'backup', label: '仕龙', lines: { seven_day: 98 } },
        { id: 'backup4', label: '银玲', lines: { five_hour: 80, seven_day: 90 } },
        { id: 'default', label: '欧工', lines: { five_hour: 60 } },
      ],
    }),
  );
  const pool = new ClaudeAccountPool({
    paths,
    now: () => now,
    readSecret: async (secretId) => `tok-${secretId.replace('claude-oauth-', '')}`,
    isOffDay: offDay,
  });
  await pool.refresh();
  pools.push(pool);
  pool.observe('backup', limit(now, [
    { kind: 'five_hour', usedPercent: 2, resetsAt: now + 71 * 60_000 },
    { kind: 'seven_day', usedPercent: 83, resetsAt: now + 2 * DAY + HOUR },
  ]));
  pool.observe('backup4', limit(now, [
    { kind: 'five_hour', usedPercent: 0, resetsAt: now + 111 * 60_000 },
    { kind: 'seven_day', usedPercent: 30, resetsAt: now + 3 * DAY + 21 * HOUR },
  ]));
  pool.observe('default', limit(now, [
    { kind: 'five_hour', usedPercent: 0, resetsAt: now + 4 * HOUR },
    { kind: 'seven_day', usedPercent: 91, resetsAt: now + 11 * HOUR },
  ]));
  return { pool, paths };
}

describe('rest days (offDayLines / offDayGraceHours, 2026-11-08)', () => {
  it('parses, keeps and drops the rest-day rules', async () => {
    const config = parseAccountsConfig(
      JSON.stringify({ offDayLines: { five_hour: 98, seven_day: 120 }, offDayGraceHours: { five_hour: 5, seven_day: -1 } }),
    );
    expect(config.offDayLines).toEqual({ five_hour: 98 });
    expect(config.offDayGraceHours).toEqual({ five_hour: 5 });
    const dir = await tmp();
    const paths = claudeAccountsPaths(dir);
    await updateOffDayLines(paths, { five_hour: 98, seven_day: 98 }, { five_hour: 5, seven_day: 24 });
    expect(readAccountsConfig(paths).offDayLines).toEqual({ five_hour: 98, seven_day: 98 });
    expect(readAccountsConfig(paths).offDayGraceHours).toEqual({ five_hour: 5, seven_day: 24 });
    await updateOffDayLines(paths, { five_hour: 0, seven_day: 0 }, { five_hour: 0, seven_day: 0 });
    expect(readAccountsConfig(paths).offDayLines).toBeUndefined();
    expect(readAccountsConfig(paths).offDayGraceHours).toBeUndefined();
    await expect(updateOffDayLines(paths, { five_hour: 101 })).rejects.toThrow('1–100');
  });

  it('raises every line on rest days and leaves workdays alone', async () => {
    const rest = await screenshot(SUNDAY, () => true);
    expect(rest.pool.lineOf('backup4', 'five_hour')).toBe(98);
    expect(rest.pool.lineOf('backup4', 'seven_day')).toBe(98);
    expect(rest.pool.lineOf('default', 'five_hour')).toBe(98);
    expect(rest.pool.isBoosted('default')).toBe(false);
    const work = await screenshot(MONDAY, () => false);
    expect(work.pool.lineOf('backup4', 'five_hour')).toBe(80);
    expect(work.pool.lineOf('default', 'seven_day')).toBe(90);
    // A raise never lowers a line.
    const dir = await tmp();
    const paths = claudeAccountsPaths(dir);
    await writeFile(paths.configFile, JSON.stringify({ offDayLines: { five_hour: 50 }, accounts: [{ id: 'default' }] }));
    const pool = new ClaudeAccountPool({ paths, readSecret: async () => undefined, isOffDay: () => true });
    await pool.refresh();
    expect(pool.lineOf('default', 'five_hour')).toBe(98);
  });

  it('opens the whole 5-hour window and the last 24 hours of the week, and uses the week about to go first', async () => {
    const { pool } = await screenshot(SUNDAY, () => true);
    // 欧工: 91% of the week, 11 hours to its reset — past the 90% line on a workday.
    expect(pool.inGrace('default', 'seven_day')).toBe(true);
    expect(pool.inGrace('backup', 'five_hour')).toBe(true);
    expect(pool.graceSpanMs('five_hour')).toBe(5 * HOUR);
    expect(pool.graceSpanMs('seven_day')).toBe(24 * HOUR);
    expect(pool.pastLine('default')).toBeUndefined();
    expect(pool.score('default')).toBeGreaterThan(pool.score('backup'));
    expect(pool.score('default')).toBeGreaterThan(pool.score('backup4'));
    expect(pool.pick()?.id).toBe('default');
  });

  it('keeps the usual rules without them, or on a workday', async () => {
    const plain = await screenshot(SUNDAY, () => true, false);
    expect(plain.pool.pastLine('default')?.kind).toBe('seven_day');
    expect(plain.pool.score('default')).toBe(0);
    const work = await screenshot(MONDAY, () => false);
    expect(work.pool.graceSpanMs('five_hour', MONDAY)).toBeLessThan(5 * HOUR);
    expect(work.pool.pastLine('default')?.kind).toBe('seven_day');
    expect(work.pool.pick()?.id).not.toBe('default');
  });

  it('scores a rest-day 5-hour window by its whole span', () => {
    const views = (graceSpanMs?: number) => ({
      five_hour: { line: 98, usedPercent: 50, resetsInMs: 2.5 * HOUR, ...(graceSpanMs ? { graceSpanMs } : {}) },
      seven_day: { line: 98, usedPercent: 50, resetsInMs: 3 * DAY },
    });
    expect(switchScore(views(5 * HOUR), true, SUNDAY)).toBeGreaterThan(switchScore(views(), true, SUNDAY));
  });

  it('notes the rules under the table', async () => {
    const { pool } = await screenshot(SUNDAY, () => true);
    expect(offDayNote(pool, SUNDAY)).toBe(
      '🏖 休息日（周末和法定节假日，调休上班日除外）：切换线至少 5 小时窗口 98% · 本周 98%；临近重置放开到 98% 并优先使用：5 小时窗口重置前 5 小时 · 本周重置前 24 小时（今天是休息日，正在生效）',
    );
    expect(GRACE_LINE).toBe(98);
  });
});

describe('isOffDay', () => {
  it('reads the holiday calendar, with make-up workdays, and falls back to weekends', async () => {
    const dir = await tmp();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, '2026.json'),
      JSON.stringify({
        year: 2026,
        days: [
          { name: '国庆节', date: '2026-10-01', isOffDay: true },
          { name: '国庆节', date: '2026-10-10', isOffDay: false },
        ],
      }),
    );
    const at = (day: string): number => new Date(`${day}T10:00:00+08:00`).getTime();
    expect(isOffDay(at('2026-10-01'), dir)).toBe(true); // a Thursday holiday
    expect(isOffDay(at('2026-10-10'), dir)).toBe(false); // a Saturday at work
    expect(isOffDay(at('2026-11-08'), dir)).toBe(true); // Sunday
    expect(isOffDay(at('2026-11-09'), dir)).toBe(false); // Monday
    // No 2027 file yet: weekends only.
    expect(isOffDay(at('2027-01-02'), dir)).toBe(true);
    expect(parseHolidayYear('{"days":[]}')).toBeUndefined();
  });
});
