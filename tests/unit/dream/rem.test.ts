import { describe, expect, it } from 'vitest';
import type { PoolCandidate, PoolEntry } from '../../../src/dream/pool.js';
import type { MemoryAddition } from '../../../src/dream/proposal.js';
import { buildRemPrompt, parseRemOutput, remWorthRunning } from '../../../src/dream/rem.js';

function candidate(scopeId: string, text: string, session: string, day: string): PoolCandidate {
  const addition: MemoryAddition = {
    kind: 'add',
    scopeId,
    target: 'note',
    note: 'deploy',
    text,
    reason: 'r',
    sources: [],
    evidence: 'inferred',
    hash: `h-${text}`,
  };
  return { addition, days: [day], sessions: [session] };
}

const entry: PoolEntry = {
  key: 'p1',
  scopeId: 'oc_1',
  note: 'deploy',
  text: '发布大概要十分钟',
  reason: 'r',
  sources: [],
  hashes: ['p1'],
  firstAt: 0,
  lastAt: 0,
  days: ['2026-10-20'],
  sessions: ['claude:old'],
};

describe('REM', () => {
  const candidates = [
    candidate('oc_1', '上线流程耗时约 10 min', 'claude:a', '2026-10-28'),
    candidate('oc_1', `token ghp_${'z'.repeat(36)} 已经换过`, 'claude:a', '2026-10-28'),
  ];
  const built = buildRemPrompt({ candidates, pool: [entry], tonight: ['以后提交不带 AI 署名'] });

  it('runs only with a new candidate and something to compare it with', () => {
    expect(remWorthRunning(0, 5)).toBe(false);
    expect(remWorthRunning(1, 0)).toBe(false);
    expect(remWorthRunning(1, 1)).toBe(true);
    expect(remWorthRunning(2, 0)).toBe(true);
  });

  it('numbers candidates and pool entries, masks secrets', () => {
    expect(built.ids.get('T1')).toEqual({ candidate: 0 });
    expect(built.ids.get('P1')).toEqual({ entry: 'p1' });
    expect(built.prompt).toContain('<candidates>');
    expect(built.prompt).toContain('以后提交不带 AI 署名');
    expect(built.prompt).not.toContain('ghp_');
  });

  it('keeps known ids once each, themes of two or more, and counts recurrence', () => {
    const out = parseRemOutput(
      JSON.stringify({
        themes: [
          { title: '发布耗时', members: ['T1', 'P1', 'T1', 'X9'] },
          { title: '只剩一个', members: ['P1', 'T2'] },
          { title: '空', members: [] },
        ],
        narrative: '今晚主要在聊发布耗时。',
      }),
      built,
      { candidates, pool: [entry] },
    );
    expect(out).toEqual({
      themes: [
        { candidates: [0], entries: ['p1'] },
      ],
      recurring: 1,
      narrative: '今晚主要在聊发布耗时。',
    });
  });

  it('refuses malformed output and drops a narrative with a secret in it', () => {
    expect(parseRemOutput('没有 JSON', built, { candidates, pool: [entry] })).toEqual({ error: '输出里没有 JSON 对象' });
    expect(parseRemOutput('{"themes":3}', built, { candidates, pool: [entry] })).toEqual({ error: 'themes 不是数组' });
    expect(parseRemOutput(JSON.stringify({ narrative: `密码 password=hunter2hunter2` }), built, { candidates, pool: [entry] })).toEqual({
      themes: [],
      recurring: 0,
    });
  });
});
