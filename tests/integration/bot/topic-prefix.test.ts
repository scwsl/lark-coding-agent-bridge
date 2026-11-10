import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import type { AgentEvent } from '../../../src/agent/types.js';
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
import { resetTopicClaims } from '../../../src/bot/topic-claims.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  sent: Array<{ chatId: string; content: unknown; options: unknown }>;
  streams: Array<{ chatId: string; options: unknown }>;
  cardUpdates: Array<{ messageId: string; card: unknown }>;
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    im: {
      v1: {
        message: {
          list: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  getAppInfo: ReturnType<typeof vi.fn>;
  listChats: ReturnType<typeof vi.fn>;
  fetchRawMessage: ReturnType<typeof vi.fn>;
  recallMessage: ReturnType<typeof vi.fn>;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: unknown): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  resetTopicClaims();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('前缀开话题', () => {
  it('opens a topic under a prefixed message and runs it there', async () => {
    const h = await createHarness({
      chatMode: 'group',
      messageReply: 'card',
      rawThreadIds: { om_prefixed: 'omt_new' },
      agentEvents: [{ type: 'system', sessionId: 'sess-1' }, { type: 'done', terminationReason: 'normal' }],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message({ messageId: 'om_prefixed', content: '/high 查一下 X' }));
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.sent[0]).toMatchObject({
      chatId: 'oc_topic_chat',
      options: { replyTo: 'om_prefixed', replyInThread: true },
    });
    // The topic opens with the progress card itself, not a line of its own…
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('正在思考');
    expect(JSON.stringify(h.channel.sent[0]?.content)).not.toContain('已开话题');
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('"threadId":"omt_new"');
    expect(prompt).toContain('/high');
    // …which the run takes over instead of posting a second card.
    await waitFor(() => h.channel.cardUpdates.some((u) => u.messageId === 'om_sent_1'));
    expect(h.channel.streams).toHaveLength(0);
    await waitFor(() => h.sessions.getRaw('oc_topic_chat:omt_new')?.sessionId === 'sess-1');
    expect(h.sessions.getRaw('oc_topic_chat')).toBeUndefined();
    // The run left nothing to show: the card that opened the topic goes back to the notice, not recalled.
    await waitFor(() => JSON.stringify(h.channel.cardUpdates.at(-1)?.card).includes('已开话题'));
    expect(h.channel.recallMessage).not.toHaveBeenCalledWith('om_sent_1');
  });

  it('turns the opener card back into the notice when the run replies without a card', async () => {
    const h = await createHarness({ chatMode: 'group', messageReply: 'markdown', rawThreadIds: { om_md: 'omt_md' } });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message({ messageId: 'om_md', content: '/high 查一下 X' }));
    await waitFor(() => h.channel.cardUpdates.some((u) => u.messageId === 'om_sent_1'));
    expect(JSON.stringify(h.channel.cardUpdates.at(-1)?.card)).toContain('已开话题');
    expect(h.channel.streams[0]?.options).toMatchObject({ replyTo: 'om_md', replyInThread: true });
  });

  it('opens the topic in a private chat too', async () => {
    const h = await createHarness({ chatMode: 'group', rawThreadIds: { om_dm: 'omt_dm' } });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_dm', chatType: 'p2p', mentionedBot: false, content: '/xhigh 改一下 Y' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_dm', replyInThread: true });
    expect(h.agent.runOptions[0]?.prompt ?? '').toContain('"threadId":"omt_dm"');
  });

  it('gives the first run in the new topic the conversation it left', async () => {
    const h = await createHarness({
      chatMode: 'group',
      rawThreadIds: { om_dm_ctx: 'omt_ctx' },
      threadMessages: [textItem('om_before', 'ou_user', 1760000000500, '刚才在查充电桩离线的问题')],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_dm_ctx', chatType: 'p2p', mentionedBot: false, content: '/high 接着刚才那个查' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const list = h.channel.rawClient.im.v1.message.list;
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ container_id_type: 'chat', container_id: 'oc_topic_chat' }) }),
    );
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('"window":"parent_recent"');
    expect(prompt).toContain('"scope":"p2p"');
    expect(prompt).toContain('刚才在查充电桩离线的问题');
  });

  it('opens a topic for /new-topic and runs the task without the prefix', async () => {
    const h = await createHarness({ chatMode: 'group', topicPrefix: undefined, rawThreadIds: { om_nt: 'omt_nt' } });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message({ messageId: 'om_nt', content: '/new-topic 看看' }));
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_nt', replyInThread: true });
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('"threadId":"omt_nt"');
    expect(prompt).toContain('看看');
    expect(prompt).not.toContain('/new-topic');
  });

  it('leaves a message without a prefix where it is', async () => {
    const h = await createHarness({ chatMode: 'group', rawThreadIds: { om_plain: 'omt_x' } });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message({ messageId: 'om_plain', content: '看看' }));
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(openers(h.channel)).toHaveLength(0);
    expect(h.agent.runOptions[0]?.prompt ?? '').not.toContain('omt_x');
  });

  it('runs in the topic it was sent in, without opening another', async () => {
    const h = await createHarness({ chatMode: 'group' });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_in_topic',
        rootId: 'om_root',
        parentId: 'om_root',
        threadId: 'omt_existing',
        content: '/high 接着查',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(openers(h.channel)).toHaveLength(0);
    expect(h.agent.runOptions[0]?.prompt ?? '').toContain('"threadId":"omt_existing"');
  });

  it('does nothing when the preference is off, or for a bare prefix', async () => {
    const h = await createHarness({ chatMode: 'group', topicPrefix: false, rawThreadIds: { om_off: 'omt_off' } });
    await startTestBridge(h);
    await h.channel.handlers.message?.(message({ messageId: 'om_off', content: '/high 查一下 X' }));
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(openers(h.channel)).toHaveLength(0);

    const h2 = await createHarness({ chatMode: 'group', rawThreadIds: { om_bare: 'omt_bare' } });
    await startTestBridge(h2);
    await h2.channel.handlers.message?.(message({ messageId: 'om_bare', content: '/high' }));
    await waitFor(() => h2.agent.runOptions.length === 1);
    expect(openers(h2.channel)).toHaveLength(0);
  });

  it('runs the message where it was when Feishu gives no topic back', async () => {
    const h = await createHarness({ chatMode: 'group', agentEvents: [{ type: 'system', sessionId: 'sess-1' }, { type: 'done', terminationReason: 'normal' }] });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message({ messageId: 'om_no_thread', content: '/high 查一下 X' }));
    await waitFor(() => h.agent.runOptions.length === 1, 4000);

    expect(h.agent.runOptions[0]?.prompt ?? '').not.toContain('"threadId"');
    await waitFor(() => h.sessions.getRaw('oc_topic_chat')?.sessionId === 'sess-1');
  });
});

