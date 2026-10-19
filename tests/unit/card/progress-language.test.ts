import { describe, expect, it } from 'vitest';
import { isOffLocaleProse, withoutOffLocaleProgress } from '../../../src/card/progress-language';
import { initialState, reduce, type RunState } from '../../../src/card/run-state';

function run(...steps: Array<{ text: string } | { tool: string } | 'done'>): RunState {
  let state = initialState;
  steps.forEach((step, i) => {
    if (step === 'done') {
      state = reduce(state, { type: 'done' } as never);
    } else if ('text' in step) {
      state = reduce(state, { type: 'text', delta: step.text });
    } else {
      state = reduce(state, { type: 'tool_use', id: `t${i}`, name: step.tool, input: {} } as never);
    }
  });
  return state;
}

const texts = (s: RunState) => s.blocks.filter((b) => b.kind === 'text').map((b) => (b as { content: string }).content);

describe('isOffLocaleProse', () => {
  it.each([
    'Now edit the generator to add status columns.',
    'Use Python\'s `os.setsid()` double fork to detach and start it:',
    'Finally, update the supplement memory:',
  ])('flags English prose %j', (text) => {
    expect(isOffLocaleProse(text)).toBe(true);
  });

  it.each([
    '现在去改生成器，加上状态列。',
    '用 Python 的 `os.setsid()` 脱离进程启动：',
    '```bash\npnpm test\n```',
    '`src/bot/channel.ts`',
    'OK',
  ])('keeps %j', (text) => {
    expect(isOffLocaleProse(text)).toBe(false);
  });
});

describe('withoutOffLocaleProgress', () => {
  it('hides English progress notes between tool calls in a Chinese conversation', () => {
    const state = run({ text: 'Now edit the generator.' }, { tool: 'Bash' }, { text: '改好了。' }, 'done');
    expect(texts(withoutOffLocaleProgress(state, 'zh'))).toEqual(['改好了。']);
  });

  it('hides English text while the run is still going, even as the last block', () => {
    const state = run({ text: '先看代码。' }, { tool: 'Read' }, { text: 'Now edit the generator.' });
    expect(texts(withoutOffLocaleProgress(state, 'zh'))).toEqual(['先看代码。']);
  });

  it('always shows the answer a finished run ends on', () => {
    const state = run({ text: 'Checking the logs.' }, { tool: 'Bash' }, { text: 'All tests passed.' }, 'done');
    expect(texts(withoutOffLocaleProgress(state, 'zh'))).toEqual(['All tests passed.']);
  });

  it('leaves English conversations alone', () => {
    const state = run({ text: 'Now edit the generator.' }, { tool: 'Bash' });
    expect(withoutOffLocaleProgress(state, 'en')).toBe(state);
  });

  it('returns the same state when nothing is hidden', () => {
    const state = run({ text: '先看代码。' }, { tool: 'Read' });
    expect(withoutOffLocaleProgress(state, 'zh')).toBe(state);
  });
});
