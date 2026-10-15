import { describe, expect, it } from 'vitest';
import type { AgentTranscript, TranscriptExchange } from '../../../src/agent/session-transcript.js';
import { DREAM_DEFAULTS } from '../../../src/config/schema.js';
import { exchangeCost, exchangeHash, isChatScope, measureNewInput, selectDreamInputs } from '../../../src/dream/select.js';
import type { DreamSessionRecord } from '../../../src/dream/state.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-13T12:00:00Z');

function exchange(index: number, user = `问题 ${index}`, assistant = `答案 ${index}`): TranscriptExchange {
  return { index, user, assistant, mixedSenders: false };
}

function record(handle: string, patch: Partial<DreamSessionRecord> = {}): DreamSessionRecord {
  return {
    key: `claude:${handle}`,
    agentId: 'claude',
    handle,
    scopeId: `oc_${handle}`,
    cwd: '/tmp',
    firstSeenAt: NOW - 10 * HOUR,
    lastSeenAt: NOW - 2 * HOUR,
    consumed: 0,
    ...patch,
  };
}

function reader(map: Record<string, AgentTranscript | undefined>) {
  return async (r: DreamSessionRecord) => map[r.handle];
}

const settings = { ...DREAM_DEFAULTS };

describe('isChatScope', () => {
  it('excludes scheduled, meeting, comment and dream scopes', () => {
    expect(isChatScope('oc_1')).toBe(true);
    expect(isChatScope('oc_1:omt_2')).toBe(true);
    for (const scope of ['cron:job', 'meeting:1', 'comment:doc', 'dream:b:1', '']) expect(isChatScope(scope)).toBe(false);
  });
});