describe('自动开话题', () => {
  it('opens a topic under a plain message and runs it there as sent', async () => {
    const h = await createHarness({ chatMode: 'group', autoTopic: true, rawThreadIds: { om_auto: 'omt_auto' } });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_auto', chatType: 'p2p', mentionedBot: false, content: '密码多少' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.sent[0]).toMatchObject({ options: { replyTo: 'om_auto', replyInThread: true } });
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('正在思考');
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('"threadId":"omt_auto"');
    expect(prompt).toContain('密码多少');
  });

  it('keeps a rung prefix and opens just one topic', async () => {
    const h = await createHarness({ chatMode: 'group', autoTopic: true, rawThreadIds: { om_auto_hi: 'omt_hi' } });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message({ messageId: 'om_auto_hi', content: '/high 查一下 X' }));
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(openers(h.channel)).toHaveLength(1);
    expect(h.agent.runOptions[0]?.prompt ?? '').toContain('"threadId":"omt_hi"');
  });

  it('leaves messages in a topic, from bots, or in chats left out where they are', async () => {
    const h = await createHarness({ chatMode: 'group', autoTopic: true, rawThreadIds: { om_bot: 'omt_bot' } });
    await startTestBridge(h);
    await h.channel.handlers.message?.(
      message({ messageId: 'om_in', rootId: 'om_r', parentId: 'om_r', threadId: 'omt_in', content: '接着查' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]?.prompt ?? '').toContain('"threadId":"omt_in"');
    expect(openers(h.channel)).toHaveLength(0);

    const h2 = await createHarness({
      chatMode: 'group',
      autoTopic: { exceptChats: ['oc_topic_chat'] },
      rawThreadIds: { om_out: 'omt_out' },
    });
    await startTestBridge(h2);
    await h2.channel.handlers.message?.(message({ messageId: 'om_out', content: '看看' }));
    await waitFor(() => h2.agent.runOptions.length === 1);
    expect(h2.agent.runOptions[0]?.prompt ?? '').not.toContain('omt_out');
  });
});

