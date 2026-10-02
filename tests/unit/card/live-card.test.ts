import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { cardBytes, fitCardToBudget, fullText } from '../../../src/card/card-budget.js';
import { runningToolLabel } from '../../../src/card/run-activity.js';
import { formatAgo, formatClock, renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce(reduce, initialState);
}

function cardText(card: object): string {
  return JSON.stringify(card);
}

describe('running card footer clock', () => {
  it('shows elapsed time, time since the last event, and the running tool', () => {
    const state = stateFrom([
      {
        type: 'tool_use',
        id: 't1',
        name: 'Bash',
        input: { command: 'curl -u elastic:secret https://x', description: '查 bridge 日志' },
      },
    ]);
    const card = renderCard(state, {
      activity: { elapsedMs: 372_000, idleMs: 8_000, toolLabel: runningToolLabel(state) },
    });
    expect(cardText(card)).toContain('🧰 查 bridge 日志（Bash） · 已运行 6:12 · 上次动静 8 秒前');
  });

  it('turns into a warning once the agent has been quiet for minutes', () => {
    const card = renderCard(initialState, {
      activity: { elapsedMs: 600_000, idleMs: 300_000 },
    });
    expect(cardText(card)).toContain('⚠️ 🧠 正在思考 · 已运行 10:00 · 已 5 分钟没有新动静');
  });

  it('keeps the plain footer when no clock is given', () => {
    expect(cardText(renderCard(initialState))).toContain('"🧠 正在思考"');
  });

  it('formats durations', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(3_723_000)).toBe('1:02:03');
    expect(formatAgo(59_999)).toBe('59 秒前');
    expect(formatAgo(125_000)).toBe('2 分钟前');
  });
});

describe('runningToolLabel', () => {
  it('uses the agent-written description and never the raw command', () => {
    const state = stateFrom([
      {
        type: 'tool_use',
        id: 't1',
        name: 'Bash',
        input: { command: 'mysql -pS3cret', description: '查库' },
      },
    ]);
    expect(runningToolLabel(state)).toBe('查库（Bash）');

    const bare = stateFrom([
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'mysql -pS3cret' } },
    ]);
    expect(runningToolLabel(bare)).toBe('正在调用 Bash');
  });

  it('hides a description written in the wrong language', () => {
    const english = stateFrom([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', description: 'Probe the deny rule' } },
    ]);
    // A Chinese card never shows the English line…
    expect(runningToolLabel(english)).toBe('正在调用 Bash');
    // …while an English card does.
    expect(runningToolLabel(english, 'en')).toBe('Probe the deny rule (Bash)');
  });

  it('is empty once the tool has returned', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
    ]);
    expect(runningToolLabel(state)).toBeUndefined();
  });
});

describe('subagent progress in the footer', () => {
  const agentRun = (step: AgentEvent): RunState =>
    stateFrom([
      { type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: '升级依赖', prompt: 'x' } },
      step,
    ]);

  it('shows what the subagent is doing under the tool that started it', () => {
    const state = agentRun({
      type: 'subagent_activity',
      parentToolUseId: 'agent-1',
      tool: 'Bash',
      description: '运行全量构建',
      at: 1,
    });
    expect(state.blocks).toHaveLength(1);
    expect(runningToolLabel(state)).toBe('升级依赖（Agent） › 子任务：运行全量构建');
  });

  it('falls back to the tool name when the step description is in the wrong language', () => {
    const state = agentRun({
      type: 'subagent_activity',
      parentToolUseId: 'agent-1',
      tool: 'Bash',
      description: 'Run the full build',
      at: 1,
    });
    expect(runningToolLabel(state)).toBe('升级依赖（Agent） › 子任务：正在调用 Bash');
  });

  it('ignores activity from a subagent whose tool already returned', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: '升级依赖' } },
      { type: 'subagent_activity', parentToolUseId: 'agent-1', tool: 'Bash', description: '构建', at: 1 },
      { type: 'tool_result', id: 'agent-1', output: 'done', isError: false },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { description: '提交代码' } },
    ]);
    expect(runningToolLabel(state)).toBe('提交代码（Bash）');
  });
});

describe('stop button', () => {
  it('asks for confirmation before stopping', () => {
    const text = cardText(renderCard(initialState));
    expect(text).toContain('"confirm"');
    expect(text).toContain('终止这个任务？');
  });
});

describe('fitCardToBudget', () => {
  const render = (s: RunState): object => renderCard(s);

  it('leaves a card under the budget untouched', () => {
    const state = stateFrom([
      { type: 'text', delta: 'short answer' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const fitted = fitCardToBudget(state, render);
    expect(fitted.trimmed).toBe(false);
    expect(fitted.card).toEqual(renderCard(state));
  });

  it('cuts an oversized answer to its tail, under budget, with a pointer to the full text', () => {
    const body = Array.from({ length: 4000 }, (_, i) => `第${i}行内容`).join('\n');
    const state = stateFrom([
      { type: 'text', delta: `${body}\n结论在最后` },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(cardBytes(renderCard(state))).toBeGreaterThan(24_000);

    const fitted = fitCardToBudget(state, render, 24_000);
    expect(fitted.trimmed).toBe(true);
    expect(cardBytes(fitted.card)).toBeLessThanOrEqual(24_000);
    const text = cardText(fitted.card);
    expect(text).toContain('结论在最后');
    expect(text).toContain('完整内容见下一条消息');
    expect(text).not.toContain('第0行内容');
  });

  it('drops tool panels before cutting any text', () => {
    const huge = 'x'.repeat(30_000);
    const state = stateFrom([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat big' } },
      { type: 'tool_result', id: 't1', output: huge, isError: false },
      { type: 'text', delta: 'the answer' },
    ]);
    const fitted = fitCardToBudget(state, render, 24_000);
    expect(cardBytes(fitted.card)).toBeLessThanOrEqual(24_000);
    expect(cardText(fitted.card)).toContain('the answer');
  });

  it('fullText joins every text block of the run', () => {
    const state = stateFrom([
      { type: 'text', delta: 'one' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'text', delta: 'two' },
    ]);
    expect(fullText(state)).toBe('one\n\ntwo');
  });
});
