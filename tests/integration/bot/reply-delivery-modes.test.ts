import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { AutoResumer } from '../../../src/bot/auto-resume.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

/**
 * Characterisation of how a finished run's reply reaches the chat, for each
 * reply mode (CoT / card / markdown / text) in a plain chat and in a topic.
 * Written before reply delivery moved out of channel.ts, as the safety net
 * for that move: it pins what goes out (stream or message, where it is
 * threaded, the reactions, the session scope), not how it is produced.
 */

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

type Mode = 'cot' | 'card' | 'markdown' | 'text' | 'final-card';
type Where = 'p2p' | 'topic' | 'group';

interface StreamCall {
  chatId: string;
  kind: 'card' | 'markdown';
  options: unknown;
  /** Every card / markdown body the producer rendered, in order. */
  renders: string[];
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: { message?: (msg: NormalizedMessage) => Promise<void> | void };
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  streams: StreamCall[];
  reactions: Array<{ messageId: string; emoji: string }>;
  rawClient: Record<string, unknown>;
  on(handlers: FakeLarkChannel['handlers']): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'p2p' | 'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<{ messageId: string }>;
  updateCard: ReturnType<typeof vi.fn>;
  recallMessage: ReturnType<typeof vi.fn>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

const ANSWER = 'ANSWER_BODY_42';

const RUN_EVENTS: AgentEvent[] = [
  { type: 'system', sessionId: 'sess-1' },
  { type: 'text', delta: ANSWER },
  { type: 'done', terminationReason: 'normal' },
];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const CASES: Array<{ mode: Mode; where: Where }> = (['cot', 'card', 'markdown', 'text'] as const).flatMap((mode) =>
  (['p2p', 'topic'] as const).map((where) => ({ mode, where })),
);

describe('reply delivery by mode', () => {
  it.each(CASES)('$mode reply in a $where chat', async ({ mode, where }) => {
    const h = await startHarness(mode, where);
    const msg = where === 'topic' ? topicMessage('om_q') : p2pMessage('om_q');
    const scope = where === 'topic' ? 'oc_topic:omt_1' : 'oc_dm';
    const threaded = where === 'topic' ? { replyInThread: true } : {};

    await h.channel.handlers.message?.(msg);
    await waitFor(() => h.channel.reactions.some((r) => r.emoji === 'DONE'));
    // Let any (unwanted) duplicate delivery fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 80));

    // The run resumed nothing and recorded its session under the scope.
    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.sessions.getRaw(scope)?.sessionId).toBe('sess-1');

    // The working reaction is the ack in every mode but CoT (it has its own bubble).
    const emojis = h.channel.reactions.filter((r) => r.messageId === 'om_q').map((r) => r.emoji);
    expect(emojis).toEqual(mode === 'cot' ? ['DONE'] : ['Typing', 'DONE']);

    const chatId = msg.chatId;
    if (mode === 'card' || mode === 'markdown') {
      // Streamed into one progress message that ends holding the answer; nothing else is sent.
      expect(h.channel.streams).toHaveLength(1);
      const stream = h.channel.streams[0]!;
      expect(stream.chatId).toBe(chatId);
      expect(stream.kind).toBe(mode);
      expect(stream.options).toEqual({ replyTo: 'om_q', ...threaded });
      expect(stream.renders.at(-1)).toContain(ANSWER);
      expect(h.channel.sent).toEqual([]);
    } else {
      // One standalone reply carrying the answer; no progress stream.
      expect(h.channel.streams).toEqual([]);
      expect(h.channel.sent).toHaveLength(1);
      const reply = h.channel.sent[0]!;
      expect(reply.chatId).toBe(chatId);
      expect(reply.options).toEqual({ replyTo: 'om_q', ...threaded });
      expect(Object.keys(reply.content as object)).toEqual(['markdown']);
      expect((reply.content as { markdown: string }).markdown).toContain(ANSWER);
    }

    if (mode === 'cot') {
      // The CoT bubble is created against the chat, anchored on the question.
      const create = h.cotRequests.find((r) => r.url.includes('/open-apis/im/v1/message_cot?receive_id_type=chat_id'));
      expect(create).toBeDefined();
      expect(JSON.parse(create!.body)).toMatchObject({ receive_id: chatId });
    } else {
      expect(h.cotRequests).toEqual([]);
    }
  });
});

