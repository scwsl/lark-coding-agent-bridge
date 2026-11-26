import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { fallbackBrief } from '../../../src/card/owner-notify';
import { finalAnswerState, initialState, reduce, stripControlMarkers, type RunState } from '../../../src/card/run-state';
import { cleanTitle, stripTitleMarker, titleOf } from '../../../src/card/title-marker';

const done: AgentEvent = { type: 'done', terminationReason: 'normal' };
const run = (events: AgentEvent[]): RunState => events.reduce(reduce, initialState);
const tool = (id: string): AgentEvent[] => [
  { type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } },
  { type: 'tool_result', id, output: 'ok', isError: false },
];
const texts = (state: RunState): string[] => state.blocks.flatMap((b) => (b.kind === 'text' ? [b.content] : []));

describe('[[TITLE…]] marker', () => {
  it('reads the title the agent wrote, the last one winning', () => {
    expect(titleOf('[[TITLE: kick-off 验证范围]]\n张三，正文')).toBe('kick-off 验证范围');
    expect(titleOf('[[TITLE：全角冒号]]')).toBe('全角冒号');
    expect(titleOf('[[TITLE: 先]]\n正文\n[[TITLE: 后]]')).toBe('后');
    expect(titleOf('[[TITLE: [ANTELOPE-12] 回滚范围]]')).toBe('[ANTELOPE-12] 回滚范围');
    expect(titleOf('正文')).toBeUndefined();
    expect(titleOf('[[TITLE: ]]')).toBeUndefined();
  });

  it('cleans a title down to one plain line', () => {
    expect(cleanTitle('「kick-off 验证范围」')).toBe('kick-off 验证范围');
    expect(cleanTitle('**三区对比**。')).toBe('三区对比');
    expect(cleanTitle('  多个   空格 ')).toBe('多个 空格');
    const long = cleanTitle('三个生产区里只有 prod-us 有一个 pod 处于 Pending 状态');
    expect(long.length).toBeLessThanOrEqual(24);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/po…$/);
  });

  it('strips the line, also while it is still streaming in', () => {
    expect(stripTitleMarker('[[TITLE: 主题]]\n张三，正文')).toBe('张三，正文');
    expect(stripTitleMarker('正文 [[TITLE: 主题]]')).toBe('正文');
    expect(stripTitleMarker('[[TITLE: 验证', true)).toBe('');
    expect(stripTitleMarker('正文\n[[TI', true)).toBe('正文');
    expect(stripTitleMarker('[[TITLE: 验证', false)).toBe('[[TITLE: 验证');
  });

  it('is stripped with the other control markers and kept on the state as its title', () => {
    const state = stripControlMarkers(run([{ type: 'text', delta: '[[TITLE: 主题]]\n张三，正文' }, done]));
    expect(texts(state)).toEqual(['张三，正文']);
    expect(state.title).toBe('主题');
    expect(stripControlMarkers(run([{ type: 'text', delta: '正文' }, done])).title).toBeUndefined();
    // A titled [[NO_REPLY]] is still no reply.
    expect(texts(stripControlMarkers(run([{ type: 'text', delta: '[[TITLE: 主题]]\n[[NO_REPLY]]' }, done])))).toEqual([]);
  });

  it('keeps a title the agent wrote before its last tool call', () => {
    const state = run([{ type: 'text', delta: '[[TITLE: 早写的标题]]\n我先看一下。' }, ...tool('t1'), { type: 'text', delta: '正文' }, done]);
    const shown = stripControlMarkers(finalAnswerState(state));
    expect(texts(shown)).toEqual(['正文']);
    expect(shown.title).toBe('早写的标题');

    const later = run([{ type: 'text', delta: '[[TITLE: 早]]\n看一下' }, ...tool('t1'), { type: 'text', delta: '[[TITLE: 晚]]\n正文' }, done]);
    expect(stripControlMarkers(finalAnswerState(later)).title).toBe('晚');
  });

  it('is not taken for the owner brief', () => {
    expect(fallbackBrief('[[TITLE: 主题]]\n已回滚到 1.2.3')).toBe('已回滚到 1.2.3');
  });
});
