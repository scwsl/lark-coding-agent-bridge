import { describe, expect, it } from 'vitest';
import { getSmartSession, SMART_SESSION_DEFAULTS, type AppConfig } from '../../../src/config/schema';
import {
  decideRotation,
  handoffSection,
  newSessionRequest,
  rotationNotice,
  stripNewSessionMarker,
} from '../../../src/session/smart-session';

const MIN = 60_000;
const now = 10_000 * MIN;

describe('decideRotation', () => {
  const settings = SMART_SESSION_DEFAULTS;

  it('rotates an idle conversation with a large context', () => {
    expect(
      decideRotation({ settings, now, probe: { lastActivityAt: now - 61 * MIN, contextTokens: 150_000 } }),
    ).toMatchObject({ reason: 'idle-large', idleMinutes: 61, contextTokens: 150_000 });
  });

  it('keeps a large conversation that is still warm', () => {
    expect(decideRotation({ settings, now, probe: { lastActivityAt: now - 59 * MIN, contextTokens: 900_000 } })).toBeUndefined();
  });

  it('keeps a small idle conversation until the hard idle limit', () => {
    expect(decideRotation({ settings, now, probe: { lastActivityAt: now - 300 * MIN, contextTokens: 20_000 } })).toBeUndefined();
    expect(
      decideRotation({ settings, now, probe: { lastActivityAt: now - 480 * MIN, contextTokens: 20_000 } }),
    ).toMatchObject({ reason: 'idle-long' });
  });

  it('keeps the conversation when its age is unknown', () => {
    expect(decideRotation({ settings, now, probe: { contextTokens: 900_000 } })).toBeUndefined();
    expect(decideRotation({ settings, now, probe: undefined })).toBeUndefined();
  });

  it('applies an agent-requested close only to the conversation it was made in', () => {
    const pending = { summary: '做完了', handle: 'sess-1' };
    expect(decideRotation({ settings, now, probe: undefined, pending, resumeHandle: 'sess-1' })).toMatchObject({
      reason: 'agent-done',
      summary: '做完了',
    });
    expect(decideRotation({ settings, now, probe: undefined, pending, resumeHandle: 'sess-2' })).toBeUndefined();
    expect(
      decideRotation({ settings, now, probe: undefined, pending: { summary: '旧请求' }, resumeHandle: 'sess-2' }),
    ).toMatchObject({ reason: 'agent-done' });
  });

  it('honours an agent-requested close whatever the idle time', () => {
    expect(
      decideRotation({ settings, now, pending: { summary: '修完了' }, probe: { lastActivityAt: now - MIN } }),
    ).toMatchObject({ reason: 'agent-done', summary: '修完了' });
    expect(decideRotation({ settings, now, pending: {}, probe: undefined })).toMatchObject({ reason: 'agent-done' });
  });
});

describe('[[NEW_SESSION]] marker', () => {
  it('reads a trailing marker, with or without a summary', () => {
    expect(newSessionRequest('都改好了。\n\n[[NEW_SESSION]]')).toEqual({});
    expect(newSessionRequest('都改好了。\n[[NEW_SESSION: 修好了群管理面板]]')).toEqual({ summary: '修好了群管理面板' });
    expect(newSessionRequest('都改好了。\n[[NEW_SESSION：全角冒号也行]]\n')).toEqual({ summary: '全角冒号也行' });
  });

  it('ignores a marker that is not at the end', () => {
    expect(newSessionRequest('[[NEW_SESSION]] 之后还有话')).toBeUndefined();
    expect(newSessionRequest('普通回答')).toBeUndefined();
    expect(newSessionRequest(undefined)).toBeUndefined();
  });

  it('strips the marker from what the user sees', () => {
    expect(stripNewSessionMarker('都改好了。\n\n[[NEW_SESSION: x]]')).toBe('都改好了。');
    expect(stripNewSessionMarker('没有标记')).toBe('没有标记');
  });

  it('hides a marker still streaming in, but not a lone bracket', () => {
    expect(stripNewSessionMarker('都改好了。\n[[NEW_SES', true)).toBe('都改好了。');
    expect(stripNewSessionMarker('都改好了。\n[[NEW_SESSION: 修好', true)).toBe('都改好了。');
    expect(stripNewSessionMarker('数组 a[', true)).toBe('数组 a[');
    expect(stripNewSessionMarker('都改好了。\n[[NEW_SES', false)).toBe('都改好了。\n[[NEW_SES');
  });
});

describe('hand-off and notice', () => {
  it('tells the fresh session what was archived', () => {
    const section = handoffSection({ reason: 'idle-large', idleMinutes: 180, lastUserText: '查一下 T20 的版本' });
    expect(section).toMatch(/^<session_handoff>\n/);
    expect(section).toContain('查一下 T20 的版本');
    expect(section).toContain('/resume');
  });

  it('explains the renewal in one line', () => {
    expect(rotationNotice({ reason: 'idle-large', idleMinutes: 180, contextTokens: 450_000 })).toContain('3 小时前');
    expect(rotationNotice({ reason: 'idle-large', idleMinutes: 180, contextTokens: 450_000 })).toContain('45 万');
    expect(rotationNotice({ reason: 'agent-done' })).toContain('上一件事已完成');
    expect(rotationNotice({ reason: 'idle-long', idleMinutes: 3 * 24 * 60 })).toContain('3 天前');
  });
});

describe('getSmartSession', () => {
  const cfg = (preferences: AppConfig['preferences']) => ({ preferences }) as AppConfig;

  it('is off unless explicitly switched on', () => {
    expect(getSmartSession(cfg(undefined))).toBeUndefined();
    expect(getSmartSession(cfg({ smartSession: false }))).toBeUndefined();
    expect(getSmartSession(cfg({ smartSession: true }))).toEqual(SMART_SESSION_DEFAULTS);
  });

  it('takes tuning within range and falls back otherwise', () => {
    expect(
      getSmartSession(cfg({ smartSession: true, smartSessionTuning: { idleMinutes: 90, minContextTokens: 1 } })),
    ).toMatchObject({ idleMinutes: 90, minContextTokens: SMART_SESSION_DEFAULTS.minContextTokens });
  });
});
