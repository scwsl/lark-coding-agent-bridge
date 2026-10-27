import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CandidatePool, candidateOf, needsPool, planPool, scopeFamily, similarity, type PoolCandidate } from '../../../src/dream/pool.js';
import type { MemoryAddition } from '../../../src/dream/proposal.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-27T20:00:00Z');
const TZ = 'Asia/Shanghai';

function note(scopeId: string, slug: string, text: string, hash: string, session = 'claude:a'): MemoryAddition {
  return {
    kind: 'add',
    scopeId,
    target: 'note',
    note: slug,
    text,
    reason: '理由',
    sources: [{ ref: 'S1#1', sessionKey: session, sessionRef: 'S1', index: 1, admin: false }],
    evidence: 'inferred',
    hash,
  };
}

function candidate(addition: MemoryAddition, day = '2026-10-28'): PoolCandidate {
  return { addition, days: [day], sessions: addition.sources.map((source) => source.sessionKey) };
}

const noReads = () => 0;

describe('needsPool / scopeFamily / similarity', () => {
  it('pools only inferred notes', () => {
    expect(needsPool(note('oc_1', 'a', 't', 'h'))).toBe(true);
    expect(needsPool({ ...note('oc_1', 'a', 't', 'h'), evidence: undefined })).toBe(true);
    expect(needsPool({ ...note('oc_1', 'a', 't', 'h'), evidence: 'verified' })).toBe(false);
    expect(needsPool({ ...note('oc_1', 'a', 't', 'h'), evidence: 'admin' })).toBe(false);
    expect(needsPool({ ...note('oc_1', 'a', 't', 'h'), target: 'chat' })).toBe(false);
  });

  it('knows a topic belongs to its chat', () => {
    expect(scopeFamily('oc_1:omt_2')).toBe('oc_1');
    expect(scopeFamily('oc_1')).toBe('oc_1');
  });

  it('measures wording, not meaning', () => {
    expect(similarity('构建前先清缓存', '构建前先清缓存')).toBe(1);
    expect(similarity('构建前要先清理本地缓存', '构建之前先清理本地缓存')).toBeGreaterThanOrEqual(0.5);
    expect(similarity('构建前先清缓存', '抓包最长 30 分钟')).toBeLessThan(0.2);
  });
});

describe('planPool', () => {
  it('holds a first-time inference, and promotes it when it comes back on another day', () => {
    const first = planPool({ entries: [], candidates: [candidate(note('oc_1', 'build', '构建前要先清理本地缓存', 'h1'), '2026-10-27')], now: NOW, timezone: TZ, reads: noReads });
    expect(first).toMatchObject({ promote: [], entered: 1, expired: 0 });
    expect(first.entries).toHaveLength(1);

    // Next day, near the same words, same conversation: another day is enough.
    const second = planPool({
      entries: first.entries,
      candidates: [candidate(note('oc_1', 'build', '构建之前先清理本地缓存', 'h2'), '2026-10-28')],
      now: NOW + DAY,
      timezone: TZ,
      reads: noReads,
    });
    expect(second.entered).toBe(0);
    expect(second.entries).toEqual([]);
    expect(second.promote).toEqual([expect.objectContaining({ scopeId: 'oc_1', note: 'build', text: '构建之前先清理本地缓存', hash: 'h2' })]);
    expect(second.published).toEqual(['h1', 'h2']);
  });

  it('promotes on a second conversation the same day, and on a read of the target note', () => {
    const a = candidate(note('oc_1', 'build', '构建前要先清理本地缓存', 'h1', 'claude:a'));
    const b = candidate(note('oc_1', 'build', '构建前要先清理本地缓存', 'h1', 'claude:b'));
    expect(planPool({ entries: [], candidates: [a, b], now: NOW, timezone: TZ, reads: noReads }).promote).toHaveLength(1);

    const held = planPool({ entries: [], candidates: [candidate(note('oc_1', 'kube', '集群在 aus', 'k1'))], now: NOW, timezone: TZ, reads: noReads });
    const read = planPool({ entries: held.entries, candidates: [], now: NOW + DAY, timezone: TZ, reads: (name) => (name === 'oc_1/kube' ? 1 : 0) });
    expect(read.promote.map((item) => item.hash)).toEqual(['k1']);
  });

  it('expires what waited too long, and keeps different notes apart', () => {
    const held = planPool({
      entries: [],
      candidates: [candidate(note('oc_1', 'build', '构建前要先清理本地缓存', 'h1')), candidate(note('oc_1', 'deploy', '构建前要先清理本地缓存', 'd1'))],
      now: NOW,
      timezone: TZ,
      reads: noReads,
    });
    expect(held.entries).toHaveLength(2);
    const later = planPool({ entries: held.entries, candidates: [], now: NOW + 31 * DAY, timezone: TZ, reads: noReads });
    expect(later).toMatchObject({ promote: [], entries: [], expired: 2 });
  });

  it('follows REM themes: one entry per chat, lifted to the chat when its topics agree, recurrence across chats', () => {
    const topicA = candidate(note('oc_1:omt_a', 'build', '构建要用 mvnd', 'a1', 'claude:a'));
    const topicB = candidate(note('oc_1:omt_b', 'build-tool', '本机构建统一 mvnd -T 10', 'b1', 'claude:b'));
    const other = candidate(note('oc_9', 'build', '构建用 mvnd', 'o1', 'claude:c'));
    const lone = candidate(note('oc_9', 'misc', '无关的一条', 'x1', 'claude:c'));
    const plan = planPool({
      entries: [],
      candidates: [topicA, topicB, other, lone],
      themes: [{ candidates: [0, 1, 2], entries: [] }],
      now: NOW,
      timezone: TZ,
      reads: noReads,
    });
    // oc_1's two topics fold into one note of oc_1; oc_9's own stays in oc_9; both recurred.
    expect(plan.promote.map((item) => [item.scopeId, item.note])).toEqual([
      ['oc_1', 'build-tool'],
      ['oc_9', 'build'],
    ]);
    expect(plan.entries.map((entry) => entry.key)).toEqual(['x1']);
  });
});

describe('candidateOf / CandidatePool', () => {
  it('takes days and conversations from the source turns', () => {
    const addition = {
      ...note('oc_1', 'a', 't', 'h'),
      sources: [
        { ref: 'S1#1', sessionKey: 'claude:a', sessionRef: 'S1', index: 1, admin: false },
        { ref: 'S2#4', sessionKey: 'claude:b', sessionRef: 'S2', index: 4, admin: false },
      ],
    };
    const at = (key: string) => (key === 'claude:a' ? Date.parse('2026-10-25T10:00:00Z') : undefined);
    expect(candidateOf(addition, at, NOW, TZ)).toMatchObject({ days: ['2026-10-25', '2026-10-28'], sessions: ['claude:a', 'claude:b'] });
  });

  it('persists the plan it is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcb-pool-'));
    try {
      const pool = new CandidatePool(join(dir, 'pool.json'));
      await pool.load();
      expect(pool.entries()).toEqual([]);
      const plan = planPool({ entries: [], candidates: [candidate(note('oc_1', 'a', 't', 'h'))], now: NOW, timezone: TZ, reads: noReads });
      pool.replace(plan.entries);
      await pool.flush();
      const again = new CandidatePool(join(dir, 'pool.json'));
      await again.load();
      expect(again.entries().map((entry) => entry.key)).toEqual(['h']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
