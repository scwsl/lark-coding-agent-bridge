import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAccountPool, FABLE_WINDOW, claudeAccountsPaths } from '../../../src/agent/claude/accounts';
import { parseFableWeek } from '../../../src/agent/claude/quota';

describe('parseFableWeek', () => {
  it('reads the Fable weekly line of /usage', () => {
    const text = [
      'Current session: 4% used · resets Oct 14, 3:19am (Asia/Shanghai)',
      'Current week (all models): 50% used · resets Oct 18, 2:59pm (Asia/Shanghai)',
      'Current week (Fable): 37.5% used · resets Oct 18, 3pm (Asia/Shanghai)',
    ].join('\n');
    const fable = parseFableWeek(text, Date.UTC(2026, 9, 14));
    expect(fable?.usedPercent).toBe(37.5);
    expect(fable?.resetsAt).toBeGreaterThan(Date.UTC(2026, 9, 14));
  });

  it('is undefined without one', () => {
    expect(parseFableWeek('Current week (all models): 50% used')).toBeUndefined();
  });
});

describe('ClaudeAccountPool model windows', () => {
  it('keeps the Fable window apart and reads it back until its reset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fable-quota-'));
    let now = 1_000;
    const pool = new ClaudeAccountPool({ paths: claudeAccountsPaths(dir), now: () => now });
    pool.observeModelWindow('default', FABLE_WINDOW, { usedPercent: 91, resetsAt: 5_000 });
    expect(pool.windowUsed('default', FABLE_WINDOW)).toBe(91);
    expect(pool.windowUsed('default', 'seven_day')).toBeUndefined();
    now = 5_000;
    expect(pool.windowUsed('default', FABLE_WINDOW)).toBe(0);
  });
});
