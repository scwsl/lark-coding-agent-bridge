import { describe, expect, it } from 'vitest';
import { initialState, stripControlMarkers, stripSessionMarker, type RunState } from '../../../src/card/run-state';

const withText = (content: string, streaming = false, extra: Partial<RunState> = {}): RunState => ({
  ...initialState,
  blocks: [{ kind: 'text', content, streaming }],
  ...extra,
});

describe('[[NEW_SESSION]] marker in the run state', () => {
  it('drops a trailing marker from the answer block and final text', () => {
    const state = stripSessionMarker(
      withText('都改好了。\n\n[[NEW_SESSION: 修好了面板]]', false, { finalText: '都改好了。\n[[NEW_SESSION]]' }),
    );
    expect(state.blocks).toEqual([{ kind: 'text', content: '都改好了。', streaming: false }]);
    expect(state.finalText).toBe('都改好了。');
  });

  it('hides a marker that is still streaming in', () => {
    expect(stripSessionMarker(withText('都改好了。\n[[NEW_SES', true)).blocks).toEqual([
      { kind: 'text', content: '都改好了。', streaming: true },
    ]);
  });

  it('removes a block that held only the marker', () => {
    const state: RunState = {
      ...initialState,
      blocks: [
        { kind: 'text', content: '答案', streaming: false },
        { kind: 'tool', tool: { id: 't1', name: 'Bash', input: {}, status: 'done' } },
        { kind: 'text', content: '[[NEW_SESSION]]', streaming: false },
      ],
    };
    expect(stripSessionMarker(state).blocks.map((b) => b.kind)).toEqual(['text', 'tool']);
  });

  it('leaves answers without the marker untouched', () => {
    const state = withText('普通回答 [[NEW_SESSION]] 在中间');
    expect(stripSessionMarker(state)).toBe(state);
  });

  it('strips both markers through stripControlMarkers', () => {
    expect(stripControlMarkers(withText('[[NO_REPLY]]')).blocks).toEqual([]);
    expect(stripControlMarkers(withText('好了\n[[NEW_SESSION]]')).blocks[0]).toMatchObject({ content: '好了' });
  });
});
