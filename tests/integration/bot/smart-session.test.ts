import type { NormalizedMessage } from '@larksuite/channel';
import { readFileSync } from 'node:fs';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn((_opts: unknown) => {
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
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});


describe('会话智能压缩 in the IM flow', () => {
  it('hides the agent close marker, then starts the next message in a fresh session with a hand-off', async () => {
    shown.length = 0;
    const h = await createHarness();
    h.agent.setEvents([
      [
        { type: 'system', sessionId: 'sess-1' },
        { type: 'text', delta: '都改好了。\n\n[[NEW_SESSION: 修好了群管理面板]]' },
        { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' },
      ],
      [
        { type: 'system', sessionId: 'sess-2' },
        { type: 'text', delta: '新话题的回答' },
        { type: 'done', sessionId: 'sess-2', terminationReason: 'normal' },
      ],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message({ messageId: 'om_1', content: '@Bridge 修一下面板' }));
    await waitFor(() => shown.some((s) => s.includes('都改好了')));
    expect(shown.join('\n')).not.toContain('NEW_SESSION');
    expect(readSection(h.agent.runOptions[0]?.prompt ?? '', 'bridge_instructions')).toEqual(
      expect.arrayContaining([expect.stringContaining('[[NEW_SESSION')]),
    );
    expect(h.agent.runOptions[0]?.compactWindowTokens).toBe(300_000);
    await waitFor(() => h.sessions.getRaw('oc_chat')?.sessionId === 'sess-1');
    await new Promise((resolve) => setTimeout(resolve, 50));

    await h.channel.handlers.message?.(message({ messageId: 'om_2', content: '@Bridge 换个话题' }));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.agent.runOptions[1]?.sessionId).toBeUndefined();
    const handoff = readSection(h.agent.runOptions[1]?.prompt ?? '', 'session_handoff') as {
      reason?: string;
      previousSummary?: string;
    };
    expect(handoff).toMatchObject({ reason: 'agent-done', previousSummary: '修好了群管理面板' });
  });

  it('keeps resuming when the agent did not ask to close', async () => {
    shown.length = 0;
    const h = await createHarness();
    h.agent.setEvents([
      [
        { type: 'system', sessionId: 'sess-1' },
        { type: 'text', delta: '还在处理' },
        { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' },
      ],
      [{ type: 'done', sessionId: 'sess-1', terminationReason: 'normal' }],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message({ messageId: 'om_1', content: '@Bridge 第一步' }));
    await waitFor(() => h.sessions.getRaw('oc_chat')?.sessionId === 'sess-1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.channel.handlers.message?.(message({ messageId: 'om_2', content: '@Bridge 第二步' }));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.agent.runOptions[1]?.sessionId).toBe('sess-1');
    expect(h.agent.runOptions[1]?.prompt).not.toContain('<session_handoff>');
  });
});

describe('会话智能压缩 close requests across a restart', () => {
  it('writes the request to disk with the conversation it closes', async () => {
    shown.length = 0;
    const h = await createHarness();
    h.agent.setEvents([
      [
        { type: 'system', sessionId: 'sess-1' },
        { type: 'text', delta: '做完了。\n\n[[NEW_SESSION: 查完了校准问题]]' },
        { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' },
      ],
    ]);
    const appPaths = testAppPaths(h.tmp);
    await startTestBridge(h, appPaths);

    await h.channel.handlers.message?.(message({ messageId: 'om_1', content: '@Bridge 查一下' }));
    await waitFor(() => shown.some((s) => s.includes('做完了')));
    await waitFor(() => readJson(appPaths.rotationsFile)?.oc_chat !== undefined);
    expect(readJson(appPaths.rotationsFile)?.oc_chat).toMatchObject({ summary: '查完了校准问题', handle: 'sess-1' });
  });

  it('starts fresh on the first message after a restart when the request was left on disk', async () => {
    shown.length = 0;
    const h = await createHarness();
    h.sessions.set('oc_chat', 'sess-1', h.workspace);
    h.agent.setEvents([[{ type: 'done', sessionId: 'sess-2', terminationReason: 'normal' }]]);
    const appPaths = testAppPaths(h.tmp);
    await writeFile(
      appPaths.rotationsFile,
      JSON.stringify({ oc_chat: { summary: '查完了校准问题', handle: 'sess-1', requestedAt: Date.now() - 60_000 } }),
    );
    await startTestBridge(h, appPaths);

    await h.channel.handlers.message?.(message({ messageId: 'om_2', content: '@Bridge 新问题' }));
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions[0]?.sessionId).toBeUndefined();
    expect(readSection(h.agent.runOptions[0]?.prompt ?? '', 'session_handoff')).toMatchObject({
      reason: 'agent-done',
      previousSummary: '查完了校准问题',
    });
    await waitFor(() => readJson(appPaths.rotationsFile)?.oc_chat === undefined);
  });

  it('ignores a request for a conversation the scope no longer resumes', async () => {
    shown.length = 0;
    const h = await createHarness();
    h.sessions.set('oc_chat', 'sess-resumed', h.workspace);
    h.agent.setEvents([[{ type: 'done', sessionId: 'sess-resumed', terminationReason: 'normal' }]]);
    const appPaths = testAppPaths(h.tmp);
    await writeFile(
      appPaths.rotationsFile,
      JSON.stringify({ oc_chat: { handle: 'sess-closed', requestedAt: Date.now() - 60_000 } }),
    );
    await startTestBridge(h, appPaths);

    await h.channel.handlers.message?.(message({ messageId: 'om_3', content: '@Bridge 接着聊' }));
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions[0]?.sessionId).toBe('sess-resumed');
    expect(h.agent.runOptions[0]?.prompt).not.toContain('<session_handoff>');
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  workspace: string;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('smart-session-im-');
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
      allowedChats: ['oc_chat'],
      allowedUsers: ['ou_user'],
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
    preferences: { ...baseProfileConfig.preferences, smartSession: true },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    workspace,
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
}, appPaths?: ReturnType<typeof testAppPaths>): Promise<void> {
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

/** Everything the fake channel put on screen: sent messages and streamed markdown. */
const shown: string[] = [];

function createFakeLarkChannel(): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  return {
    handlers,
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
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
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
    async send(_chatId, content) {
      shown.push(JSON.stringify(content));
    },
    async stream(_chatId, input) {
      if (isMarkdownStreamInput(input)) {
        await input.markdown({
          setContent: async (markdown: string) => {
            shown.push(markdown);
          },
        });
      }
    },
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
  content: string;
  senderId?: string;
  senderName?: string;
  rawSenderType?: string;
  mentions?: Array<{ key: string; openId?: string; name?: string; isBot?: boolean }>;
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: input.senderId ?? 'ou_user',
    senderName: input.senderName ?? 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: input.mentions ?? [
      { key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true },
    ],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1760000001000,
    ...(input.rawSenderType
      ? {
          raw: {
            sender: {
              sender_id: { open_id: input.senderId ?? 'ou_user' },
              sender_type: input.rawSenderType,
            },
            message: { message_id: input.messageId },
          },
        }
      : {}),
  } as unknown as NormalizedMessage;
}

function readSection(prompt: string, tag: string): unknown {
  const match = prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  if (!match) throw new Error(`missing section ${tag}`);
  return JSON.parse(match[1] ?? 'null') as unknown;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
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
    rotationsFile: join(tmp.profile, 'pending-rotations.json'),
    usageFile: join(tmp.profile, 'usage.json'),
    auditFile: join(tmp.profile, 'audit.jsonl'),
    profileDir: tmp.profile,
  };
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
