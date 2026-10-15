import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeClaudeSession } from '../../../src/agent/claude/session-probe';
import { probeCodexSession } from '../../../src/agent/codex/session-probe';
import { buildAgentPrompt, extractUserInputText } from '../../../src/agent/prompt';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const bridgePrompt = (text: string) =>
  buildAgentPrompt({ context: { chatId: 'oc_x', chatType: 'p2p', senderId: 'ou_x', source: 'im' }, userInput: text });

describe('extractUserInputText', () => {
  it('returns the user words of a bridge prompt, without speaker labels', () => {
    expect(extractUserInputText(bridgePrompt('[李爽 (user)]: 看下这个问题'))).toBe('看下这个问题');
    expect(extractUserInputText('no sections')).toBeUndefined();
  });
});

describe('probeClaudeSession', () => {
  it('reads the last model call and the last request from the transcript tail', async () => {
    const config = await tmp('claude-config-');
    const project = join(config, 'projects', '-ws');
    await mkdir(project, { recursive: true });
    const lines = [
      { type: 'user', message: { content: bridgePrompt('第一个问题') }, timestamp: '2026-10-12T01:00:00.000Z' },
      {
        type: 'assistant',
        timestamp: '2026-10-12T01:00:05.000Z',
        message: { content: [], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } },
      },
      { type: 'user', message: { content: [{ type: 'text', text: bridgePrompt('第二个问题') }] }, timestamp: '2026-10-12T02:00:00.000Z' },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      {
        type: 'assistant',
        isSidechain: true,
        timestamp: '2026-10-12T02:00:09.000Z',
        message: { content: [], usage: { input_tokens: 1, cache_read_input_tokens: 5 } },
      },
      {
        type: 'assistant',
        timestamp: '2026-10-12T02:00:08.000Z',
        message: { content: [], usage: { input_tokens: 3, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 2_000 } },
      },
      { type: 'last-prompt', lastPrompt: 'x' },
    ];
    await writeFile(join(project, 'sess-1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

    const probe = await probeClaudeSession('sess-1', '/ws', { CLAUDE_CONFIG_DIR: config });

    expect(probe).toEqual({
      contextTokens: 402_003,
      lastActivityAt: Date.parse('2026-10-12T02:00:08.000Z'),
      lastUserText: '第二个问题',
    });
  });

  it('is undefined for a session without a transcript', async () => {
    const config = await tmp('claude-config-');
    expect(await probeClaudeSession('missing', '/ws', { CLAUDE_CONFIG_DIR: config })).toBeUndefined();
  });
});

describe('probeCodexSession', () => {
  it('reads the last token_count and the last user message from the rollout', async () => {
    const home = await tmp('codex-home-');
    const day = join(home, 'sessions', '2026', '10', '12');
    await mkdir(day, { recursive: true });
    const lines = [
      {
        timestamp: '2026-10-12T02:00:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: bridgePrompt('Codex 的问题') }] },
      },
      {
        timestamp: '2026-10-12T02:00:30.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 9_999_999 }, last_token_usage: { input_tokens: 220_553 } },
        },
      },
      { timestamp: '2026-10-12T02:00:31.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
    ];
    await writeFile(
      join(day, 'rollout-2026-10-12T02-00-00-thread-9.jsonl'),
      `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
    );

    expect(await probeCodexSession(home, 'thread-9')).toEqual({
      contextTokens: 220_553,
      lastActivityAt: Date.parse('2026-10-12T02:00:30.000Z'),
      lastUserText: 'Codex 的问题',
    });
  });
});
