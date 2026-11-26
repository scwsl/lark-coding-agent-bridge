import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { finalCardText, hasTable, leadingHeading, needsHeader, renderFinalCard } from '../../../src/card/final-card';
import { finalAnswerState, initialState, reduce, stripControlMarkers, type RunState } from '../../../src/card/run-state';
import { getFinalCardPreference, type AppConfig } from '../../../src/config/schema';

const OPTS = { headerTemplate: 'violet' as const };
const done: AgentEvent = { type: 'done', terminationReason: 'normal' };
const run = (events: AgentEvent[]): RunState => events.reduce(reduce, initialState);
// What the channel hands over: the answer with its control markers stripped.
const answer = (text: string): RunState => stripControlMarkers(run([{ type: 'text', delta: text }, done]));

interface Card {
  config: { summary: { content: string }; streaming_mode?: boolean };
  header?: { template: string; title: { content: string }; icon?: unknown };
  body: { elements: Array<{ tag: string; content?: string; text_size?: string }> };
}
const render = (state: RunState, opts: Partial<Parameters<typeof renderFinalCard>[1]> = {}): Card =>
  renderFinalCard(state, { ...OPTS, ...opts }) as Card;

const TABLE = ['| 区域 | Pod 数 |', '|---|---|', '| prod-eur | 12 |'].join('\n');
const LONG = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 行`).join('\n');

describe('final card', () => {
  it('shows a short answer as bare text: no header, buttons, byline or streaming', () => {
    const card = render(answer('prod-eur 没有异常重启的 pod。'));
    expect(card.header).toBeUndefined();
    expect(card.config.streaming_mode).toBeUndefined();
    expect(card.body.elements).toEqual([{ tag: 'markdown', content: 'prod-eur 没有异常重启的 pod。' }]);
    expect(card.config.summary.content).toBe('prod-eur 没有异常重启的 pod。');
    const json = JSON.stringify(card);
    for (const absent of ['button', 'Agent:', 'Model:', 'Sponsor', 'Usage', 'hr']) expect(json).not.toContain(absent);
  });

  it('adds a header bar in the configured colour when the agent titles its answer', () => {
    const card = render(answer(`[[TITLE: 三个区 Pod 对比]]\n张三，prod-us 落后两个版本，其余正常。\n\n${TABLE}`), {
      headerTemplate: 'green',
    });
    expect(card.header).toEqual({ template: 'green', title: { tag: 'plain_text', content: '三个区 Pod 对比' } });
    // The marker line leaves the body; the answer opens as written.
    expect(card.body.elements[0]?.content?.startsWith('张三，prod-us 落后两个版本')).toBe(true);
    expect(JSON.stringify(card)).not.toContain('[[TITLE');
    expect(card.config.summary.content).toBe('三个区 Pod 对比');
  });

  it('shows no header bar for an untitled answer, however long: nothing is guessed off its opening', () => {
    // A group reply opens with whom it addresses; that is no title.
    expect(render(answer(`张文韬，kick-off 是写操作，先确认范围：\n${LONG}`)).header).toBeUndefined();
    expect(render(answer(`三个区的对比：\n\n${TABLE}`)).header).toBeUndefined();
    expect(render(answer(TABLE)).header).toBeUndefined();
  });

  it('puts the configured avatar in the header, and nowhere without one', () => {
    const icon = { tag: 'custom_icon', img_key: 'img_v3_avatar' };
    expect(render(answer(`[[TITLE: 主题]]\n${LONG}`), { headerIcon: 'img_v3_avatar' }).header?.icon).toEqual(icon);
    expect(render(answer(`[[TITLE: 主题]]\n${LONG}`)).header?.icon).toBeUndefined();
    expect(JSON.stringify(render(answer(LONG), { headerIcon: 'img_v3_avatar' }))).not.toContain('img_v3_avatar');
  });

  it('takes the title from the leading heading of a long answer and leaves it out of the body', () => {
    const card = render(answer(`## antelope 三区对比\n\n${TABLE}`));
    expect(card.header?.title.content).toBe('antelope 三区对比');
    expect(card.body.elements[0]?.content?.startsWith('| 区域')).toBe(true);
    // A short answer keeps its heading as markdown.
    expect(render(answer('## 结论\n\n都正常')).header).toBeUndefined();
    // A heading that repeats the agent's title is not shown twice.
    const both = render(answer(`[[TITLE: 三区对比]]\n## 三区对比\n\n正文`));
    expect(both.header?.title.content).toBe('三区对比');
    expect(both.body.elements[0]?.content).toBe('正文');
  });

  it('reads the leading heading', () => {
    expect(leadingHeading('## 三个生产区 Pod 与发布对比\n\n正文')).toEqual({ title: '三个生产区 Pod 与发布对比', rest: '正文' });
    expect(leadingHeading('\n# **加粗** 标题 #\n正文')?.title).toBe('加粗 标题');
    expect(leadingHeading('## 只有标题')).toBeUndefined();
    expect(leadingHeading('#### 四级不算\n正文')).toBeUndefined();
    expect(leadingHeading('张三，正文')).toBeUndefined();
  });

  it('decides on the header by the answer itself', () => {
    expect(needsHeader('一行')).toBe(false);
    expect(needsHeader(Array.from({ length: 6 }, () => 'x').join('\n\n'))).toBe(false);
    expect(needsHeader(LONG)).toBe(true);
    expect(hasTable(TABLE)).toBe(true);
    expect(hasTable('```\n|---|---|\n```')).toBe(false);
    expect(hasTable('a --- b')).toBe(false);
  });

  it('carries only the answer the run ends on, without the bridge notes', () => {
    const state = run([
      { type: 'text', delta: '我先看一下。' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'kubectl get pods' } },
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
      { type: 'account', label: 'b', switchedFrom: 'a' },
      { type: 'text', delta: '都正常。' },
      done,
    ]);
    const card = render(finalAnswerState(state));
    expect(card.body.elements).toEqual([{ tag: 'markdown', content: '都正常。' }]);
  });

  it('says how a run that did not finish ended in one small grey line', () => {
    const failed = render(run([{ type: 'text', delta: '查到一半' }, { type: 'error', message: `boom\n${'x'.repeat(500)}`, terminationReason: 'failed' }]));
    const note = failed.body.elements.at(-1)!;
    expect(note.text_size).toBe('notation');
    expect(note.content).toContain("<font color='grey'>");
    expect(note.content).toContain('boom');
    expect(note.content!.length).toBeLessThan(160);
    expect(note.content).not.toContain('\n');

    const stopped = render(run([{ type: 'done', terminationReason: 'interrupted' }]));
    expect(stopped.body.elements).toHaveLength(1);
    expect(stopped.body.elements[0]?.content).toContain('中断');

    const paused = render(run([{ type: 'rate_limit', blocked: true, limitType: 'five_hour', at: 1 }, done]));
    expect(paused.body.elements[0]?.content).not.toContain('\n');
  });

  it('adds the model footer only when asked', () => {
    expect(JSON.stringify(render(answer('ok')))).not.toContain('Opus');
    const card = render(answer('ok'), { footerModel: 'Opus 5.5' });
    expect(card.body.elements.at(-1)).toEqual({
      tag: 'markdown',
      content: "<font color='grey'>Opus 5.5</font>",
      text_size: 'notation',
    });
  });

  it('has nothing to send for an empty answer, and a plain-text fallback otherwise', () => {
    expect(renderFinalCard(run([done]), OPTS)).toBeUndefined();
    const failed = run([{ type: 'text', delta: '一半' }, { type: 'error', message: 'boom', terminationReason: 'failed' }]);
    expect(finalCardText(failed)).toContain('一半');
    expect(finalCardText(failed)).toContain('boom');
  });

  it('masks raw email addresses like every other card', () => {
    expect(JSON.stringify(render(answer('联系 someone@example.com')))).not.toContain('someone@example.com');
  });
});

describe('finalCard preference', () => {
  const cfg = (finalCard: unknown): AppConfig => ({ preferences: { finalCard } }) as unknown as AppConfig;

  it('defaults to a violet header, no icon and no footer', () => {
    expect(getFinalCardPreference(cfg(undefined))).toEqual({ headerTemplate: 'violet', footer: false });
  });

  it('takes the header icon image key, ignoring a blank one', () => {
    expect(getFinalCardPreference(cfg({ headerIcon: ' img_v3_x ' })).headerIcon).toBe('img_v3_x');
    expect(getFinalCardPreference(cfg({ headerIcon: '  ' })).headerIcon).toBeUndefined();
  });

  it('keeps a known colour and falls back on an unknown one', () => {
    expect(getFinalCardPreference(cfg({ headerTemplate: 'purple', footer: true }))).toEqual({
      headerTemplate: 'purple',
      footer: true,
    });
    expect(getFinalCardPreference(cfg({ headerTemplate: '#6A2BFF' })).headerTemplate).toBe('violet');
  });
});