describe('an answer holding code, in card mode', () => {
  it('moves to a post below the card, which keeps a pointer to it', async () => {
    const h = await startHarness('card', 'p2p', { events: [
      { type: 'system', sessionId: 'sess-1' },
      { type: 'text', delta: `${ANSWER}\n\n\`\`\`sql\nSELECT 1;\n\`\`\`` },
      { type: 'done', terminationReason: 'normal' },
    ] });

    await h.channel.handlers.message?.(p2pMessage('om_q'));
    await waitFor(() => h.channel.reactions.some((r) => r.emoji === 'DONE'));
    await waitFor(() => h.channel.updateCard.mock.calls.length > 0);

    // The card streamed the answer first, as always.
    expect(h.channel.streams).toHaveLength(1);
    expect(h.channel.streams[0]!.renders.at(-1)).toContain('SELECT 1;');
    // Then the answer went out as one post replying to the question…
    expect(h.channel.sent).toHaveLength(1);
    const post = h.channel.sent[0]!;
    expect(Object.keys(post.content as object)).toEqual(['post']);
    expect(post.options).toEqual({ replyTo: 'om_q' });
    expect(JSON.stringify(post.content)).toContain('```sql\\nSELECT 1;\\n```');
    // …and the card now points at it instead of holding it.
    expect(h.channel.updateCard).toHaveBeenCalledTimes(1);
    const [messageId, card] = h.channel.updateCard.mock.calls[0]!;
    expect(messageId).toBe('om_stream_1');
    expect(JSON.stringify(card)).toContain('答复见下一条消息');
    expect(JSON.stringify(card)).not.toContain('SELECT 1;');
    expect(JSON.stringify(card)).not.toContain(ANSWER);
  });
});

// A Claude-style run: a note, a tool call, then the answer.
const NOTE = '我先看一下日志';
const narratedRun = (answer: string): AgentEvent[] => [
  { type: 'system', sessionId: 'sess-1' },
  { type: 'text', delta: NOTE },
  { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'tail app.log' } },
  { type: 'tool_result', id: 't1', output: 'ok', isError: false },
  { type: 'text', delta: answer },
  { type: 'done', terminationReason: 'normal' },
];

