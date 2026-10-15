import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatTokens, formatUsageLine, localDayKey, UsageLedger } from '../../../src/runtime/usage-ledger';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function ledgerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'usage-ledger-'));
  dirs.push(dir);
  return join(dir, 'usage.json');
}

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 1, 12, 0, 0).getTime();
const usage = (input: number, output: number, cost?: number) => ({
  type: 'usage' as const,
  inputTokens: input,
  cachedInputTokens: Math.floor(input / 2),
  outputTokens: output,
  ...(cost !== undefined ? { costUsd: cost } : {}),
});

describe('UsageLedger', () => {
  it('aggregates per person over a window, heaviest first, and keeps the latest name', async () => {
    const ledger = new UsageLedger(await ledgerPath());
    ledger.record({ actorId: 'ou_a', actorName: 'A', source: 'im', scopeId: 'c1', usage: usage(1000, 10, 0.5), at: NOW });
    ledger.record({ actorId: 'ou_a', actorName: 'A2', source: 'cron', scopeId: 'cron:1', usage: usage(1000, 10, 0.25), at: NOW - DAY });
    ledger.record({ actorId: 'ou_b', source: 'comment', scopeId: 'comment:1', usage: usage(500, 5, 1), at: NOW });
    ledger.record({ actorId: 'ou_b', source: 'im', scopeId: 'c2', usage: usage(500, 5, 1), at: NOW - 8 * DAY });

    const today = ledger.report({ days: 1, now: NOW });
    expect(today.map((r) => r.actorId)).toEqual(['ou_b', 'ou_a']);
    expect(today[1]).toMatchObject({ actorName: 'A2', total: { turns: 1, inputTokens: 1000, outputTokens: 10, costUsd: 0.5 } });

    const week = ledger.report({ days: 7, now: NOW });
    expect(week.find((r) => r.actorId === 'ou_a')?.total).toMatchObject({ turns: 2, inputTokens: 2000, cachedInputTokens: 1000 });
    expect(week.find((r) => r.actorId === 'ou_a')?.bySource).toMatchObject({ im: { turns: 1 }, cron: { turns: 1 } });
    expect(week.find((r) => r.actorId === 'ou_b')?.total.turns).toBe(1);

    expect(ledger.report({ days: 30, now: NOW, actorId: 'ou_b' }).map((r) => r.total.turns)).toEqual([2]);
    await ledger.flush();
  });

  it('drops days beyond the retention window', async () => {
    const ledger = new UsageLedger(await ledgerPath());
    ledger.record({ actorId: 'ou_a', source: 'im', scopeId: 'c', usage: usage(1, 1), at: NOW - 40 * DAY });
    ledger.record({ actorId: 'ou_a', source: 'im', scopeId: 'c', usage: usage(1, 1), at: NOW });
    expect(ledger.report({ days: 60, now: NOW })[0]?.total.turns).toBe(1);
    await ledger.flush();
  });

  it('persists privately and reloads', async () => {
    const path = await ledgerPath();
    const first = new UsageLedger(path);
    first.record({ actorId: 'ou_a', actorName: 'A', source: 'im', scopeId: 'c', usage: usage(10, 2, 0.01), at: NOW });
    await first.flush();
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const next = new UsageLedger(path);
    await next.load();
    expect(next.report({ days: 1, now: NOW })).toEqual([
      expect.objectContaining({ actorId: 'ou_a', actorName: 'A', total: expect.objectContaining({ turns: 1, costUsd: 0.01 }) }),
    ]);
  });

  it('uses the local calendar day and short human formats', () => {
    expect(localDayKey(NOW)).toBe('2026-10-01');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(24_812)).toBe('25k');
    expect(formatTokens(1_234)).toBe('1.2k');
    expect(formatTokens(3_456_789)).toBe('3.46M');
    expect(formatUsageLine({ inputTokens: 24_812, outputTokens: 51, costUsd: 0.0296 })).toBe('25k in / 51 out · ≈$0.03');
    expect(formatUsageLine({ inputTokens: 10, outputTokens: 5, costUsd: 0 })).toBe('10 in / 5 out');
  });
});
