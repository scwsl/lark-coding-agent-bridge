import { describe, expect, it } from 'vitest';
import { backgroundTurnState } from '../../../src/bot/channel';
import { stripNoReply, type RunState } from '../../../src/card/run-state';
import { renderText } from '../../../src/card/text-renderer';

const keepAll = (state: RunState): RunState => stripNoReply(state);
const done = { type: 'done', terminationReason: 'normal' } as const;

describe('background turn replies', () => {
  it('prefixes a background answer so it reads as a follow-up', () => {
    const state = backgroundTurnState({ kind: 'turn', events: [{ type: 'text', delta: 'build ok' }, done] }, keepAll);
    const text = renderText(state!);
    expect(text).toContain('后台任务');
    expect(text).toContain('build ok');
  });

  it('stays silent for a turn with only tool calls or a no-reply marker', () => {
    expect(
      backgroundTurnState(
        {
          kind: 'turn',
          events: [
            { type: 'tool_use', id: 't', name: 'Read', input: {} },
            { type: 'tool_result', id: 't', output: 'x', isError: false },
            done,
          ],
        },
        (state) => ({ ...keepAll(state), blocks: state.blocks.filter((b) => b.kind !== 'tool') }),
      ),
    ).toBeUndefined();
    expect(
      backgroundTurnState({ kind: 'turn', events: [{ type: 'text', delta: '[[NO_REPLY]]' }, done] }, keepAll),
    ).toBeUndefined();
  });

  it('always reports background work that was stopped at the cap', () => {
    const state = backgroundTurnState({ kind: 'stopped', reason: 'max-linger', afterMs: 30 * 60_000 }, keepAll);
    expect(renderText(state!)).toContain('30 分钟');
  });
});