/** Run one message to the end; the markdown bodies sent as standalone replies, and the CoT requests. */
async function replyTo(mode: Mode, runEvents: AgentEvent[], preferences: Record<string, unknown> = {}) {
  const h = await startHarness(mode, 'topic', { events: runEvents, preferences });
  await h.channel.handlers.message?.(topicMessage('om_q'));
  await waitFor(() => h.channel.reactions.some((r) => r.emoji === 'DONE'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  return {
    h,
    sent: h.channel.sent.map((s) => (s.content as { markdown: string }).markdown),
    cotBodies: h.cotRequests.map((r) => r.body).join('\n'),
  };
}

describe('COT mode with tool calls', () => {
  it('shows the notes in the bubble and replies with only the answer', async () => {
    const { sent, cotBodies } = await replyTo('cot', narratedRun(ANSWER));
    expect(cotBodies).toContain(NOTE);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(ANSWER);
    expect(sent[0]).not.toContain(NOTE);
  });

  it('posts nothing when the answer after the tool calls is [[NO_REPLY]]', async () => {
    const { sent } = await replyTo('cot', narratedRun('[[NO_REPLY]]'));
    expect(sent).toEqual([]);
  });
});

describe('final-card mode', () => {
  type Card = { header?: { template: string; title: { content: string } }; body: { elements: unknown[] } };
  const MESSAGES = { p2p: p2pMessage, topic: topicMessage, group: groupMessage };

  async function run(where: Where, events: AgentEvent[], failCards = false) {
    const h = await startHarness('final-card', where, { events, failCards });
    const msg = MESSAGES[where]('om_q');
    await h.channel.handlers.message?.(msg);
    await waitFor(() => h.channel.reactions.some((r) => r.emoji === 'DONE'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { h, msg };
  }

  it.each(['p2p', 'topic', 'group'] as const)('replies in a %s chat with one card holding only the answer', async (where) => {
    const { h, msg } = await run(where, narratedRun(ANSWER));
    // Nothing while it runs but the working reaction.
    expect(h.channel.streams).toEqual([]);
    expect(h.channel.reactions.filter((r) => r.messageId === 'om_q').map((r) => r.emoji)).toEqual(['Typing', 'DONE']);
    expect(h.channel.sent).toHaveLength(1);
    const reply = h.channel.sent[0]!;
    expect(reply.chatId).toBe(msg.chatId);
    expect(reply.options).toEqual({ replyTo: 'om_q', ...(where === 'topic' ? { replyInThread: true } : {}) });
    const card = (reply.content as { card: Card }).card;
    expect(card.header).toBeUndefined();
    const json = JSON.stringify(card);
    expect(json).toContain(ANSWER);
    expect(json).not.toContain(NOTE);
    expect(json).not.toContain('tail app.log');
  });

  it('asks the agent for a title and puts the one it gives in a violet header bar', async () => {
    const { h } = await run('group', narratedRun(`[[TITLE: 三个区 Pod 对比]]\n张三，三个区：\n\n| 区 | Pod |\n|---|---|\n| eur | 12 |`));
    expect(JSON.stringify(h.agent.runOptions[0])).toContain('[[TITLE: 主题]]');
    const card = (h.channel.sent[0]!.content as { card: Card }).card;
    expect(card.header).toEqual({ template: 'violet', title: { tag: 'plain_text', content: '三个区 Pod 对比' } });
    expect(JSON.stringify(card)).not.toContain('[[TITLE');
  });

  it('keeps a long answer without a title free of a header bar', async () => {
    const { h } = await run('group', narratedRun(`张三，三个区：\n\n| 区 | Pod |\n|---|---|\n| eur | 12 |`));
    expect((h.channel.sent[0]!.content as { card: Card }).card.header).toBeUndefined();
  });

  it('posts nothing when the answer after the tool calls is [[NO_REPLY]]', async () => {
    const { h } = await run('group', narratedRun('[[NO_REPLY]]'));
    expect(h.channel.sent).toEqual([]);
  });

  it('posts the answer as markdown when Feishu refuses the card', async () => {
    const { h } = await run('topic', narratedRun(ANSWER), true);
    expect(h.channel.sent).toHaveLength(1);
    const body = (h.channel.sent[0]!.content as { markdown: string }).markdown;
    expect(body).toContain(ANSWER);
    expect(body).not.toContain(NOTE);
  });
});

describe('text mode with tool calls (textReplyFinalOnly)', () => {
  it('posts only the answer after the last tool call', async () => {
    const { sent } = await replyTo('text', narratedRun(ANSWER));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(ANSWER);
    expect(sent[0]).not.toContain(NOTE);
    expect(sent[0]).not.toContain('tail app.log');
  });

  it('posts the whole record when textReplyFinalOnly is off', async () => {
    const { sent } = await replyTo('text', narratedRun(ANSWER), { textReplyFinalOnly: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(NOTE);
    expect(sent[0]).toContain('tail app.log');
    expect(sent[0]).toContain(ANSWER);
  });

  it('posts nothing when the answer after the tool calls is [[NO_REPLY]]', async () => {
    const { sent } = await replyTo('text', narratedRun('[[NO_REPLY]]'));
    expect(sent).toEqual([]);
  });

  it('never shows a [[TITLE…]] line, and does not ask for one', async () => {
    const { sent, h } = await replyTo('text', narratedRun(`[[TITLE: 主题]]\n${ANSWER}`));
    expect(JSON.stringify(h.agent.runOptions[0])).not.toContain('[[TITLE');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(ANSWER);
    expect(sent[0]).not.toContain('TITLE');
  });
});

async function startHarness(
  mode: Mode,
  where: Where,
  opts: { events?: AgentEvent[]; preferences?: Record<string, unknown>; failCards?: boolean } = {},
): Promise<{
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  cotRequests: Array<{ url: string; body: string }>;
}> {
  const tmp = await createTmpProfile('reply-delivery-modes-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'], allowedChats: ['oc_topic', 'oc_group'] },
    preferences: {
      messageReply: mode === 'cot' ? 'markdown' : mode,
      messageReplyMigrated: true,
      ...(mode === 'cot' ? { cotMessages: 'brief' as const } : {}),
      ...opts.preferences,
    },
  });
  const profileConfig = { ...base, workspaces: { ...base.workspaces, default: workspace } };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({ events: opts.events ?? RUN_EVENTS });
  const channel = createFakeLarkChannel(where, opts.failCards === true);
  sdkMock.channel = channel;

  // CoT talks to Feishu over plain fetch, not through the SDK channel.
  const cotRequests: Array<{ url: string; body: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    if (url.includes('tenant_access_token')) {
      return jsonResponse({ code: 0, tenant_access_token: 't-token', expire: 7200 });
    }
    cotRequests.push({ url, body });
    if (url.includes('message_cot?receive_id_type=chat_id')) {
      return jsonResponse({ code: 0, data: { cot_id: 'cot_1', message_id: 'om_cot' } });
    }
    return jsonResponse({ code: 0, data: {} });
  }));

  const controls = {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
    autoResumer: undefined as AutoResumer | undefined,
  };
  const bridge = await startChannel({ cfg: profileConfig, agent, sessions, workspaces, controls });
  cleanups.push(async () => {
    await bridge.disconnect();
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { channel, agent, sessions, cotRequests };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function createFakeLarkChannel(where: Where, failCards = false): FakeLarkChannel {
  const handlers: FakeLarkChannel['handlers'] = {};
  const sent: FakeLarkChannel['sent'] = [];
  const streams: StreamCall[] = [];
  const reactions: FakeLarkChannel['reactions'] = [];
  let nextReaction = 1;
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    streams,
    reactions,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: { application: { get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_owner' } } } })) } },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
            list: vi.fn(async () => ({ data: { items: [], has_more: false } })),
          },
        },
      },
    },
    on(next) {
      Object.assign(handlers, next);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return where;
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      // Feishu refusing a card, e.g. 230099 (too many tables).
      if (failCards && (content as { card?: unknown }).card) throw new Error('230099 card rejected');
      sent.push({ chatId, content, options });
      return { messageId: `om_sent_${sent.length}` };
    },
    async stream(chatId, input, options) {
      const messageId = `om_stream_${streams.length + 1}`;
      const card = (input as { card?: { initial: unknown; producer(ctrl: object): Promise<void> } }).card;
      const markdown = (input as { markdown?: (ctrl: object) => Promise<void> }).markdown;
      const call: StreamCall = { chatId, kind: card ? 'card' : 'markdown', options, renders: [] };
      streams.push(call);
      if (card) {
        await card.producer({
          messageId,
          async update(next: unknown) {
            call.renders.push(JSON.stringify(next));
          },
        });
      } else if (markdown) {
        await markdown({
          messageId,
          async setContent(body: string) {
            call.renders.push(body);
          },
        });
      }
      return { messageId };
    },
    updateCard: vi.fn(async () => {}),
    recallMessage: vi.fn(async () => {}),
    async addReaction(messageId, emojiType) {
      reactions.push({ messageId, emoji: emojiType });
      return `reaction_${nextReaction++}`;
    },
    async removeReaction() {},
  };
  return channel;
}

function p2pMessage(messageId: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content: '问个问题',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function groupMessage(messageId: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_group',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content: '问个问题',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionedBot: true,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function topicMessage(messageId: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_topic',
    chatType: 'group',
    threadId: 'omt_1',
    senderId: 'ou_user',
    senderName: 'User',
    content: '问个问题',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionedBot: true,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