describe('selectDreamInputs', () => {
  it('reads only new exchanges after the cursor and labels sessions batch-wide', async () => {
    const t = { exchanges: [exchange(1), exchange(2), exchange(3)], lastActivityAt: NOW - 2 * HOUR };
    const a = record('a', { consumed: 1, consumedHash: exchangeHash(exchange(1)), consumedAt: NOW - 5 * HOUR });
    const b = record('b', { lastSeenAt: NOW - 3 * HOUR });
    const sel = await selectDreamInputs({ records: [b, a], settings, now: NOW, isBusy: () => false, read: reader({ a: t, b: t }) });
    expect(sel.scopes.map((s) => s.scopeId)).toEqual(['oc_a', 'oc_b']);
    const sa = sel.scopes[0]!.sessions[0]!;
    expect(sa).toMatchObject({ ref: 'S1', nextConsumed: 3, restarted: false });
    expect(sa.exchanges.map((e) => e.index)).toEqual([2, 3]);
    expect(sa.nextHash).toBe(exchangeHash(exchange(3)));
    expect(sel.scopes[1]!.sessions[0]!.ref).toBe('S2');
  });

  it('skips non-chat scopes and sessions with no new run since they were read', async () => {
    let reads = 0;
    const sel = await selectDreamInputs({
      records: [
        record('cron', { scopeId: 'cron:daily' }),
        record('old', { consumed: 2, consumedAt: NOW - HOUR, lastSeenAt: NOW - 2 * HOUR }),
      ],
      settings,
      now: NOW,
      isBusy: () => false,
      read: async () => {
        reads++;
        return { exchanges: [exchange(1)] };
      },
    });
    expect(reads).toBe(0);
    expect(sel.scopes).toEqual([]);
  });

  it('defers busy, still-active and unreadable sessions; reports idle ones', async () => {
    const recent = { exchanges: [exchange(1)], lastActivityAt: NOW - 5 * 60_000 };
    const done = { exchanges: [exchange(1)], lastActivityAt: NOW - 2 * HOUR };
    const sel = await selectDreamInputs({
      records: [
        record('busy'),
        record('active'),
        record('gone'),
        record('idle', { consumed: 1, consumedHash: exchangeHash(exchange(1)), consumedAt: NOW - 3 * HOUR }),
      ],
      settings,
      now: NOW,
      isBusy: (scope) => scope === 'oc_busy',
      read: reader({ busy: done, active: recent, idle: done }),
    });
    expect(sel.scopes).toEqual([]);
    expect(sel.idle.map((r) => r.handle)).toEqual(['idle']);
    expect(Object.fromEntries(sel.deferred.map((d) => [d.key, d.reason]))).toMatchObject({
      'claude:busy': '会话正在运行',
      'claude:active': expect.stringContaining('空闲不足'),
      'claude:gone': expect.stringContaining('转录'),
    });
  });

  it('restarts from the beginning when the transcript no longer matches the cursor', async () => {
    const t = { exchanges: [exchange(1, '改写过'), exchange(2)], lastActivityAt: NOW - 2 * HOUR };
    const sel = await selectDreamInputs({
      records: [record('a', { consumed: 1, consumedHash: exchangeHash(exchange(1)), consumedAt: NOW - 5 * HOUR })],
      settings,
      now: NOW,
      isBusy: () => false,
      read: reader({ a: t }),
    });
    expect(sel.scopes[0]!.sessions[0]).toMatchObject({ restarted: true, nextConsumed: 2 });
    expect(sel.scopes[0]!.sessions[0]!.exchanges).toHaveLength(2);
  });

  it('stops at the input budget and the session cap, deferring the rest', async () => {
    const big = (i: number) => exchange(i, 'x'.repeat(2_000), 'y'.repeat(3_000));
    const t = { exchanges: [big(1), big(2), big(3)], lastActivityAt: NOW - 2 * HOUR };
    const sel = await selectDreamInputs({
      records: [record('a'), record('b', { lastSeenAt: NOW - 3 * HOUR }), record('c', { lastSeenAt: NOW - 4 * HOUR })],
      settings: { ...settings, maxInputChars: 12_000, maxSessions: 2 },
      now: NOW,
      isBusy: () => false,
      read: reader({ a: t, b: t, c: t }),
    });
    expect(sel.scopes[0]!.sessions[0]!.exchanges).toHaveLength(2);
    expect(sel.scopes[0]!.sessions[0]!.nextConsumed).toBe(2);
    expect(sel.deferred).toEqual([
      { key: 'claude:b', reason: '超出本轮输入预算' },
      { key: 'claude:c', reason: '超出本轮输入预算' },
    ]);
  });

  it('honours the scope allowlist', async () => {
    const t = { exchanges: [exchange(1)], lastActivityAt: NOW - 2 * HOUR };
    const sel = await selectDreamInputs({
      records: [record('a'), record('b')],
      settings: { ...settings, scopes: ['oc_b'] },
      now: NOW,
      isBusy: () => false,
      read: reader({ a: t, b: t }),
    });
    expect(sel.scopes.map((s) => s.scopeId)).toEqual(['oc_b']);
  });
});

describe('measureNewInput', () => {
  it('counts what the next run would read, without moving anything', async () => {
    const records = [
      record('a', { consumed: 1, consumedHash: exchangeHash(exchange(1)), consumedAt: NOW - 3 * HOUR, firstSeenAt: NOW - 50 * HOUR }),
      record('b', { firstSeenAt: NOW - 20 * HOUR }),
      record('c', { scopeId: 'cron:daily' }),
      record('d', { consumed: 2, consumedHash: exchangeHash(exchange(2)), consumedAt: NOW - HOUR }),
    ];
    const read = reader({
      a: { exchanges: [exchange(1), exchange(2), exchange(3)] },
      b: { exchanges: [exchange(1)] },
      c: { exchanges: [exchange(1)] },
      d: { exchanges: [exchange(1), exchange(2)] },
    });
    const measured = await measureNewInput({ records, settings, read });
    expect(measured).toEqual({
      scopes: 2,
      sessions: 2,
      chars: exchangeCost(exchange(2)) + exchangeCost(exchange(3)) + exchangeCost(exchange(1)),
      oldestAt: NOW - 20 * HOUR,
    });
    expect(records[0]!.consumed).toBe(1);
  });
});
