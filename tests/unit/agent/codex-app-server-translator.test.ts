import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAppServerTranslator } from '../../../src/agent/codex/app-server-translator';
import type { AgentEvent } from '../../../src/agent/types';

/** Notifications captured from codex-cli 0.159.2 `app-server --listen stdio://`. */
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/codex-app-server-turns.json'), 'utf8'),
) as Record<'command_turn' | 'interrupted_turn', Array<{ method: string; params: Record<string, unknown> }>>;

function translate(turn: Array<{ method: string; params: Record<string, unknown> }>): AgentEvent[] {
  const t = new CodexAppServerTranslator('thread-1');
  return [...t.start(), ...turn.flatMap((n) => t.notification(n.method, n.params))];
}

describe('Codex app-server translator', () => {
  it('maps a real turn to the same events the exec translator produces', () => {
    const events = translate(fixture.command_turn).filter((e) => e.type !== 'thinking');
    expect(events[0]).toEqual({ type: 'system', threadId: 'thread-1' });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_use', name: 'command_execution', input: { command: "/bin/zsh -lc 'echo hi-from-shell'" } }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', output: 'hi-from-shell\n', isError: false }));
    expect(events.slice(-3)).toEqual([
      { type: 'final_text', content: 'one' },
      // Per-call usage summed over the turn (17340 + 17396 input).
      { type: 'usage', inputTokens: 34_736, cachedInputTokens: 33_280, outputTokens: 34, reasoningOutputTokens: 0 },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);
  });

  it('reports an interrupted turn as interrupted, keeping what was said as progress', () => {
    const events = translate(fixture.interrupted_turn);
    expect(events).toContainEqual({ type: 'text', delta: 'I’ll run the requested shell command.' });
    expect(events.filter((e) => e.type === 'final_text')).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'done', threadId: 'thread-1', terminationReason: 'interrupted' });
  });

  it('turns a failed turn into an error and ignores anything after the terminal event', () => {
    const t = new CodexAppServerTranslator('thread-1');
    expect(t.notification('error', { error: { message: 'rate limited' }, willRetry: false })).toEqual([]);
    expect(t.notification('turn/completed', { turn: { id: 'x', status: 'failed', error: null } })).toEqual([
      { type: 'error', message: 'rate limited', terminationReason: 'failed' },
    ]);
    expect(t.notification('item/completed', { item: { type: 'agentMessage', text: 'late' } })).toEqual([]);
    expect(t.done).toBe(true);
  });

  it('fails a turn cut off by the process going away', () => {
    const t = new CodexAppServerTranslator('thread-1');
    t.notification('item/completed', { item: { type: 'agentMessage', id: 'm', text: 'working on it' } });
    expect(t.fail('codex app-server exited with code 1')).toEqual([
      { type: 'text', delta: 'working on it' },
      { type: 'error', message: 'codex app-server exited with code 1', terminationReason: 'failed' },
    ]);
  });
});
