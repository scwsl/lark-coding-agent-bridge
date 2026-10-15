import { describe, expect, it } from 'vitest';
import { formatElapsed, planLongRunNotice, type LongRunNoticeInput } from '../../../src/bot/long-run-notice';
import { getLongRunNoticeMs, type AppConfig } from '../../../src/config/schema';

const MIN = 60_000;

const base: LongRunNoticeInput = {
  thresholdMs: 5 * MIN,
  elapsedMs: 12 * MIN,
  terminal: 'done',
  p2p: false,
  answerIsNewMessage: false,
  requesters: [{ openId: 'ou_a', name: 'Alice' }],
};

describe('planLongRunNotice', () => {
  it('@-mentions each requester once in a group', () => {
    const notice = planLongRunNotice({
      ...base,
      requesters: [
        { openId: 'ou_a', name: 'Alice' },
        { openId: 'ou_b' },
        { openId: 'ou_a', name: 'Alice' },
      ],
    });
    expect(notice?.text).toContain('任务完成');
    expect(notice?.text).toContain('12 分钟');
    expect(notice?.mentions.map((m) => m.openId)).toEqual(['ou_a', 'ou_b']);
  });

  it('notifies even when a group answer was a new message, since the group may be muted', () => {
    expect(planLongRunNotice({ ...base, answerIsNewMessage: true })).toBeDefined();
  });

  it('skips a group run that only bots asked for', () => {
    expect(planLongRunNotice({ ...base, requesters: [] })).toBeUndefined();
  });

  it('in a DM, notifies only when the answer landed in the in-place card', () => {
    expect(planLongRunNotice({ ...base, p2p: true, requesters: [] })).toMatchObject({ mentions: [] });
    expect(planLongRunNotice({ ...base, p2p: true, answerIsNewMessage: true })).toBeUndefined();
  });

  it('reports failures and timeouts, but not a run the user stopped', () => {
    expect(planLongRunNotice({ ...base, terminal: 'error' })?.text).toContain('异常结束');
    expect(planLongRunNotice({ ...base, terminal: 'idle_timeout' })?.text).toContain('详情');
    expect(planLongRunNotice({ ...base, terminal: 'interrupted' })).toBeUndefined();
    expect(planLongRunNotice({ ...base, terminal: undefined })).toBeUndefined();
  });

  it('stays quiet below the threshold or when switched off', () => {
    expect(planLongRunNotice({ ...base, elapsedMs: 4 * MIN })).toBeUndefined();
    expect(planLongRunNotice({ ...base, thresholdMs: undefined })).toBeUndefined();
  });
});

describe('formatElapsed', () => {
  it('rounds to whole minutes and switches to hours past sixty', () => {
    expect(formatElapsed(20_000)).toBe('1 分钟');
    expect(formatElapsed(12.4 * MIN)).toBe('12 分钟');
    expect(formatElapsed(60 * MIN)).toBe('1 小时');
    expect(formatElapsed(65 * MIN)).toBe('1 小时 5 分钟');
  });
});

describe('getLongRunNoticeMs', () => {
  const cfg = (longRunNoticeMinutes?: number) => ({ preferences: { longRunNoticeMinutes } }) as unknown as AppConfig;

  it('defaults to five minutes, 0 turns it off, out-of-range values clamp', () => {
    expect(getLongRunNoticeMs({} as AppConfig)).toBe(5 * MIN);
    expect(getLongRunNoticeMs(cfg(0))).toBeUndefined();
    expect(getLongRunNoticeMs(cfg(10))).toBe(10 * MIN);
    expect(getLongRunNoticeMs(cfg(0.5))).toBe(1 * MIN);
    expect(getLongRunNoticeMs(cfg(100_000))).toBe(24 * 60 * MIN);
  });
});
