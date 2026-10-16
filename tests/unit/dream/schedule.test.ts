import { describe, expect, it } from 'vitest';
import { DREAM_AUTO_DEFAULTS, parseDreamWindow, resolveDreamSettings, type DreamAutoSettings } from '../../../src/config/schema.js';
import { cheapDreamGate, dreamWindowAt, formatChars, materialGate } from '../../../src/dream/schedule.js';

const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);

function auto(patch: Partial<DreamAutoSettings> = {}): DreamAutoSettings {
  return { ...DREAM_AUTO_DEFAULTS, timezone: 'Asia/Shanghai', ...patch };
}

describe('dream window', () => {
  it('parses HH:MM-HH:MM and refuses an empty or malformed window', () => {
    expect(parseDreamWindow('1:00-7:30')).toEqual({ start: 60, end: 450, text: '01:00-07:30' });
    expect(parseDreamWindow('22:00-06:00')).toMatchObject({ start: 1320, end: 360 });
    expect(parseDreamWindow('03:00-03:00')).toBeUndefined();
    expect(parseDreamWindow('25:00-26:00')).toBeUndefined();
    expect(parseDreamWindow('nightly')).toBeUndefined();
  });

  it('is evaluated in its own time zone', () => {
    const window = auto().window; // 01:00-07:00 Shanghai = 17:00-23:00 UTC
    expect(dreamWindowAt(at('2026-10-13T18:00:00Z'), window, 'Asia/Shanghai')).toEqual({ inside: true, key: '2026-10-14' });
    expect(dreamWindowAt(at('2026-10-13T12:00:00Z'), window, 'Asia/Shanghai').inside).toBe(false);
    expect(dreamWindowAt(at('2026-10-13T12:00:00Z'), window, 'UTC').inside).toBe(false);
  });

  it('keys a window that wraps midnight by the evening it opened', () => {
    const window = parseDreamWindow('22:00-06:00')!;
    const evening = dreamWindowAt(at('2026-10-13T23:00:00Z'), window, 'UTC');
    const morning = dreamWindowAt(at('2026-10-14T05:00:00Z'), window, 'UTC');
    expect(evening).toEqual({ inside: true, key: '2026-10-13' });
    expect(morning).toEqual({ inside: true, key: '2026-10-13' });
    expect(dreamWindowAt(at('2026-10-14T07:00:00Z'), window, 'UTC').inside).toBe(false);
    expect(dreamWindowAt(at('2026-10-14T22:30:00Z'), window, 'UTC').key).toBe('2026-10-14');
  });
});

describe('cheapDreamGate', () => {
  const inside = at('2026-10-13T18:00:00Z');
  const ledger = { consecutiveFailures: 0 };

  it('passes inside the window with nothing against it', () => {
    expect(cheapDreamGate({ now: inside, auto: auto(), ledger })).toBeUndefined();
  });

  it('holds back outside the window, a second time in one window, and before the minimum interval', () => {
    expect(cheapDreamGate({ now: at('2026-10-13T12:00:00Z'), auto: auto(), ledger })).toMatchObject({ block: 'outside-window' });
    expect(cheapDreamGate({ now: inside, auto: auto(), ledger: { ...ledger, lastWindowKey: '2026-10-14' } })).toMatchObject({
      block: 'window-used',
    });
    expect(cheapDreamGate({ now: inside, auto: auto(), ledger: { ...ledger, lastCompletedAt: inside - 1.5 * DAY } })).toMatchObject({
      block: 'interval',
      reason: expect.stringContaining('1.5/3 天'),
    });
    expect(cheapDreamGate({ now: inside, auto: auto(), ledger: { ...ledger, lastCompletedAt: inside - 3 * DAY } })).toBeUndefined();
  });

  it('backs off after repeated failures and pauses at the limit', () => {
    const failed = { consecutiveFailures: 2, lastFailedAt: inside - DAY };
    expect(cheapDreamGate({ now: inside, auto: auto(), ledger: failed })).toMatchObject({ block: 'backoff', reason: expect.stringContaining('1/2 天') });
    expect(cheapDreamGate({ now: inside + DAY, auto: auto(), ledger: failed })).toBeUndefined();
    expect(cheapDreamGate({ now: inside, auto: auto(), ledger: { consecutiveFailures: 1, lastFailedAt: inside - DAY } })).toBeUndefined();
    expect(cheapDreamGate({ now: inside, auto: auto(), ledger: { consecutiveFailures: 3 } })).toMatchObject({
      block: 'paused',
      reason: expect.stringContaining('/practice run'),
    });
  });
});

describe('materialGate', () => {
  const now = at('2026-10-13T18:00:00Z');

  it('needs enough scopes or enough characters', () => {
    expect(materialGate({ now, auto: auto(), material: { scopes: 0, sessions: 0, chars: 0 }, since: undefined })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('没有新的'),
    });
    expect(materialGate({ now, auto: auto(), material: { scopes: 3, sessions: 4, chars: 21_000 }, since: now - DAY })).toEqual({
      ok: false,
      reason: '材料不足（3/5 个会话范围，2.1万/6万 字）',
    });
    expect(materialGate({ now, auto: auto(), material: { scopes: 5, sessions: 5, chars: 10 }, since: now }).ok).toBe(true);
    expect(materialGate({ now, auto: auto(), material: { scopes: 1, sessions: 1, chars: 60_000 }, since: now }).ok).toBe(true);
  });

  it('takes any new input past the longest interval, unless that fallback is off', () => {
    const little = { scopes: 1, sessions: 1, chars: 200 };
    expect(materialGate({ now, auto: auto(), material: little, since: now - 15 * DAY })).toEqual({
      ok: true,
      material: { ...little, fallback: true },
    });
    expect(materialGate({ now, auto: auto({ maxIntervalDays: 0 }), material: little, since: now - 99 * DAY }).ok).toBe(false);
    expect(materialGate({ now, auto: auto(), material: little, since: undefined }).ok).toBe(false);
  });

  it('formats character counts the way people read them', () => {
    expect(formatChars(950)).toBe('950');
    expect(formatChars(60_000)).toBe('6万');
    expect(formatChars(125_000)).toBe('12.5万');
  });
});

describe('resolveDreamSettings auto', () => {
  it('fills defaults and clamps out-of-range tuning', () => {
    const settings = resolveDreamSettings({
      window: 'bad',
      timezone: 'Mars/Base',
      minScopes: 0,
      minIntervalDays: 0.2,
      maxIntervalDays: 0,
      maxQuotaPercent: 500,
    }).auto;
    expect(settings.window.text).toBe('01:00-07:00');
    expect(settings.timezone).toBe(DREAM_AUTO_DEFAULTS.timezone);
    expect(settings.minScopes).toBe(DREAM_AUTO_DEFAULTS.minScopes);
    expect(settings.maxIntervalDays).toBe(0);
    expect(settings.maxQuotaPercent).toBe(DREAM_AUTO_DEFAULTS.maxQuotaPercent);
    expect(resolveDreamSettings({ window: '22:00-06:00', timezone: 'Europe/Berlin' }).auto).toMatchObject({
      window: { text: '22:00-06:00' },
      timezone: 'Europe/Berlin',
    });
  });
});
