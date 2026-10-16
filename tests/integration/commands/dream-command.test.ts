import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { DREAM_DEFAULTS } from '../../../src/config/schema.js';
import type { DreamRun } from '../../../src/dream/state.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const RUN: DreamRun = {
  id: '20261013-120000-abcd',
  status: 'succeeded',
  actorId: 'ou-admin',
  startedAt: 1,
  endedAt: 2,
  note: '1 个范围、1 个会话',
  sessions: 1,
  scopes: 1,
  exchanges: 2,
  memoryItems: 2,
  skillItems: 0,
  rejected: 0,
  deferred: [],
  targets: [{ repo: 'knowledge', label: '知识库', branch: 'dream/x', phase: 'pr-created', items: 2, prUrl: 'https://github.com/acme/k/pull/7', prNumber: 7 }],
};

async function createHarness(opts: { autoOn?: boolean } = {}) {
  const autoOn = opts.autoOn ?? false;
  const tmp = await createTmpProfile('dream-command-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'], allowedUsers: ['ou-member'] },
  });
  profileConfig.workspaces.default = tmp.workspace;
  let finish: ((run: DreamRun) => void) | undefined;
  const dream = {
    status: vi.fn(async () => ({
      enabled: true,
      settings: DREAM_DEFAULTS,
      agent: 'Claude Code',
      targets: { knowledge: { url: 'git@github.com:acme/k.git' }, skills: { problem: '没有配置 skill 库（/skills lib add）' } },
      runs: [RUN],
      openedPrs: 1,
      pendingDrafts: 0,
      trackedSessions: 3,
      auto: {
        enabled: autoOn,
        settings: DREAM_DEFAULTS.auto,
        ledger: {
          consecutiveFailures: 0,
          lastCheck: { at: 3, block: 'backlog', reason: '待审积压：还有 1 个课堂精练 Draft PR 没合并或关闭（上限 1），暂停自动整理' },
        },
      },
    })),
    start: vi.fn(async (_actor: unknown, onFinish?: (run: DreamRun) => void) => {
      finish = onFinish;
      return { run: { ...RUN, status: 'queued' as const } };
    }),
    cancel: vi.fn(() => true),
    pullRequests: vi.fn(async () => [{ run: RUN, target: RUN.targets[0]!, state: '待审核（草稿）' }]),
    diff: vi.fn(async () => ({ id: RUN.id, parts: [{ label: '知识库', diff: '+ - [abc123] 一条\n```' }] })),
    revert: vi.fn(async (id: string) =>
      id === RUN.id
        ? { id, results: [{ label: '知识库', prUrl: 'https://github.com/acme/k/pull/9', note: '撤销 Draft PR 已开' }] }
        : { error: `没有批次 \`${id}\`。` },
    ),
  };
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.root, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
    dream,
  } as unknown as Controls;

  const run = (content: string, opts: { senderId?: string; chatType?: 'p2p' | 'group' } = {}): Promise<boolean> => {
    const chatType = opts.chatType ?? 'p2p';
    return tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: {
        messageId: `om-${Math.random().toString(16).slice(2)}`,
        chatId: 'chat-1',
        chatType,
        senderId: opts.senderId ?? 'ou-admin',
        senderName: 'User',
        content,
        resources: [],
        mentions: [],
        mentionedBot: false,
      } as unknown as NormalizedMessage,
      scope: 'chat-1',
      chatMode: chatType,
      sessions,
      workspaces,
      agent: createFakeAgent(),
      activeRuns: new ActiveRuns(),
      controls,
    });
  };
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { channel, dream, run, finish: (r: DreamRun) => finish?.(r) };
}

function texts(channel: FakeChannel): string {
  return JSON.stringify(channel.sent.map((m) => m.content));
}

describe('/practice', () => {
  it('is for admins only', async () => {
    const h = await createHarness();
    await h.run('/practice run', { senderId: 'ou-member' });
    expect(h.dream.start).not.toHaveBeenCalled();
    expect(h.channel.sent).toHaveLength(1);
  });

  it('only works in a private chat', async () => {
    const h = await createHarness();
    await h.run('/practice', { chatType: 'group' });
    expect(h.dream.status).not.toHaveBeenCalled();
    expect(texts(h.channel)).toContain('私聊');
  });

  it('shows status with targets, counts and links, never draft text', async () => {
    const h = await createHarness();
    await h.run('/practice');
    const out = texts(h.channel);
    expect(out).toContain('课堂精练');
    expect(out).toContain('git@github.com:acme/k.git');
    expect(out).toContain('没有配置 skill 库');
    expect(out).toContain('pull/7');
  });

  it('says whether 自动整理 is on and why it did not run', async () => {
    const off = await createHarness();
    await off.run('/practice');
    expect(texts(off.channel)).toContain('自动整理：未开启');
    const on = await createHarness({ autoOn: true });
    await on.run('/practice');
    const out = texts(on.channel);
    expect(out).toContain('01:00-07:00');
    expect(out).toContain('没跑——待审积压');
  });

  it('reverts a batch through a Draft PR', async () => {
    const h = await createHarness();
    await h.run('/practice revert');
    expect(h.dream.revert).not.toHaveBeenCalled();
    expect(texts(h.channel)).toContain('用法');
    await h.run(`/practice revert ${RUN.id}`);
    expect(h.dream.revert).toHaveBeenCalledWith(RUN.id);
    expect(texts(h.channel)).toContain('pull/9');
    await h.run('/practice revert nope');
    expect(texts(h.channel)).toContain('没有批次');
    await h.run(`/practice revert ${RUN.id}`, { senderId: 'ou-member' });
    expect(h.dream.revert).toHaveBeenCalledTimes(2);
  });

  it('starts a run, reports its outcome once, and cancels', async () => {
    const h = await createHarness();
    await h.run('/practice run');
    expect(h.dream.start).toHaveBeenCalledWith({ id: 'ou-admin', name: 'User' }, expect.any(Function));
    expect(texts(h.channel)).toContain('已开始整理');
    h.finish(RUN);
    await vi.waitFor(() => expect(texts(h.channel)).toContain('Draft PR 已开'));
    await h.run('/practice cancel');
    expect(h.dream.cancel).toHaveBeenCalled();
  });

  it('lists PRs and shows a fenced diff', async () => {
    const h = await createHarness();
    await h.run('/practice prs');
    expect(texts(h.channel)).toContain('待审核（草稿）');
    await h.run(`/practice diff ${RUN.id}`);
    expect(h.dream.diff).toHaveBeenCalledWith(RUN.id);
    const last = texts(h.channel);
    expect(last).toContain('```diff');
    expect(last).toContain("'''");
  });
});
