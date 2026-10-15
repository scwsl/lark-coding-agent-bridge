import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { loadRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { git } from '../../../src/git/exec.js';
import { KnowledgeAutoSync } from '../../../src/knowledge/auto-sync.js';
import { SkillLibraries } from '../../../src/knowledge/libraries.js';
import { KnowledgeStore } from '../../../src/knowledge/store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

async function createHarness(opts: { withKnowledge?: boolean; withLibraries?: boolean } = {}) {
  const tmp = await createTmpProfile('knowledge-command-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const store = new KnowledgeStore(join(tmp.profile, 'knowledge'));
  await store.ensure();

  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'], allowedUsers: ['ou-member'] },
  });
  profileConfig.workspaces.default = tmp.workspace;

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
    ...(opts.withKnowledge === false ? {} : { knowledge: store }),
  } as unknown as Controls;

  let libraries: SkillLibraries | undefined;
  if (opts.withLibraries) {
    // `/skills lib add|rm` persist through the profile (v2) config file.
    await saveRootConfig(
      { schemaVersion: 2, activeProfile: 'claude', preferences: {}, profiles: { claude: profileConfig } },
      controls.configPath,
    );
    libraries = new SkillLibraries({
      dir: join(tmp.profile, 'skill-libraries'),
      libraries: () => controls.profileConfig.skills?.libraries ?? [],
    });
    store.addSkillSource(libraries);
    controls.skillLibraries = libraries;
  }

  const run = (content: string, senderId = 'ou-admin'): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: {
        messageId: `om-${Math.random().toString(16).slice(2)}`,
        chatId: 'chat-1',
        chatType: 'group',
        senderId,
        senderName: 'User',
        content,
        resources: [],
        mentions: [],
        mentionedBot: false,
      } as unknown as NormalizedMessage,
      scope: 'chat-1',
      chatMode: 'group',
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

  return { tmp, channel, store, run, controls, libraries };
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as Record<string, unknown> | undefined;
  return typeof content?.markdown === 'string' ? content.markdown : '';
}

function lastCardJson(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as Record<string, unknown> | undefined;
  return JSON.stringify(content?.card ?? {});
}