describe('转发 + 备注合并开话题', () => {
  const forward = (id: string) =>
    message({
      messageId: id,
      chatType: 'p2p',
      mentionedBot: false,
      rawContentType: 'merge_forward',
      content: '<forwarded_messages>\n陈玮: 电池 SOC 也放到 0xA3 吗\n</forwarded_messages>',
    });
  const note = (id: string, forwardId: string) =>
    message({ messageId: id, chatType: 'p2p', mentionedBot: false, parentId: forwardId, content: '对比一下通讯协议' });

  it('opens one topic under the note when the note comes in first', async () => {
    const h = await createHarness({ chatMode: 'group', autoTopic: true, autoEffort: false, rawThreadIds: { om_note: 'omt_note', om_fwd: 'omt_fwd' } });
    await startTestBridge(h);

    const first = h.channel.handlers.message?.(note('om_note', 'om_fwd'));
    await new Promise((r) => setTimeout(r, 30));
    const second = h.channel.handlers.message?.(forward('om_fwd'));
    await Promise.all([first, second]);
    await waitFor(() => h.agent.runOptions.length === 1);
    await new Promise((r) => setTimeout(r, 800));

    expect(openers(h.channel)).toHaveLength(1);
    expect(openers(h.channel)[0]).toMatchObject({ options: { replyTo: 'om_note', replyInThread: true } });
    expect(h.agent.runOptions).toHaveLength(1);
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('"threadId":"omt_note"');
    expect(prompt).toContain('对比一下通讯协议');
    expect(prompt).toContain('0xA3');
  });

  it('holds the forward back for its note when the forward comes in first', async () => {
    const h = await createHarness({ chatMode: 'group', autoTopic: true, autoEffort: false, rawThreadIds: { om_note2: 'omt_note2', om_fwd2: 'omt_fwd2' } });
    await startTestBridge(h);

    const first = h.channel.handlers.message?.(forward('om_fwd2'));
    await new Promise((r) => setTimeout(r, 200));
    const second = h.channel.handlers.message?.(note('om_note2', 'om_fwd2'));
    await Promise.all([first, second]);
    await waitFor(() => h.agent.runOptions.length === 1);
    await new Promise((r) => setTimeout(r, 800));

    expect(openers(h.channel)).toHaveLength(1);
    expect(openers(h.channel)[0]).toMatchObject({ options: { replyTo: 'om_note2' } });
    expect(h.agent.runOptions).toHaveLength(1);
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('"threadId":"omt_note2"');
    expect(prompt).toContain('0xA3');
  });

  it('still gives a lone forward a topic of its own', async () => {
    const h = await createHarness({ chatMode: 'group', autoTopic: true, autoEffort: false, rawThreadIds: { om_fwd3: 'omt_fwd3' } });
    await startTestBridge(h);

    await h.channel.handlers.message?.(forward('om_fwd3'));
    await waitFor(() => h.agent.runOptions.length === 1, 3000);

    expect(openers(h.channel)).toHaveLength(1);
    expect(openers(h.channel)[0]).toMatchObject({ options: { replyTo: 'om_fwd3' } });
    expect(h.agent.runOptions[0]?.prompt ?? '').toContain('"threadId":"omt_fwd3"');
  });
});

/** Replies that opened a topic: the opener card (or the notice it falls back to), sent in thread. */
function openers(channel: FakeLarkChannel) {
  return channel.sent.filter((s) => {
    const body = JSON.stringify(s.content);
    return (s.options as { replyInThread?: boolean } | undefined)?.replyInThread === true &&
      (body.includes('正在思考') || body.includes('已开话题'));
  });
}

