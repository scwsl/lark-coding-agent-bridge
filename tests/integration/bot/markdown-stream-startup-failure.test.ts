import { LarkChannelError, type NormalizedMessage } from '@larksuite/channel';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { AutoResumer } from '../../../src/bot/auto-resume.js';
import type { FakeAgentEvents, FakeBackgroundTurn } from '../../helpers/fake-agent.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  updated: Array<{ messageId: string; card: unknown }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
  updateCard: ReturnType<typeof vi.fn>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];
type SendFn = FakeLarkChannel['send'];
type UpdateCardFn = (messageId: string, card: object) => Promise<void>;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('markdown stream startup failures', () => {
  it('does not leave the IM queue blocked when the agent exits before stream producer starts', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', '第一条'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', '第二条'));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_first', reaction_id: 'reaction_1' },
      }),
    );
    expect(lastMarkdown(h.channel)).toContain('agent 失败');
    expect(lastMarkdown(h.channel)).toContain('codex exited with code 1');
  });

  it('does not wait for the working reaction before draining a failed agent run', async () => {
    const reaction = deferred<{ data: { reaction_id: string } }>();
    const h = await createHarness({
      reactionCreate: () => reaction.promise,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', '第一条'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', '第二条'));
    await waitFor(() => h.agent.runOptions.length === 2, 1000);

    expect(lastMarkdown(h.channel)).toContain('agent 失败');

    reaction.resolve({ data: { reaction_id: 'reaction_1' } });
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
  });

  it('logs stream failures that arrive after terminal grace expires', async () => {
    const streamFailure = deferred<void>();
    let streamProducerStarted = false;
    const h = await createHarness({
      // The first run has to stream something, or no progress stream is opened
      // at all and there is no late failure to log.
      events: [
        [
          { type: 'text', delta: '进度更新' },
          {
            type: 'error',
            message: 'codex exited with code 1: Error loading config.toml',
            terminationReason: 'failed',
          },
        ],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          streamProducerStarted = true;
          void producer({ setContent: vi.fn(async () => {}) });
        }
        await streamFailure.promise;
      },
    });
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', '第一条'));
    await waitFor(() => streamProducerStarted);
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      4500,
    );

    await h.channel.handlers.message?.(message('om_second', '第二条'));
    await waitFor(() => h.agent.runOptions.length === 2);

    streamFailure.reject(new Error('late stream failed'));

    await waitFor(() =>
      fail.mock.calls.some((call) =>
        call[0] === 'stream' &&
        call[1] instanceof Error &&
        call[1].message === 'late stream failed' &&
        (call[2] as { step?: string } | undefined)?.step === 'stream-terminal-late',
      ),
    );
  }, 10_000);

  it('sends one dedicated non-streaming final reply after progress completes', async () => {
    const visibleProgress: string[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: '进度更新' },
        { type: 'final_text', content: 'FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final', '跑一下'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(visibleProgress.some((markdown) => markdown.includes('进度更新'))).toBe(true);
    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('FINAL_SENTINEL');
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_final' });

    // A successful run marks the triggering question itself as answered,
    // alongside (not instead of) the Typing reaction's own add/remove cycle.
    await waitFor(() => reactionTypesAdded(h.channel).includes('DONE'));
  });

  it('posts a background turn as a follow-up reply to the same message', async () => {
    const streamed: string[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        { type: 'system', sessionId: 'sess-bg' },
        { type: 'background', count: 1 },
        { type: 'text', delta: 'BUILD_STARTED' },
        { type: 'done', sessionId: 'sess-bg', terminationReason: 'normal' },
      ],
      background: {
        afterMs: 50,
        events: [
          { type: 'background', count: 0 },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/out' } },
          { type: 'tool_result', id: 't1', output: 'ok', isError: false },
          { type: 'text', delta: 'BUILD_OK' },
          { type: 'done', sessionId: 'sess-bg', terminationReason: 'normal' },
        ],
      },
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            streamed.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_bg', 'build it'));
    await waitFor(() => h.channel.sent.length === 1);

    // Claude streams its answer; the background turn arrives later as its own reply.
    expect(streamed.some((markdown) => markdown.includes('BUILD_STARTED'))).toBe(true);
    const followUp = lastMarkdown(h.channel);
    expect(followUp).toContain('BUILD_OK');
    expect(followUp).toContain('后台任务');
    expect(followUp).not.toContain('BUILD_STARTED');
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_bg' });
    // The background turn ran to completion; nothing was killed.
    expect(h.agent.runs[0]?.stopped).toBe(false);
  });

  it('processes messages a previous process left queued, and reports ones too old to act on', async () => {
    const streamed: string[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      events: [{ type: 'text', delta: 'LEFTOVER_ANSWERED' }, { type: 'done', terminationReason: 'normal' }],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async (markdown: string) => void streamed.push(markdown)) });
      },
    });
    const appPaths = testAppPaths(h.tmp);
    const stale = { ...message('om_old', 'stale question'), chatId: 'oc_other' };
    await writeFile(
      appPaths.pendingFile,
      JSON.stringify({
        oc_dm: { scope: 'oc_dm', queuedAt: Date.now() - 60_000, messages: [message('om_left', 'leftover question')] },
        oc_other: { scope: 'oc_other', queuedAt: Date.now() - 60 * 60_000, messages: [stale] },
      }),
    );
    await startTestBridge(h, appPaths);

    await waitFor(() => h.agent.runOptions.length === 1 && streamed.some((m) => m.includes('LEFTOVER_ANSWERED')));
    expect(h.agent.runOptions[0]?.prompt).toContain('leftover question');
    await waitFor(() => h.channel.sent.some((m) => m.chatId === 'oc_other'));
    const notice = h.channel.sent.find((m) => m.chatId === 'oc_other');
    expect(JSON.stringify(notice?.content)).toContain('没来得及处理');
    expect(notice?.options).toMatchObject({ replyTo: 'om_old' });
    expect(h.agent.runOptions.some((o) => o.prompt.includes('stale question'))).toBe(false);
  });

  it('with approvals on, gates runs a non-admin drives, and only those', async () => {
    const h = await createHarness({
      agentKind: 'claude',
      // Claude opens its progress card at run start; let that stream settle so
      // the scope frees up for the second message.
      stream: async () => {},
      events: [
        [{ type: 'done', terminationReason: 'normal' }],
        [{ type: 'done', terminationReason: 'normal' }],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
    });
    h.profileConfig.approvals.enabled = true;
    await startTestBridge(h, testAppPaths(h.tmp));

    await h.channel.handlers.message?.(message('om_user', 'please deploy'));
    await waitFor(() => h.agent.runOptions.length === 1);
    // A non-admin: the run carries an approval channel, with the Claude hook.
    expect(h.agent.runOptions[0]?.approvals?.hookCommand).toContain('approval-hook.mjs');

    h.profileConfig.access.admins = ['ou_user'];
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.channel.handlers.message?.(message('om_admin', 'now as admin'));
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.approvals).toBeUndefined();
  });

  it('runs non-admins ungated by default, with approvals off', async () => {
    const h = await createHarness({
      agentKind: 'claude',
      events: [[{ type: 'done', terminationReason: 'normal' }]],
    });
    await startTestBridge(h, testAppPaths(h.tmp));

    await h.channel.handlers.message?.(message('om_user', 'please deploy'));
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]?.approvals).toBeUndefined();
  });

  it('opens no progress stream for a final-only round', async () => {
    // The regression this guards: Codex answering without any commentary. The
    // SDK sends its streaming card as soon as `stream()` is called and finishes
    // an empty one with "(no content)", so the user saw that placeholder for a
    // few seconds, watched it get recalled, and only then got the answer.
    const streamCalls: unknown[] = [];
    const h = await createHarness({
      events: [
        { type: 'final_text', content: 'FINAL_ONLY_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        streamCalls.push(input);
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final_only', '跑一下'));
    await waitFor(() => h.channel.sent.length === 1);
    // give a stray stream / recall a chance to fire before asserting
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(streamCalls).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('FINAL_ONLY_SENTINEL');
  });

  it('opens the Claude progress stream before any visible output', async () => {
    // Claude runs often start with tool calls, which are hidden when
    // showToolCalls is off. The progress message (with its stop button) must
    // appear right away instead of after the first sentence.
    const streamCalls: unknown[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        // Nothing visible at all: only hidden tool calls. The lazy rule would
        // never open a stream for this run.
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 1' } },
        { type: 'tool_result', id: 'toolu_1', output: '', isError: false },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        streamCalls.push(input);
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
      },
    });
    h.profileConfig.preferences.showToolCalls = false;
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_eager', '跑一下'));
    await waitFor(() => streamCalls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(streamCalls).toHaveLength(1);
  });

  it('does not repeat streamed text as the final reply when Codex held nothing back', async () => {
    // Codex only reserves its *last* message as `final_text`; an abnormal turn
    // end (turn.failed, or the process dying before turn.completed) flushes it
    // as a text block instead. Those blocks are already on screen, so the
    // dedicated final reply must not post the same words a second time.
    const visibleProgress: string[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: '这是答案' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_no_final', '跑一下'));
    await waitFor(() => visibleProgress.some((markdown) => markdown.includes('这是答案')));
    // give a (duplicate) final reply a chance to fire before asserting
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.sent).toHaveLength(0);
  });

  it('waits for a slow-opening progress stream instead of replying alongside it', async () => {
    // Opening a streaming card costs two API round trips. When the run finishes
    // first, replying right away duplicates the answer verbatim — once as text,
    // once as the card that lands a moment later.
    const visibleProgress: string[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        { type: 'text', delta: 'ANSWER_ONCE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_slow_stream', '跑一下'));
    await waitFor(() => visibleProgress.some((markdown) => markdown.includes('ANSWER_ONCE')));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.sent).toHaveLength(0);
  });

  it('renders nothing in a progress stream it already gave up on', async () => {
    // If the stream is still not producing after the grace window we do reply
    // without it — but the stream must then stay empty, or the answer shows up
    // twice as soon as it catches up.
    const gate = deferred<void>();
    const setContent = vi.fn(async () => {});
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        { type: 'text', delta: 'ANSWER_ONCE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await gate.promise;
        await producer?.({ setContent });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stuck_stream', '跑一下'));
    await waitFor(() => h.channel.sent.length === 1, 6000);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(lastMarkdown(h.channel)).toContain('ANSWER_ONCE');
    expect(h.channel.sent).toHaveLength(1);
    expect(setContent).not.toHaveBeenCalled();
  }, 15_000);

  it('still sends the final reply when the progress stream fails at completion', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const h = await createHarness({
      events: [
        { type: 'text', delta: '进度更新' },
        { type: 'final_text', content: 'FINAL_AFTER_STREAM_FAILURE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
        throw new Error('progress stream failed');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stream_fail', '跑一下'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(lastMarkdown(h.channel)).toContain('FINAL_AFTER_STREAM_FAILURE');
    expect(
      fail.mock.calls.some(
        (call) =>
          call[0] === 'stream' &&
          call[1] instanceof Error &&
          call[1].message === 'progress stream failed' &&
          (call[2] as { step?: string } | undefined)?.step === 'progress-stream',
      ),
    ).toBe(true);
  });

  it('does not record delivery when the final send has no message receipt', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await createHarness({
      events: [
        { type: 'final_text', content: 'FINAL_WITHOUT_RECEIPT' },
        { type: 'done', terminationReason: 'normal' },
      ],
      send: async () => ({ messageId: '' }),
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_no_receipt', '跑一下'));
    await waitFor(() =>
      fail.mock.calls.some(
        (call) => call[1] instanceof Error && call[1].message.includes('missing message receipt'),
      ),
    );

    expect(
      info.mock.calls.some((call) => call[0] === 'outbound' && call[1] === 'sent'),
    ).toBe(false);
  });

  it('posts the answer as a message when Feishu keeps rejecting the card', async () => {
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'ANSWER_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: sdkLikeCardStream(async () => {
        throw Object.assign(new Error('Request failed with status code 400'), {
          response: { data: { code: 230099 } },
        });
      }),
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card_broken', '跑一下'));
    await waitFor(() => JSON.stringify(h.channel.sent).includes('ANSWER_SENTINEL'));

    const sent = h.channel.sent.map((m) => JSON.stringify(m.content));
    // The user is told the card is stuck while the run goes on…
    expect(sent.some((m) => m.includes('进度卡片更新不了了') && m.includes('230099'))).toBe(true);
    // …and the answer arrives as an ordinary message instead of being lost.
    expect(lastMarkdown(h.channel)).toBe('ANSWER_SENTINEL');
    // The frozen card is turned into a pointer at that message.
    const pointer = JSON.stringify(h.channel.updateCard.mock.calls.at(-1));
    expect(pointer).toContain('om_card_msg');
    expect(pointer).toContain('完整回复见下一条消息');
  });

  it('sends the full answer separately when it outgrows the card', async () => {
    const cards: unknown[] = [];
    const long = `${'很长的分析内容。'.repeat(2500)}END_SENTINEL`;
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      events: [
        { type: 'text', delta: long },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: sdkLikeCardStream(async (card) => {
        cards.push(card);
      }),
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card_long', '跑一下'));
    await waitFor(() => h.channel.sent.length > 0);

    const finalCard = cards.at(-1) as object;
    expect(Buffer.byteLength(JSON.stringify(finalCard))).toBeLessThanOrEqual(24_000);
    expect(JSON.stringify(finalCard)).toContain('完整内容见下一条消息');
    expect(lastMarkdown(h.channel)).toBe(long);
    expect(h.channel.updateCard).not.toHaveBeenCalled();
  });

  it('pauses on the plan quota and resumes in a new card once it resets', async () => {
    const resetsAt = Date.now() + 3_600_000;
    const streams: Array<{ cards: unknown[]; messageId: string }> = [];
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      events: [
        [
          { type: 'text', delta: 'STEP_ONE_DONE' },
          { type: 'rate_limit', blocked: false, limitType: 'five_hour', resetsAt, at: Date.now() },
          { type: 'rate_limit', blocked: true, message: "You've hit your limit", at: Date.now() },
          { type: 'done', terminationReason: 'normal' },
        ],
        [
          { type: 'text', delta: 'FINISHED_THE_REST' },
          { type: 'done', terminationReason: 'normal' },
        ],
      ],
      stream: async (_chatId, input) => {
        const record = { cards: [] as unknown[], messageId: `om_card_${streams.length + 1}` };
        streams.push(record);
        await sdkLikeCardStream(async (card) => {
          record.cards.push(card);
        }, record.messageId)(_chatId, input);
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_task', '做这个长任务'));
    await waitFor(() => h.controls.autoResumer?.get('oc_dm') !== undefined);

    // The original card says why it stopped and when it goes on.
    const pausedCard = JSON.stringify(streams[0]?.cards.at(-1));
    expect(pausedCard).toContain('STEP_ONE_DONE');
    expect(pausedCard).toContain('任务暂停');
    expect(pausedCard).toContain('5 小时额度已用完');
    expect(pausedCard).toContain('自动继续');
    const resume = h.controls.autoResumer!.get('oc_dm')!;
    expect(resume.resumeAt).toBe(resetsAt + 60_000);
    expect(resume).toMatchObject({ originMessageId: 'om_task', cardMessageId: 'om_card_1' });

    // Nothing happens before the reset…
    await h.controls.autoResumer!.tick(resetsAt);
    expect(h.agent.runs).toHaveLength(1);

    // …and once it is due, the task goes on in a new card under the same question.
    await h.controls.autoResumer!.tick(resetsAt + 60_000);
    await waitFor(() => JSON.stringify(streams[1]?.cards ?? []).includes('FINISHED_THE_REST'));
    expect(h.agent.runs).toHaveLength(2);
    expect(h.agent.runs[1]?.opts.prompt).toContain('[自动续跑]');
    expect(streams[1]?.messageId).toBe('om_card_2');
    // The paused card is updated to point at the new one.
    const note = JSON.stringify(h.channel.updateCard.mock.calls.at(-1));
    expect(note).toContain('om_card_1');
    expect(note).toContain('自动继续');
    // A run that got through clears any resume left for this chat.
    await waitFor(() => h.controls.autoResumer?.get('oc_dm') === undefined);
  });

  it("resumes the owner's task from its ledger after the run is killed", async () => {
    const streams: Array<{ cards: unknown[] }> = [];
    const killed: AgentEvent[] = [
      { type: 'text', delta: '开始升级。\n📒 任务台账：/tmp/thinghub-ledger.md\n先跑构建' },
      { type: 'error', message: 'claude exited with code 143', terminationReason: 'failed' },
    ];
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      events: [killed, [{ type: 'text', delta: 'RESUMED_SENTINEL' }, { type: 'done', terminationReason: 'normal' }]],
      stream: async (_chatId, input) => {
        const record = { cards: [] as unknown[] };
        streams.push(record);
        await sdkLikeCardStream(async (card) => {
          record.cards.push(card);
        })(_chatId, input);
      },
    });
    Object.assign(h.controls, { botOwnerId: 'ou_user', ownerRefreshState: 'ok' });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_long_task', '升级依赖'));
    await waitFor(() => h.controls.autoResumer?.get('oc_dm') !== undefined);

    const resume = h.controls.autoResumer!.get('oc_dm')!;
    expect(resume).toMatchObject({ kind: 'interrupted', ledger: '/tmp/thinghub-ledger.md', reason: 'killed' });
    await waitFor(() => JSON.stringify(h.channel.sent).includes('按任务台账自动继续'));

    await h.controls.autoResumer!.tick(resume.resumeAt);
    await waitFor(() => JSON.stringify(streams[1]?.cards ?? []).includes('RESUMED_SENTINEL'));
    expect(h.agent.runs[1]?.opts.prompt).toContain('/tmp/thinghub-ledger.md');
    expect(h.agent.runs[1]?.opts.prompt).toContain('进程被终止');
  });

  it("does not resume someone else's killed task on its own", async () => {
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      events: [
        [
          { type: 'text', delta: '📒 任务台账：/tmp/other-ledger.md' },
          { type: 'error', message: 'claude exited with code 143', terminationReason: 'failed' },
        ],
      ],
      stream: sdkLikeCardStream(async () => {}),
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_guest_task', '帮我跑个长任务'));
    await waitFor(() => h.agent.runs.length === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.controls.autoResumer?.get('oc_dm')).toBeUndefined();
  });

  it('sends one dedicated final reply card after progress completes in card mode', async () => {
    const progressCards: unknown[] = [];
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: '进度更新' },
        { type: 'final_text', content: 'FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await producer?.({
          update: vi.fn(async (next: unknown) => {
            progressCards.push(next);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card_final', '跑一下'));
    await waitFor(() => h.channel.sent.length === 1);

    // Intermediate agent messages stream as progress; the final answer never
    // leaks into the progress card (it is held back for the dedicated reply).
    const progressJson = JSON.stringify(progressCards);
    expect(progressJson).toContain('进度更新');
    expect(progressJson).not.toContain('FINAL_SENTINEL');

    // The terminal answer arrives as exactly one non-streaming card send.
    expect(h.channel.sent).toHaveLength(1);
    const finalJson = JSON.stringify(h.channel.sent[0]?.content);
    expect(finalJson).toContain('FINAL_SENTINEL');
    expect(finalJson).not.toContain('进度更新');
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_card_final' });

    // Card mode gets both reactions now: Typing as an instant ack (the card's
    // own footer only shows *inside* the card, not in the bare message list),
    // and DONE once the run succeeds.
    await waitFor(() => reactionTypesAdded(h.channel).includes('Typing'));
    await waitFor(() => reactionTypesAdded(h.channel).includes('DONE'));
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
  });
  describe('when a streamed card cannot take its final update', () => {
    // Feishu rejected the finished card of long Claude runs (230099: too many
    // tables / card content). The stream had already shown part of the run, so
    // nothing re-sent the answer and the card stayed stuck mid-run.
    const cardLimit = () => new Error('Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit');
    const runEvents = (): AgentEvent[] => [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat report.md' } },
      { type: 'tool_result', id: 't1', output: 'TOOL_OUTPUT_SENTINEL', isError: false },
      { type: 'text', delta: 'ANSWER_SENTINEL' },
      { type: 'done', terminationReason: 'normal' },
    ];
    const failingFinalStream: StreamFn = async (_chatId, input) => {
      const producer = (input as {
        card?: { producer?: (ctrl: { update(next: unknown): Promise<void>; messageId: string }) => Promise<void> };
      }).card?.producer;
      await producer?.({ update: vi.fn(async () => {}), messageId: 'om_stream_card' });
      throw cardLimit();
    };

    it('replaces the stuck card with the answer alone', async () => {
      vi.spyOn(log, 'fail').mockImplementation(() => {});
      const h = await createHarness({
        agentKind: 'claude',
        messageReply: 'card',
        events: runEvents(),
        stream: failingFinalStream,
      });
      await startTestBridge(h);

      await h.channel.handlers.message?.(message('om_card_limit', 'run'));
      await waitFor(() => h.channel.updated.length === 1);

      expect(h.channel.updated[0]?.messageId).toBe('om_stream_card');
      const card = JSON.stringify(h.channel.updated[0]?.card);
      expect(card).toContain('ANSWER_SENTINEL');
      expect(card).not.toContain('TOOL_OUTPUT_SENTINEL');
      expect(card).toContain('"streaming_mode":false');
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(h.channel.sent).toHaveLength(0);
    });

    it('sends the answer as a new card when the stuck card cannot be updated', async () => {
      vi.spyOn(log, 'fail').mockImplementation(() => {});
      const h = await createHarness({
        agentKind: 'claude',
        messageReply: 'card',
        events: runEvents(),
        stream: failingFinalStream,
        updateCard: async () => {
          throw cardLimit();
        },
      });
      await startTestBridge(h);

      await h.channel.handlers.message?.(message('om_card_limit_new', 'run'));
      await waitFor(() => h.channel.sent.length === 1);

      const content = h.channel.sent[0]?.content as { card?: unknown };
      expect(JSON.stringify(content.card)).toContain('ANSWER_SENTINEL');
      expect(JSON.stringify(content.card)).not.toContain('TOOL_OUTPUT_SENTINEL');
      expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_card_limit_new' });
    });

    it('falls back to a plain post when no card is accepted', async () => {
      vi.spyOn(log, 'fail').mockImplementation(() => {});
      const h = await createHarness({
        agentKind: 'claude',
        messageReply: 'card',
        events: runEvents(),
        stream: failingFinalStream,
        updateCard: async () => {
          throw cardLimit();
        },
        send: async (_chatId, content) => {
          if ((content as { card?: unknown }).card) throw cardLimit();
          return { messageId: 'om_post' };
        },
      });
      await startTestBridge(h);

      await h.channel.handlers.message?.(message('om_card_limit_post', 'run'));
      await waitFor(() => h.channel.sent.length === 2);

      expect(lastMarkdown(h.channel)).toContain('ANSWER_SENTINEL');
      expect(lastMarkdown(h.channel)).not.toContain('TOOL_OUTPUT_SENTINEL');
    });

    it('re-sends the answer as a post when a markdown stream fails its final update', async () => {
      vi.spyOn(log, 'fail').mockImplementation(() => {});
      const h = await createHarness({
        agentKind: 'claude',
        events: runEvents(),
        stream: async (_chatId, input) => {
          const producer = (input as {
            markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
          }).markdown;
          await producer?.({ setContent: vi.fn(async () => {}) });
          throw cardLimit();
        },
      });
      await startTestBridge(h);

      await h.channel.handlers.message?.(message('om_md_limit', 'run'));
      await waitFor(() => h.channel.sent.length === 1);

      expect(lastMarkdown(h.channel)).toContain('ANSWER_SENTINEL');
      expect(lastMarkdown(h.channel)).not.toContain('TOOL_OUTPUT_SENTINEL');
    });

    it('does not re-send anything when the message it answers was recalled', async () => {
      vi.spyOn(log, 'fail').mockImplementation(() => {});
      const h = await createHarness({
        agentKind: 'claude',
        messageReply: 'card',
        events: runEvents(),
        stream: async (_chatId, input) => {
          const producer = (input as {
            card?: { producer?: (ctrl: { update(next: unknown): Promise<void>; messageId: string }) => Promise<void> };
          }).card?.producer;
          await producer?.({ update: vi.fn(async () => {}), messageId: 'om_recalled_card' });
          throw new LarkChannelError('target_revoked', 'The message was withdrawn.');
        },
      });
      await startTestBridge(h);

      await h.channel.handlers.message?.(message('om_recalled', 'run'));
      await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(h.channel.updated).toHaveLength(0);
      expect(h.channel.sent).toHaveLength(0);
    });

    it('also rescues a final update that fails after the terminal grace window', async () => {
      vi.spyOn(log, 'fail').mockImplementation(() => {});
      vi.spyOn(log, 'warn').mockImplementation(() => {});
      const streamFailure = deferred<void>();
      const h = await createHarness({
        agentKind: 'claude',
        messageReply: 'card',
        events: runEvents(),
        stream: async (_chatId, input) => {
          const producer = (input as {
            card?: { producer?: (ctrl: { update(next: unknown): Promise<void>; messageId: string }) => Promise<void> };
          }).card?.producer;
          void producer?.({ update: vi.fn(async () => {}), messageId: 'om_slow_card' });
          await streamFailure.promise;
        },
      });
      await startTestBridge(h);

      await h.channel.handlers.message?.(message('om_card_limit_late', 'run'));
      await new Promise((resolve) => setTimeout(resolve, 3_300));
      streamFailure.reject(cardLimit());
      await waitFor(() => h.channel.updated.length === 1);

      expect(h.channel.updated[0]?.messageId).toBe('om_slow_card');
      expect(JSON.stringify(h.channel.updated[0]?.card)).toContain('ANSWER_SENTINEL');
    }, 10_000);
  });
});

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  send?: SendFn;
  updateCard?: UpdateCardFn;
  /** One run's events, or one array per run. */
  events?: FakeAgentEvents;
  messageReply?: 'card' | 'markdown' | 'text';
  /** Codex holds its answer back for a dedicated final reply; Claude streams it. */
  agentKind?: 'claude' | 'codex';
  /** A turn the first run emits on its own after its user turn. */
  background?: FakeBackgroundTurn;
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('markdown-stream-startup-failure-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: options.agentKind ?? 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedUsers: ['ou_user'],
    },
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
    ...(options.messageReply ? { preferences: { messageReply: options.messageReply } } : {}),
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex',
    ...(options.background ? { background: options.background } : {}),
    events: options.events ?? [
      [
        {
          type: 'error',
          message: 'codex exited with code 1: Error loading config.toml',
          terminationReason: 'failed',
        },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}, appPaths?: Parameters<typeof startChannel>[0]['appPaths']): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
    ...(appPaths ? { appPaths } : {}),
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(harnessOptions: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  send?: SendFn;
  updateCard?: UpdateCardFn;
} = {}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const updated: FakeLarkChannel['updated'] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    updated,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(harnessOptions.reactionCreate ?? (async () => ({ data: { reaction_id: 'reaction_1' } }))),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      if (harnessOptions.send) return harnessOptions.send(chatId, content, options);
      return { messageId: `sent_${sent.length}` };
    },
    updateCard: vi.fn(async (messageId: string, card: object) => {
      updated.push({ messageId, card });
      if (harnessOptions.updateCard) await harnessOptions.updateCard(messageId, card);
    }),
    stream: harnessOptions.stream ?? (async () => {
      await new Promise<void>(() => {});
    }),
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

/**
 * A card stream shaped like the SDK's: the producer gets the controller itself,
 * every update goes out through `this.patch()`, and the stream ends with one
 * final patch. `patch` decides what Feishu does with each card.
 */
function sdkLikeCardStream(
  patch: (card: unknown) => Promise<void>,
  messageId = 'om_card_msg',
): StreamFn {
  return async (_chatId, input) => {
    const producer = (input as {
      card?: { initial: unknown; producer?: (ctrl: object) => Promise<void> };
    }).card;
    const ctrl = {
      messageId,
      current: producer?.initial,
      async update(next: unknown): Promise<void> {
        this.current = next;
        await this.patch();
      },
      async patch(): Promise<void> {
        await patch(this.current);
      },
    };
    await producer?.producer?.(ctrl);
    await ctrl.patch();
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'codex',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
    /** Late-bound by startChannel. */
    autoResumer: undefined as AutoResumer | undefined,
  };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function reactionTypesAdded(channel: FakeLarkChannel): string[] {
  return channel.rawClient.im.v1.messageReaction.create.mock.calls.map(
    (call) =>
      (call[0] as { data?: { reaction_type?: { emoji_type?: string } } })?.data?.reaction_type
        ?.emoji_type ?? '',
  );
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}

function testAppPaths(tmp: TmpProfile) {
  return {
    secretsFile: join(tmp.profile, 'secrets.enc'),
    keystoreSaltFile: join(tmp.profile, 'keystore.salt'),
    mediaDir: join(tmp.profile, 'media'),
    runsFile: join(tmp.profile, 'runs.json'),
    knowledgeDir: join(tmp.profile, 'knowledge'),
    jobsFile: join(tmp.profile, 'jobs.json'),
    pendingFile: join(tmp.profile, 'pending.json'),
    usageFile: join(tmp.profile, 'usage.json'),
    auditFile: join(tmp.profile, 'audit.jsonl'),
    profileDir: tmp.profile,
  };
}
