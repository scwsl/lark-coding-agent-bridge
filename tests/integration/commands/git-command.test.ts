import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { git } from '../../../src/git/exec.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

async function gitOrThrow(cwd: string, args: string[]): Promise<void> {
  const result = await git(cwd, args);
  if (!result.ok) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

async function createHarness(opts: { repo?: boolean } = {}) {
  const tmp = await createTmpProfile('git-command-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();

  // createTmpProfile seeds a bare `.git` directory; a real repository has to
  // replace it for the git surface to behave like production.
  const repo = join(tmp.root, 'repo');
  await mkdir(repo, { recursive: true });
  if (opts.repo !== false) {
    await gitOrThrow(repo, ['init', '--initial-branch=main']);
    await gitOrThrow(repo, ['config', 'user.email', 'test@example.com']);
    await gitOrThrow(repo, ['config', 'user.name', 'Test']);
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    await gitOrThrow(repo, ['add', 'a.txt']);
    await gitOrThrow(repo, ['commit', '-m', 'init']);
  }
  const repoReal = await realpath(repo);

  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  profileConfig.workspaces.default = repoReal;

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
  } as unknown as Controls;

  workspaces.setCwd('chat-1', repoReal);

  const run = (content: string, senderId = 'ou-admin'): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: {
        messageId: `om-${Math.random().toString(16).slice(2)}`,
        chatId: 'chat-1',
        chatType: 'p2p',
        senderId,
        senderName: 'User',
        content,
        resources: [],
        mentions: [],
        mentionedBot: false,
      } as unknown as NormalizedMessage,
      scope: 'chat-1',
      chatMode: 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      controls,
    });

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, sessions, workspaces, activeRuns, repo: repoReal, run };
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as Record<string, unknown> | undefined;
  return typeof content?.markdown === 'string' ? content.markdown : '';
}

function cardJsonAt(channel: FakeChannel, index: number): string {
  const content = channel.sent.at(index)?.content as Record<string, unknown> | undefined;
  return JSON.stringify(content?.card ?? {});
}

describe('/diff', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('renders a card with per-file counts and untracked files', async () => {
    const h = await createHarness();
    await writeFile(join(h.repo, 'a.txt'), 'one\ntwo\nfour\nfive\n');
    await writeFile(join(h.repo, 'new.txt'), 'hello\n');

    await expect(h.run('/diff')).resolves.toBe(true);
    const card = cardJsonAt(h.channel, -1);
    expect(card).toContain('未提交的改动');
    expect(card).toContain('a.txt');
    expect(card).toContain('new.txt');
    // Short patches stay inline — no attachment message.
    expect(h.channel.sent).toHaveLength(1);
  });

  it('attaches the full patch when it does not fit inline', async () => {
    const h = await createHarness();
    await writeFile(join(h.repo, 'a.txt'), `${'changed line\n'.repeat(400)}`);

    await expect(h.run('/diff')).resolves.toBe(true);
    expect(h.channel.sent).toHaveLength(2);
    const attachment = h.channel.sent.at(-1)?.content as { file?: { fileName?: string } };
    expect(attachment.file?.fileName).toMatch(/\.patch$/);
  });

  it('rejects a ref that is not a ref, and reports unknown ones', async () => {
    const h = await createHarness();

    await expect(h.run('/diff --exec=boom')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不是合法的 ref');

    await expect(h.run('/diff no-such-branch')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toMatch(/unknown revision|ambiguous argument|git diff/i);
  });

  it('says so when the working directory is not a repository', async () => {
    const h = await createHarness({ repo: false });
    await expect(h.run('/diff')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不是 git 仓库');
  });

  it('is admin-only', async () => {
    const h = await createHarness();
    await expect(h.run('/diff', 'ou-stranger')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });
});

describe('/worktree', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('creates a worktree and moves the session into it', async () => {
    const h = await createHarness();
    h.sessions.set('chat-1', 'session-before', h.repo);

    await expect(h.run('/worktree add fix/bug-1')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已创建 worktree');

    const cwd = h.workspaces.cwdFor('chat-1');
    expect(cwd).toBeDefined();
    expect(cwd).not.toBe(h.repo);
    expect(cwd).toContain('repo-fix-bug-1');
    // Moving to a different checkout has to reset the session, exactly like /cd.
    expect(h.sessions.getRaw('chat-1')?.sessionId).toBeUndefined();

    await expect(h.run('/worktree')).resolves.toBe(true);
    expect(cardJsonAt(h.channel, -1)).toContain('fix/bug-1');
  });

  it('switches between existing worktrees', async () => {
    const h = await createHarness();
    await h.run('/worktree add fix/bug-1');
    const worktreeCwd = h.workspaces.cwdFor('chat-1');
    expect(h.workspaces.listManagedWorktrees()).toMatchObject([{ branch: 'fix/bug-1', ownedBranch: true, path: worktreeCwd }]);

    await expect(h.run('/worktree use main')).resolves.toBe(true);
    expect(h.workspaces.cwdFor('chat-1')).toBe(h.repo);

    await expect(h.run('/worktree use fix/bug-1')).resolves.toBe(true);
    expect(h.workspaces.cwdFor('chat-1')).toBe(worktreeCwd);

    await expect(h.run('/worktree use nope')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('没找到');
  });

  it('refuses to remove the main checkout or the tree it is standing in', async () => {
    const h = await createHarness();
    await h.run('/worktree add fix/bug-1');

    await expect(h.run('/worktree remove fix/bug-1')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('当前会话正在这个 worktree');

    await h.run('/worktree use main');
    await expect(h.run('/worktree remove main')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('主 checkout');

    await expect(h.run('/worktree remove fix/bug-1')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已删除 worktree');
    expect(h.workspaces.listManagedWorktrees()).toEqual([]);
  });

  it('rejects an unsafe branch name', async () => {
    const h = await createHarness();
    await expect(h.run('/worktree add --force')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不是合法的分支名');
  });
});

describe('/status', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('includes a git line for a repository workspace and omits it otherwise', async () => {
    const h = await createHarness();
    await writeFile(join(h.repo, 'a.txt'), 'changed\n');
    await expect(h.run('/status')).resolves.toBe(true);
    const card = cardJsonAt(h.channel, -1);
    expect(card).toContain('git');
    expect(card).toContain('main');
    expect(card).toContain('未暂存 1');

    const plain = await createHarness({ repo: false });
    await expect(plain.run('/status')).resolves.toBe(true);
    expect(cardJsonAt(plain.channel, -1)).not.toContain('🌿');
  });
});