describe('/memory', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('records, lists and forgets a chat note', async () => {
    const h = await createHarness();

    await expect(h.run('/memory add 这个群里 deploy 指的是 staging')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已记住（本会话）');
    const entries = await h.store.listMemories({ kind: 'chat', scopeId: 'chat-1' });
    expect(entries).toHaveLength(1);

    await expect(h.run('/memory')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('deploy');

    await expect(h.run(`/memory forget ${entries[0]!.id}`)).resolves.toBe(true);
    expect(await h.store.listMemories({ kind: 'chat', scopeId: 'chat-1' })).toHaveLength(0);
  });

  it('lets a non-admin member write chat notes but not global ones', async () => {
    const h = await createHarness();

    await expect(h.run('/memory add 本会话的约定', 'ou-member')).resolves.toBe(true);
    expect(await h.store.listMemories({ kind: 'chat', scopeId: 'chat-1' })).toHaveLength(1);

    await expect(h.run('/memory add --global 全局约定', 'ou-member')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员');
    expect(await h.store.listMemories({ kind: 'profile' })).toHaveLength(0);

    await expect(h.run('/memory add --global 全局约定')).resolves.toBe(true);
    expect(await h.store.listMemories({ kind: 'profile' })).toMatchObject([{ text: '全局约定' }]);
  });

  it('will not let a member delete a global note by guessing its id', async () => {
    const h = await createHarness();
    await h.run('/memory add --global 全局约定');
    const [global] = await h.store.listMemories({ kind: 'profile' });

    await expect(h.run(`/memory forget ${global!.id}`, 'ou-member')).resolves.toBe(true);
    expect(await h.store.listMemories({ kind: 'profile' })).toHaveLength(1);

    await expect(h.run(`/memory forget ${global!.id}`)).resolves.toBe(true);
    expect(await h.store.listMemories({ kind: 'profile' })).toHaveLength(0);
  });

  it('clears one scope at a time', async () => {
    const h = await createHarness();
    await h.run('/memory add 一');
    await h.run('/memory add 二');
    await h.run('/memory add --global 全局');

    await expect(h.run('/memory clear')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已清空 2 条');
    expect(await h.store.listMemories({ kind: 'profile' })).toHaveLength(1);
  });

  it('says so when the bridge has no knowledge store', async () => {
    const h = await createHarness({ withKnowledge: false });
    await expect(h.run('/memory')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('没有启用知识库');
  });
});

describe('/skills', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('lists skills and shows one', async () => {
    const h = await createHarness();
    await mkdir(join(h.store.skillsDir, 'deploy'), { recursive: true });
    await writeFile(
      join(h.store.skillsDir, 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: 发布步骤\n---\n\n第一步：跑测试\n',
    );

    await expect(h.run('/skills')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('发布步骤');

    await expect(h.run('/skills show deploy')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('第一步：跑测试');

    await expect(h.run('/skills show ../../etc/passwd')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('没找到 skill');
  });

  it('points at the directory when there are none', async () => {
    const h = await createHarness();
    await expect(h.run('/skills')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('SKILL.md');
  });
});

describe('/knowledge', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('reports status, binds a remote and syncs', async () => {
    const h = await createHarness();
    await h.run('/memory add 一条记忆');

    await expect(h.run('/knowledge')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('未绑定');

    const remote = join(h.tmp.root, 'remote.git');
    await mkdir(remote, { recursive: true });
    const init = await git(remote, ['init', '--bare', '--initial-branch=main']);
    expect(init.ok).toBe(true);

    await expect(h.run(`/knowledge bind ${remote}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已绑定远端');

    await expect(h.run('/knowledge sync')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已推送');

    await expect(h.run('/knowledge')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain(remote);
  });

  it('shows the auto-sync interval and the last failure, and a manual sync ends the streak', { timeout: 30_000 }, async () => {
    const h = await createHarness();
    const remote = join(h.tmp.root, 'remote.git');
    await mkdir(remote, { recursive: true });
    expect((await git(remote, ['init', '--bare', '--initial-branch=main'])).ok).toBe(true);
    await h.run(`/knowledge bind ${remote}`);
    expect(lastMarkdown(h.channel)).toContain('30 分钟自动同步');

    const dms: string[] = [];
    const auto = new KnowledgeAutoSync({
      store: h.store,
      intervalMinutes: () => 30,
      owner: () => 'ou-owner',
      send: async (_to, text) => {
        dms.push(text);
      },
    });
    h.controls.knowledgeAutoSync = auto;
    await rename(remote, `${remote}.gone`);
    await auto.tick();
    await auto.tick();
    expect(dms).toHaveLength(1);

    await h.run('/knowledge');
    const card = lastCardJson(h.channel);
    expect(card).toContain('每 30 分钟');
    expect(card).toContain('上次同步失败');
    expect(card).toContain('连续失败 2 次');
    expect(card).toContain('fatal:');

    await rename(`${remote}.gone`, remote);
    await h.run('/knowledge sync');
    expect(lastMarkdown(h.channel)).toContain('已推送');
    expect(auto.status()).toMatchObject({ failures: 0, last: { trigger: 'manual', ok: true } });
    await h.run('/knowledge');
    expect(lastCardJson(h.channel)).toContain('手动');
    // The manual success is not followed by a "recovered" DM.
    expect(dms).toHaveLength(1);
  });

  it('says auto-sync is off when the interval is 0', async () => {
    const h = await createHarness();
    h.controls.profileConfig.knowledge = { syncIntervalMinutes: 0 };
    const remote = join(h.tmp.root, 'remote.git');
    await mkdir(remote, { recursive: true });
    expect((await git(remote, ['init', '--bare', '--initial-branch=main'])).ok).toBe(true);
    await h.run(`/knowledge bind ${remote}`);
    expect(lastMarkdown(h.channel)).not.toContain('自动同步');

    await h.run('/knowledge');
    expect(lastCardJson(h.channel)).toContain('已关闭');
    await h.run('/knowledge help');
    expect(lastMarkdown(h.channel)).toContain('自动同步已关闭');
  });

  it('rejects a bogus remote and is admin-only', async () => {
    const h = await createHarness();

    await expect(h.run('/knowledge bind not-a-url')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('绑定失败');

    await expect(h.run('/knowledge sync', 'ou-member')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });
});

describe('/skills lib', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function libraryRepo(root: string, skills: Record<string, string>): Promise<string> {
    const repo = join(root, 'team-skills');
    await mkdir(repo, { recursive: true });
    await git(repo, ['init', '-q', '--initial-branch=main']);
    for (const [name, description] of Object.entries(skills)) {
      await mkdir(join(repo, 'skills', name), { recursive: true });
      await writeFile(join(repo, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`);
    }
    await git(repo, ['add', '-A']);
    const commit = await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init']);
    if (!commit.ok) throw new Error(commit.stderr);
    return repo;
  }

  it('adds a library, lists it, syncs and removes it', async () => {
    const h = await createHarness({ withLibraries: true });
    await mkdir(join(h.store.skillsDir, 'deploy'), { recursive: true });
    await writeFile(join(h.store.skillsDir, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: 自己的\n---\n');
    const repo = await libraryRepo(h.tmp.root, { deploy: '库里的', triage: '排查流程' });

    await expect(h.run(`/skills lib add ${repo}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已添加 skill 库 `team-skills`');
    expect(lastMarkdown(h.channel)).toContain('载入 1 个 skill');
    expect(lastMarkdown(h.channel)).toContain('同名已存在');
    // Saved to the config file, not only in memory.
    const saved = await loadRootConfig(h.controls.configPath);
    expect(saved?.profiles.claude?.skills?.libraries).toEqual([{ name: 'team-skills', url: repo }]);

    await expect(h.run('/skills')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('排查流程');
    expect(lastCardJson(h.channel)).toContain('team-skills');

    await expect(h.run('/skills show triage')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('排查流程');

    await expect(h.run('/skills lib')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('triage');

    await expect(h.run(`/skills lib add ${repo}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已经有叫');

    await expect(h.run('/skills lib sync')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已是最新');

    await expect(h.run('/skills lib rm team-skills')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已移除');
    expect((await loadRootConfig(h.controls.configPath))?.profiles.claude?.skills?.libraries ?? []).toEqual([]);
    expect((await h.store.listSkills()).map((skill) => skill.name)).toEqual(['deploy']);
  });

  it('does not save a library that cannot be fetched', async () => {
    const h = await createHarness({ withLibraries: true });

    await expect(h.run(`/skills lib add ${join(h.tmp.root, 'missing-repo')} broken`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('拉取 `broken` 失败');
    expect((await loadRootConfig(h.controls.configPath))?.profiles.claude?.skills).toBeUndefined();

    await expect(h.run('/skills lib add not-a-url')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不像 git 仓库地址');

    await expect(h.run('/skills lib add /srv/x --path ../../etc')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不合法');
  });

  it('is admin-only', async () => {
    const h = await createHarness({ withLibraries: true });
    const repo = await libraryRepo(h.tmp.root, { triage: '排查流程' });

    await expect(h.run(`/skills lib add ${repo}`, 'ou-member')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员');
    expect(h.controls.profileConfig.skills).toBeUndefined();

    // Listing what got loaded stays open to everyone.
    await expect(h.run('/skills', 'ou-member')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('Skills');
  });
});
