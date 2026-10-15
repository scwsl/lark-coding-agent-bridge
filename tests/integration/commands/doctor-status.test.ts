import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentRun } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pool: ProcessPool;
  agent: FakeAgentAdapter;
  controls: Controls;
  run(content: string): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('/status and /doctor diagnostics', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('shows passive status for active run, queue, stale session, and owner API state', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    h.sessions.set('chat-1', 'sess-old', '/old');
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('chat-1', activeRun);
    const release = await h.pool.acquire();

    await expect(h.run('/status')).resolves.toBe(true);

    release();
    expect(h.agent.runOptions).toHaveLength(1);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('旧 cwd');
    expect(status).toContain('active run');
    expect(status).toContain('active scopes');
    expect(status).toContain('1/1 active');
    expect(status).toContain('owner API');
    expect(status).toContain('profile');
    expect(status).toContain('claude');
    expect(status).toContain('permission');
    expect(status).toContain('plan');
    expect(status).not.toContain('bypassPermissions');
  });

  it('shows how large the resumed conversation is and how long it has been idle', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    const cwd = h.workspaces.cwdFor('chat-1')!;
    h.sessions.set('chat-1', 'sess-live', cwd);
    await writeTranscript(h, cwd, 'sess-live', { minutesAgo: 30, contextTokens: 452_000 });

    await expect(h.run('/status')).resolves.toBe(true);

    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('约 45 万 token');
    expect(status).toContain('上次对话 30 分钟前');
    expect(status).not.toContain('自动开新会话');
  });

  it('says when 会话智能压缩 will start the next message fresh', async () => {
    const h = await createHarness({ configuredWorkspace: true, smartSession: true });
    const cwd = h.workspaces.cwdFor('chat-1')!;
    h.sessions.set('chat-1', 'sess-live', cwd);
    await writeTranscript(h, cwd, 'sess-live', { minutesAgo: 5, contextTokens: 20_000 });

    await expect(h.run('/status')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).not.toContain('自动开新会话');

    h.controls.pendingRotations = {
      get: (scope) => (scope === 'chat-1' ? { handle: 'sess-live', requestedAt: Date.now() } : undefined),
    };
    await expect(h.run('/status')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).toContain('下一条消息会自动开新会话（上一件事已完成）');

    h.controls.pendingRotations = { get: () => undefined };
    await writeTranscript(h, cwd, 'sess-live', { minutesAgo: 90, contextTokens: 200_000 });
    await expect(h.run('/status')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).toContain('缓存已过期且上下文偏大');
  });

  it('runs only self-checks when no cwd is selected', async () => {
    const h = await createHarness({ configuredWorkspace: false, bindWorkspace: false });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(0);
    expect(lastMarkdownOrText(h.channel)).toContain('未设置工作目录');
    expect(lastMarkdownOrText(h.channel)).toContain('self-check');
  });

  it('uses RunExecutor for a sessionless read-only agent echo check', async () => {
    const h = await createHarness({ configuredWorkspace: true });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(1);
    const opts = h.agent.runOptions[0]!;
    await expect(realpath(h.tmp.workspace)).resolves.toBe(opts.cwd);
    expect(opts.sessionId).toBeUndefined();
    expect(opts.threadId).toBeUndefined();
    expect(opts.images).toBeUndefined();
    expect(opts.permissionMode).toBe('plan');
    expect(opts.prompt).toContain('OK');
    const output = lastStreamCardJson(h.channel);
    expect(output).toContain('self-check');
    expect(output).toContain('profile');
    expect(output).toContain('claude');
    expect(output).toContain('workspace check');
    expect(output).toContain('policy check: ok permission=plan');
    expect(output).not.toContain('permission=bypassPermissions');
    expect(output).toContain('agent echo check');
    expect(output).toContain('OK');
  });

  it('uses the profile default workspace when the chat has no bound cwd', async () => {
    const h = await createHarness({
      configuredWorkspace: true,
      bindWorkspace: false,
      defaultWorkspace: true,
    });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(1);
    const opts = h.agent.runOptions[0]!;
    await expect(realpath(h.tmp.workspace)).resolves.toBe(opts.cwd);

    await expect(h.run('/status')).resolves.toBe(true);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain(jsonStringContent(h.tmp.workspace));
    expect(status).not.toContain('工作目录已选择');
  });

  it('fast-fails the agent echo check when the process pool is full', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    const release = await h.pool.acquire();

    await expect(h.run('/doctor')).resolves.toBe(true);

    release();
    expect(h.agent.runOptions).toHaveLength(0);
    expect(lastMarkdownOrText(h.channel)).toContain('pool-full');
  });
});

async function createHarness(options: {
  configuredWorkspace: boolean;
  bindWorkspace?: boolean;
  defaultWorkspace?: boolean;
  smartSession?: boolean;
}): Promise<Harness> {
  const tmp = await createTmpProfile('doctor-status-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 1);
  const agent = new FakeAgentAdapter({
    events: [[{ type: 'text', delta: 'OK' }, { type: 'done', terminationReason: 'normal' }]],
  });
  const profileConfig = appConfig(options.configuredWorkspace ? tmp.workspace : undefined);
  if (options.defaultWorkspace) {
    profileConfig.workspaces.default = tmp.workspace;
  }
  if (options.smartSession) profileConfig.preferences.smartSession = true;
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(tmp.root, 'claude-config'));
  const controls: Controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  };

  if (options.bindWorkspace !== false) {
    workspaces.setCwd('chat-1', tmp.workspace);
  }
  const executor = new RunExecutor({
    agent,
    pool,
    activeRuns,
    createRunId: () => 'doctor-run-1',
    now: () => 1_700_000_000_000,
    postDoneExitGraceMs: 10,
  });

  const run = (content: string): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      processPool: pool,
      runExecutor: executor,
      controls,
    });

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
    vi.unstubAllEnvs();
  });

  return { tmp, channel, sessions, workspaces, activeRuns, pool, agent, controls, run };
}

/** A Claude transcript whose last model call was `minutesAgo` with a `contextTokens` prompt. */
async function writeTranscript(
  h: Harness,
  cwd: string,
  sessionId: string,
  opts: { minutesAgo: number; contextTokens: number },
): Promise<void> {
  const project = join(h.tmp.root, 'claude-config', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  await mkdir(project, { recursive: true });
  const record = {
    type: 'assistant',
    timestamp: new Date(Date.now() - opts.minutesAgo * 60_000).toISOString(),
    message: { content: [], usage: { input_tokens: 0, cache_read_input_tokens: opts.contextTokens } },
  };
  await writeFile(join(project, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`);
}

function appConfig(defaultWorkspace: string | undefined): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
  });
  if (defaultWorkspace) config.workspaces.default = defaultWorkspace;
  return config;
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastMarkdownOrText(channel: FakeChannel): string {
  const content = lastContent(channel);
  const value = content.markdown ?? content.text;
  expect(value).toBeTypeOf('string');
  return value as string;
}

function lastStreamCardJson(channel: FakeChannel): string {
  const stream = channel.streams.at(-1);
  expect(stream).toBeDefined();
  const initial = (stream?.input as { card?: { initial?: unknown } } | undefined)?.card?.initial;
  return JSON.stringify(stream?.cardUpdates.at(-1) ?? initial);
}

function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
