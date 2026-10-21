import { describe, expect, it } from 'vitest';
import { cronCard } from '../../../src/card/templates';

const texts = (card: object): Array<{ tag: string; content: string }> =>
  JSON.stringify(card).match(/\{"tag":"(plain_text|lark_md)","content":"(?:[^"\\]|\\.)*"\}/g)!.map((s) => JSON.parse(s));

describe('cronCard', () => {
  it('keeps the cron expression verbatim instead of letting markdown eat the asterisks', () => {
    const card = cronCard(
      [{ id: 'd55d1f', schedule: '每周六 06:00（0 6 * * 6）', status: '下次 2026-10-24 06:00', prompt: '跑 *collect.py*', enabled: true }],
      'hint',
    );
    const schedule = texts(card).find((t) => t.content.includes('0 6 * * 6'));
    expect(schedule?.tag).toBe('plain_text');
    expect(texts(card).find((t) => t.content.includes('collect.py'))).toEqual({ tag: 'plain_text', content: '跑 *collect.py*' });
  });
});