async function createHarness(options: {
  chatMode?: 'group' | 'topic';
  messageReply?: 'card' | 'markdown';
  quotedMessages?: Record<string, string>;
  rawThreadIds?: Record<string, string>;
  threadMessages?: Array<Record<string, unknown>>;
  agentEvents?: AgentEvent[];
  onStream?: () => void;
  topicPrefix?: boolean;
  autoTopic?: boolean | { chats?: string[]; exceptChats?: string[] };
  autoEffort?: boolean;
} = {}):Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('topic-prefix-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: ['oc_topic_chat'],
      allowedUsers: ['ou_user'],
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    preferences: {
      ...baseProfileConfig.preferences,
      autoEffort: { enabled: options.autoEffort ?? true },
      ...(options.topicPrefix !== undefined ? { topicPrefix: options.topicPrefix } : {}),
      ...(options.autoTopic !== undefined ? { autoTopic: options.autoTopic } : {}),
      ...(options.messageReply ? { messageReply: options.messageReply } : {}),
    },
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: options.agentEvents ?? [{ type: 'done', terminationReason: 'normal' }],
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
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  rawThreadIds?: Record<string, string>;
  threadMessages?: Array<Record<string, unknown>>;
  onStream?: () => void;
} = {}):FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  const sent: Array<{ chatId: string; content: unknown; options: unknown }> = [];
  const streams: Array<{ chatId: string; options: unknown }> = [];
  const cardUpdates: Array<{ messageId: string; card: unknown }> = [];
  const chatMode = options.chatMode ?? 'topic';
  const quotedMessages = options.quotedMessages ?? {
    om_topic_root: 'topic root content',
  };
  const rawThreadIds = options.rawThreadIds ?? {};
  const threadMessages = options.threadMessages ?? [];
  const onStream = options.onStream;
  return {
    handlers,
    sent,
    streams,
    cardUpdates,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: {
        v1: {
          message: {
            list: vi.fn(async () => ({ data: { items: threadMessages, has_more: false } })),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    getAppInfo: vi.fn(async () => ({ ownerId: 'ou_owner' })),
    listChats: vi.fn(async () => []),
    fetchRawMessage: vi.fn(async (messageId: string) => [
      {
        message_id: messageId,
        msg_type: 'text',
        body: {
          content: JSON.stringify({
            text: quotedMessages[messageId] ?? 'quoted content',
          }),
        },
        create_time: '1760000000000',
        sender: { id: 'ou_quote_sender' },
        ...(rawThreadIds[messageId] ? { thread_id: rawThreadIds[messageId] } : {}),
      },
    ]),
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return chatMode;
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      return { messageId: `om_sent_${sent.length}` };
    },
    async stream(chatId, input, options) {
      streams.push({ chatId, options });
      onStream?.();
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      }
      return { messageId: `om_stream_${streams.length}` };
    },
    async updateCard(messageId, card) {
      cardUpdates.push({ messageId, card });
    },
    recallMessage: vi.fn(async () => {}),
  };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(input: {
  messageId: string;
  rootId?: string;
  parentId?: string;
  chatType?: 'p2p' | 'group';
  resources?: unknown[];
  threadId?: string;
  content: string;
  rawContentType?: string;
  mentionedBot?: boolean;
  mentions?: Array<{ key: string; openId: string; name: string; isBot: boolean }>;
  createTime?: number;
  senderType?: 'user' | 'app';
}): NormalizedMessage {
  const mentionedBot = input.mentionedBot ?? true;
  return {
    messageId: input.messageId,
    chatId: 'oc_topic_chat',
    chatType: input.chatType ?? 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: input.rawContentType ?? 'text',
    resources: input.resources ?? [],
    mentions:
      input.mentions ??
      (mentionedBot
        ? [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }]
        : [{ key: '@_user_1', openId: 'ou_human', name: '同事', isBot: false }]),
    mentionAll: false,
    mentionedBot,
    ...(input.rootId ? { rootId: input.rootId } : {}),
    ...(input.parentId ? { parentId: input.parentId, replyToMessageId: input.parentId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    createTime: input.createTime ?? 1760000001000,
    ...(input.senderType ? { raw: { sender: { sender_type: input.senderType } } } : {}),
  } as unknown as NormalizedMessage;
}

function textItem(messageId: string, senderId: string, createTime: number, text: string): Record<string, unknown> {
  return {
    message_id: messageId,
    msg_type: 'text',
    body: { content: JSON.stringify({ text }) },
    sender: { id: senderId, sender_type: 'user' },
    create_time: String(createTime),
  };
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
