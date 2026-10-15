import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readClaudeTranscript } from '../../../src/agent/claude/session-transcript.js';
import { readCodexTranscript } from '../../../src/agent/codex/session-transcript.js';
import { buildAgentPrompt, parseBridgePromptRequest } from '../../../src/agent/prompt.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function prompt(text: string, sender: { id: string; name?: string; type?: 'user' | 'bot' } = { id: 'ou_admin', name: 'Boss' }): string {
  return buildAgentPrompt({
    context: {
      chatId: 'oc_1',
      chatType: 'p2p',
      senderId: sender.id,
      ...(sender.name ? { senderName: sender.name } : {}),
      ...(sender.type ? { senderType: sender.type } : {}),
      source: 'im',
    },
    knowledge: { profileMemory: ['ignored'], chatMemory: [], skills: [] },
    chatContext: {
      scope: 'group',
      window: 'recent',
      messages: [{ messageId: 'om_x', senderId: 'ou_other', rawContentType: 'text', content: 'background chatter' }],
    },
    userInput: text,
  } as Parameters<typeof buildAgentPrompt>[0]);
}

describe('parseBridgePromptRequest', () => {
  it('returns the request text and its sender, leaving injected context out', () => {
    const parsed = parseBridgePromptRequest(prompt('以后部署前先跑 ci', { id: 'ou_admin', name: 'Boss', type: 'user' }));
    expect(parsed).toEqual({ text: '以后部署前先跑 ci', senderId: 'ou_admin', senderName: 'Boss', senderType: 'user', mixedSenders: false });
  });

  it('marks merged batches with several speakers or a bot as mixed', () => {
    expect(parseBridgePromptRequest(prompt('[A (user)]: 一\n[B (user)]: 二'))?.mixedSenders).toBe(true);
    expect(parseBridgePromptRequest(prompt('[A (user)]: 一\n[Poki (bot)]: 二'))?.mixedSenders).toBe(true);
    expect(parseBridgePromptRequest(prompt('[A (user)]: 一\n[A (user)]: 二'))).toMatchObject({ text: '一\n二', mixedSenders: false });
  });

  it('reads the context block of the request, not an example in an inline system prompt (Codex)', () => {
    const inline = '说明：每条消息顶部会带一个块：\n<bridge_context>\n{"chatId":"oc_xxx", ...}\n</bridge_context>\n\n';
    expect(parseBridgePromptRequest(inline + prompt('问题', { id: 'ou_real', type: 'user' }))).toMatchObject({
      text: '问题',
      senderId: 'ou_real',
    });
  });

  it('ignores prompts without a user_input section', () => {
    expect(parseBridgePromptRequest('plain tool result')).toBeUndefined();
  });
});

describe('readClaudeTranscript', () => {
  it('pairs chat requests with final answers and skips tools, sidechains and non-chat records', async () => {
    const config = await tmp('claude-config-');
    const cwd = '/Users/me/.bridge/default';
    const project = join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    await mkdir(project, { recursive: true });
    const lines = [
      { type: 'user', timestamp: '2026-10-13T01:00:00.000Z', message: { content: prompt('问题一') } },
      { type: 'assistant', timestamp: '2026-10-13T01:00:01.000Z', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'Bash' }] } },
      { type: 'user', timestamp: '2026-10-13T01:00:02.000Z', message: { content: [{ type: 'tool_result', content: 'output' }] } },
      { type: 'assistant', isSidechain: true, timestamp: '2026-10-13T01:00:03.000Z', message: { content: [{ type: 'text', text: 'sub agent' }] } },
      { type: 'assistant', timestamp: '2026-10-13T01:00:04.000Z', message: { content: [{ type: 'text', text: '答案一' }] } },
      { type: 'user', timestamp: '2026-10-13T02:00:00.000Z', message: { content: [{ type: 'text', text: prompt('问题二') }] } },
      { type: 'assistant', timestamp: '2026-10-13T02:00:05.000Z', message: { content: [{ type: 'text', text: '答案二' }] } },
      { type: 'queue-operation', timestamp: '2026-10-13T03:00:00.000Z' },
    ];
    await writeFile(join(project, 'sess-1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`);

    const transcript = await readClaudeTranscript('sess-1', cwd, { CLAUDE_CONFIG_DIR: config });
    expect(transcript?.exchanges).toMatchObject([
      { index: 1, user: '问题一', assistant: '答案一', senderId: 'ou_admin', at: Date.parse('2026-10-13T01:00:00.000Z') },
      { index: 2, user: '问题二', assistant: '答案二' },
    ]);
    expect(transcript?.lastActivityAt).toBe(Date.parse('2026-10-13T02:00:05.000Z'));
  });

  it('returns undefined for a missing transcript or an unsafe id', async () => {
    const config = await tmp('claude-config-');
    expect(await readClaudeTranscript('nope', '/x', { CLAUDE_CONFIG_DIR: config })).toBeUndefined();
    expect(await readClaudeTranscript('../etc', '/x', { CLAUDE_CONFIG_DIR: config })).toBeUndefined();
  });
});

describe('readCodexTranscript', () => {
  it('keeps final answers only and reads exactly the thread it is given', async () => {
    const home = await tmp('codex-home-');
    const day = join(home, 'sessions', '2026', '10', '13');
    await mkdir(day, { recursive: true });
    const item = (role: string, kind: string, text: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        timestamp: '2026-10-13T01:00:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role, content: [{ type: kind, text }], ...extra },
      });
    await writeFile(
      join(day, 'rollout-2026-10-13T01-00-00-thread-1.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } }),
        item('developer', 'input_text', 'system stuff'),
        item('user', 'input_text', '<environment_context>cwd</environment_context>'),
        item('user', 'input_text', prompt('codex 问题')),
        item('assistant', 'output_text', '我先看一下', { phase: 'commentary' }),
        JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }),
        item('assistant', 'output_text', 'codex 答案', { phase: 'final_answer' }),
      ].join('\n'),
    );
    await writeFile(join(day, 'rollout-2026-10-13T01-00-00-thread-2.jsonl'), item('user', 'input_text', prompt('别的线程')));

    const transcript = await readCodexTranscript(home, 'thread-1');
    expect(transcript?.exchanges).toEqual([
      expect.objectContaining({ index: 1, user: 'codex 问题', assistant: 'codex 答案', mixedSenders: false }),
    ]);
    expect(await readCodexTranscript(home, 'thread/../x')).toBeUndefined();
    expect(await readCodexTranscript(home, 'missing')).toBeUndefined();
  });
});
