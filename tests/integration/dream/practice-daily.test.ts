import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QuotaReading } from '../../../src/agent/quota.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import type { AppConfig } from '../../../src/config/schema.js';
import { collectExternalMaterial, fetchExternalLibrary } from '../../../src/dream/external.js';
import { prepareCheckout, pushDirect, writeChangelog } from '../../../src/dream/publish.js';
import { DreamService } from '../../../src/dream/service.js';
import { git } from '../../../src/git/exec.js';
import { KnowledgeStore, type SkillSummary } from '../../../src/knowledge/store.js';
import { bindKnowledgeRemote } from '../../../src/knowledge/sync.js';
import type { RunExecution, SubmitRunInput } from '../../../src/runtime/run-executor.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { installFakeGh } from './fake-gh.js';

const TIMEOUT = 60_000;
/** 04:10 UTC: inside a 04:00 daily window in UTC. */
const NOW = Date.parse('2026-10-16T04:10:00Z');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

let root: string;
let gh: Awaited<ReturnType<typeof installFakeGh>>;
const disposers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lcb-practice-'));
  gh = await installFakeGh(root);
});

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  gh.restore();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

async function bareRemote(name: string, files: Record<string, string> = {}): Promise<string> {
  const remote = join(root, `${name}.git`);
  await mkdir(remote, { recursive: true });
  await git(remote, ['init', '-q', '--bare', '--initial-branch=main']);
  if (Object.keys(files).length > 0) await pushFiles(remote, files, 'seed');
  return remote;
}

/** Commit `files` on top of the remote's main from a scratch clone. */
async function pushFiles(remote: string, files: Record<string, string>, message: string): Promise<void> {
  const work = await mkdtemp(join(root, 'work-'));
  const cloned = await git(root, ['clone', '-q', remote, work]);
  if (!cloned.ok) await git(work, ['init', '-q', '--initial-branch=main']);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(work, path, '..'), { recursive: true });
    await writeFile(join(work, path), content);
  }
  await git(work, ['add', '-A']);
  await git(work, [...ID, 'commit', '-q', '-m', message]);
  const pushed = await git(work, ['push', '-q', remote, 'HEAD:refs/heads/main']);
  expect(pushed.ok).toBe(true);
}

async function showFile(remote: string, ref: string, path: string): Promise<string> {
  const shown = await git(remote, ['show', `${ref}:${path}`]);
  return shown.ok ? shown.stdout : '';
}

async function branches(remote: string): Promise<string[]> {
  const listed = await git(remote, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return listed.stdout.split('\n').filter(Boolean);
}

const SKILL = (name: string, hint?: string) =>
  `---\nname: ${name}\ndescription: ${name} 说明\n${hint ? `argument-hint: ${hint}\n` : ''}---\n\n## 步骤\n1. 做事\n`;

describe('external libraries', { timeout: TIMEOUT }, () => {
  it('reads everything the first time, then only what changed, spreading over-budget files to later runs', async () => {
    const remote = await bareRemote('cc', {
      'skills/show-status/SKILL.md': SKILL('show-status'),
      'notes/ops.md': '熔断打开时接口返回 200 + 空数据',
      'README.md': 'readme',
      'scripts/run.sh': 'echo hi',
      '.github/x.md': 'hidden',
    });
    const dir = join(root, 'mirror', 'cc');
    const first = await fetchExternalLibrary({ name: 'cc', url: remote }, dir);
    if ('error' in first) throw new Error(first.error);
    const all = await collectExternalMaterial({ library: 'cc', dir, head: first.head, budget: 100_000, startRef: 1 });
    expect(all.full).toBe(true);
    expect(all.files.map((file) => [file.ref, file.path])).toEqual([
      ['X1', 'skills/show-status/SKILL.md'],
      ['X2', 'notes/ops.md'],
      ['X3', 'README.md'],
    ]);

    await pushFiles(remote, { 'notes/ops.md': '熔断打开时先查熔断', 'notes/new.md': 'x'.repeat(50) }, 'more');
    const second = await fetchExternalLibrary({ name: 'cc', url: remote }, dir);
    if ('error' in second) throw new Error(second.error);
    expect(second.head).not.toBe(first.head);
    const cursor = { commit: first.head, learnedAt: 0 };
    // Budget for one file only: the first is read (cut to fit), the other waits.
    const changed = await collectExternalMaterial({ library: 'cc', dir, head: second.head, cursor, budget: 20, startRef: 7 });
    expect(changed.full).toBe(false);
    expect(changed.files.map((file) => [file.ref, file.path, file.truncated])).toEqual([['X7', 'notes/new.md', true]]);
    expect(changed.pending).toEqual(['notes/ops.md']);
    const rest = await collectExternalMaterial({
      library: 'cc',
      dir,
      head: second.head,
      cursor: { commit: second.head, learnedAt: 0, pending: changed.pending },
      budget: 100_000,
      startRef: 1,
    });
    expect(rest.files.map((file) => file.path)).toEqual(['notes/ops.md']);
    expect(rest.pending).toEqual([]);
  });

  it('says so when the repository cannot be read', async () => {
    const result = await fetchExternalLibrary({ name: 'gone', url: join(root, 'missing.git') }, join(root, 'mirror', 'gone'));
    expect(result).toHaveProperty('error');
  });
});

describe('publish: push', { timeout: TIMEOUT }, () => {
  it('commits onto main, rebases once when the remote moved, and keeps the changelog newest first', async () => {
    const remote = await bareRemote('k', { 'README.md': 'r' });
    const dir = join(root, 'checkout');
    const prepared = await prepareCheckout({ repo: 'knowledge', label: '知识库', url: remote }, dir, 'dream/x', { direct: true });
    expect(prepared).toEqual({ base: 'main' });
    await writeFile(join(dir, 'a.md'), 'a');
    expect(await writeChangelog(dir, '## 第一批\n\n- a')).toEqual({ file: 'CHANGELOG.md' });
    expect(await writeChangelog(dir, '## 第二批\n\n- b')).toEqual({ file: 'CHANGELOG.md' });
    const log = await readFile(join(dir, 'CHANGELOG.md'), 'utf8');
    expect(log.indexOf('第二批')).toBeLessThan(log.indexOf('第一批'));
    expect(log).toMatch(/^# 更新日志/);
    await git(dir, ['add', '-A']);
    await git(dir, [...ID, 'commit', '-q', '-m', 'batch']);

    // Someone else pushed meanwhile.
    await pushFiles(remote, { 'other.md': 'o' }, 'other');
    const pushed = await pushDirect(dir, 'main', join(root, 'no-hooks'));
    if ('error' in pushed) throw new Error(pushed.error);
    expect(await showFile(remote, 'main', 'a.md')).toBe('a');
    expect(await showFile(remote, 'main', 'other.md')).toBe('o');
    expect((await git(remote, ['rev-parse', 'main'])).stdout.trim()).toBe(pushed.commit);
    expect(await branches(remote)).toEqual(['main']);
    // Pushing the same commit again is a no-op success.
    expect(await pushDirect(dir, 'main', join(root, 'no-hooks'))).toEqual({ commit: pushed.commit });
  });
});

interface HarnessOptions {
  answer: (prompt: string) => string;
  /** Open dream PRs `gh` reports per repository. Default 5. */
  openPrs?: number;
  quota?: QuotaReading;
  /** dreamTuning on top of the harness's own. */
  tuning?: Record<string, unknown>;
  /** The profile has a task running. Default never. */
  busy?: () => boolean;
  /** The agent pool is full. Absent: the service goes by {@link busy} alone. */
  tight?: () => boolean;
}

async function harness(opts: HarnessOptions) {
  const knowledgeRemote = await bareRemote('knowledge');
  const skillsRemote = await bareRemote('skills', { 'skills/deploy/SKILL.md': SKILL('deploy') });
  const externalRemote = await bareRemote('cc', {
    'skills/show-status/SKILL.md': SKILL('show-status'),
    'notes/ops.md': '熔断打开时接口返回 200 + 空数据，页面空白时先查熔断',
  });
  const localSkills = join(root, 'local-skills');
  await mkdir(join(localSkills, 'sn-platform'), { recursive: true });
  await writeFile(join(localSkills, 'sn-platform', 'SKILL.md'), SKILL('sn-platform', '"<SN>"'));

  const store = new KnowledgeStore(join(root, 'profile', 'knowledge'));
  await store.ensure();
  expect(await bindKnowledgeRemote(store, knowledgeRemote)).not.toHaveProperty('error');
  // The own library as the profile sees it (the mirror in production).
  const ownSkillFile = join(root, 'own-mirror', 'deploy', 'SKILL.md');
  await mkdir(join(ownSkillFile, '..'), { recursive: true });
  await writeFile(ownSkillFile, SKILL('deploy'));
  store.addSkillSource({
    listSkills: async (): Promise<SkillSummary[]> => [{ name: 'deploy', description: 'deploy 说明', path: ownSkillFile, source: 'occam' }],
  });

  const profileConfig: ProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  profileConfig.skills = { libraries: [{ name: 'occam', url: skillsRemote }] };
  const appConfig = {
    accounts: { app: { id: 'app-id', secret: 'secret' } },
    preferences: {
      dream: true,
      dreamAuto: true,
      dreamTuning: {
        minIdleMinutes: 0,
        timezone: 'UTC',
        dailyAt: '04:00',
        quotaWindow: 'week',
        publish: 'push',
        requireArgumentHint: true,
        notifyChat: 'ou_owner',
        skillLibrary: 'occam',
        localSkillDirs: [localSkills],
        externalLibraries: [{ name: 'cc', url: externalRemote }],
        ...opts.tuning,
      },
    },
  } as unknown as AppConfig;

  const prompts: string[] = [];
  const executor = {
    async submit(input: SubmitRunInput): Promise<RunExecution> {
      prompts.push(input.policy.prompt);
      const text = opts.answer(input.policy.prompt);
      return {
        runId: 'r',
        scopeId: input.scopeId,
        subscribe: async function* () {
          yield { type: 'final_text', content: text } as AgentEvent;
          yield { type: 'done', terminationReason: 'normal' } as AgentEvent;
        },
        stop: async () => undefined,
      } as unknown as RunExecution;
    },
    async closeIdleScope() {},
  };
  const published: string[] = [];
  const told: Array<{ chat: string; text: string }> = [];
  const service = new DreamService({
    profile: 'claude',
    stateFile: join(root, 'profile', 'dream-state.json'),
    workDir: join(root, 'profile', 'dream'),
    knowledge: store,
    sessionCatalog: new SessionCatalog(join(root, 'profile', 'catalog.json')),
    executor,
    appConfig: () => appConfig,
    profileConfig: () => profileConfig,
    isAdmin: (id) => id === 'ou-admin',
    isScopeBusy: () => false,
    readTranscript: async () => undefined,
    isProfileBusy: opts.busy ?? (() => false),
    ...(opts.tight ? { isCapacityTight: opts.tight } : {}),
    readQuota: async () => opts.quota ?? { windows: [{ label: '5 小时窗口', usedPercent: 95 }, { label: '本周', usedPercent: 40 }] },
    countOpenPrs: async () => opts.openPrs ?? 5,
    afterPublish: async (repo) => {
      published.push(repo);
    },
    notify: async (chat, text) => {
      told.push({ chat, text });
    },
    autoCheckMs: 0,
    now: () => NOW,
  });
  await service.init();
  disposers.push(() => service.dispose());
  return { service, prompts, published, told, knowledgeRemote, skillsRemote, externalRemote, ownSkillFile };
}

const LEARNED = JSON.stringify({
  memory: [
    { action: 'add', target: 'note', note: 'circuit-breaker', text: '熔断打开时接口返回 200 + 空数据，页面空白先查熔断', reason: '排障结论', sources: ['X2'] },
  ],
  skills: [
    {
      action: 'create',
      name: 'status-panel',
      description: '机器状态面板',
      body: SKILL('status-panel', '"（无参数）"'),
      reason: '学自 CC 的 show-status',
      sources: ['X1'],
    },
    { action: 'update', name: 'deploy', description: 'deploy 说明', body: SKILL('deploy', '"[环境]"'), reason: '补 argument-hint', sources: ['OWN'] },
    { action: 'create', name: 'sn-platform', description: '重复', body: SKILL('sn-platform', '"<SN>"'), reason: 'x', sources: ['X1'] },
  ],
});

describe('课堂精练 每日模式 with 课前学习 and publish: push', { timeout: TIMEOUT }, () => {
  it('learns from the external library, fixes own skills, pushes to main with changelogs and tells the owner', async () => {
    const clone = join(root, 'local-occam');
    const unrelated = join(root, 'local-other');
    const h = await harness({ answer: () => LEARNED, tuning: { localClones: [clone, unrelated, join(root, 'missing')] } });
    expect((await git(root, ['clone', '-q', h.skillsRemote, clone])).ok).toBe(true);
    expect((await git(root, ['clone', '-q', h.externalRemote, unrelated])).ok).toBe(true);

    const check = await h.service.checkAuto();
    // No conversations at all, five open PRs and a full 5-hour window: 每日模式 with push and the weekly window still starts.
    expect(check.started).toBeDefined();
    await h.service.idle();
    const run = h.service.runs()[0]!;
    expect(run.status).toBe('succeeded');
    expect(run.trigger).toBe('auto');
    expect(run.targets.map((target) => [target.repo, target.phase, target.direct])).toEqual([
      ['knowledge', 'published', true],
      ['skills:occam', 'published', true],
    ]);
    expect(run.external).toEqual([{ library: 'cc', head: expect.stringMatching(/^[0-9a-f]{40}$/), files: 2, pending: 0 }]);

    // One learning turn, which saw the files, the own skill lacking its hint and the local skills.
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain('<external_files>');
    expect(h.prompts[0]).toContain('<missing_argument_hint>');
    expect(h.prompts[0]).toContain('sn-platform');

    expect(await branches(h.knowledgeRemote)).toEqual(['main']);
    expect(await showFile(h.knowledgeRemote, 'main', 'notes/external/circuit-breaker.md')).toContain('先查熔断');
    const knowledgeLog = await showFile(h.knowledgeRemote, 'main', 'CHANGELOG.md');
    expect(knowledgeLog).toContain('（自动）');
    expect(knowledgeLog).toMatch(/课前学习 cc@[0-9a-f]{7}（2 个文件）/);
    expect(knowledgeLog).toContain('笔记 `notes/external/circuit-breaker.md`');

    expect(await branches(h.skillsRemote)).toEqual(['main']);
    expect(await showFile(h.skillsRemote, 'main', 'skills/status-panel/SKILL.md')).toContain('argument-hint');
    expect(await showFile(h.skillsRemote, 'main', 'skills/deploy/SKILL.md')).toContain('argument-hint: "[环境]"');
    expect(await showFile(h.skillsRemote, 'main', 'skills/sn-platform/SKILL.md')).toBe('');
    const skillsLog = await showFile(h.skillsRemote, 'main', 'CHANGELOG.md');
    expect(skillsLog).toContain('新建技能 `status-panel`');
    expect(skillsLog).toContain('更新技能 `deploy`');

    expect(h.published).toEqual(['knowledge', 'skills:occam']);
    // The local clone of the skill library is fast-forwarded; a clone of another repository is left alone.
    expect(await readFile(join(clone, 'skills', 'status-panel', 'SKILL.md'), 'utf8')).toContain('argument-hint');
    expect((await git(unrelated, ['log', '--oneline'])).stdout.trim().split('\n')).toHaveLength(1);
    expect(h.told).toHaveLength(1);
    expect(h.told[0]).toMatchObject({ chat: 'ou_owner' });
    expect(h.told[0]!.text).toContain('课前学习 cc：读了 2 个文件');

    const status = await h.service.status();
    expect(status.external[0]).toMatchObject({ name: 'cc', cursor: { commit: run.external![0]!.head, pending: 0 } });

    // Same day: once is enough.
    expect(await h.service.checkAuto()).toMatchObject({ block: 'window-used' });

    // Next manual run with nothing new (own skill fixed meanwhile): no agent turn at all.
    await writeFile(h.ownSkillFile, SKILL('deploy', '"[环境]"'));
    const again = await h.service.start({ id: 'ou-admin' });
    if ('error' in again) throw new Error(again.error);
    await h.service.idle();
    expect(h.prompts).toHaveLength(1);
    expect(h.service.runs()[0]!.note).toContain('课前学习没有值得吸收的新内容');

    // The library moves on: only the changed file is read.
    await pushFiles(h.externalRemote, { 'notes/ops.md': '夜间光伏低于 100W 显示为 0' }, 'update');
    const third = await h.service.start({ id: 'ou-admin' });
    if ('error' in third) throw new Error(third.error);
    await h.service.idle();
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toContain('夜间光伏低于 100W');
    expect(h.prompts[1]).not.toContain('skills/show-status/SKILL.md');
  });

  it('with skillUpdates: pr, pushes new skills but opens a Draft PR for rewrites of existing ones', async () => {
    const h = await harness({ answer: () => LEARNED, tuning: { skillUpdates: 'pr' }, openPrs: 0 });
    const started = await h.service.start({ id: 'ou-admin' });
    if ('error' in started) throw new Error(started.error);
    await h.service.idle();
    const run = h.service.runs()[0]!;
    expect(run.targets.map((target) => [target.repo, target.phase])).toEqual([
      ['knowledge', 'published'],
      ['skills:occam', 'published'],
      ['skills:occam:update', 'pr-created'],
    ]);
    // main has the new skill and the changelog, not the rewrite
    expect(await showFile(h.skillsRemote, 'main', 'skills/status-panel/SKILL.md')).toContain('argument-hint');
    expect(await showFile(h.skillsRemote, 'main', 'skills/deploy/SKILL.md')).not.toContain('argument-hint');
    expect(await showFile(h.skillsRemote, 'main', 'CHANGELOG.md')).not.toContain('更新技能 `deploy`');
    // the rewrite waits on its own branch for review
    expect(await showFile(h.skillsRemote, `dream/${run.id}`, 'skills/deploy/SKILL.md')).toContain('argument-hint: "[环境]"');
    expect(await showFile(h.skillsRemote, `dream/${run.id}`, 'CHANGELOG.md')).toBe('');
    expect(h.published).toEqual(['knowledge', 'skills:occam']);
  });

  it('holds back rewrites while the last rewrite PR is still open', async () => {
    const h = await harness({ answer: () => LEARNED, tuning: { skillUpdates: 'pr' }, openPrs: 1 });
    const started = await h.service.start({ id: 'ou-admin' });
    if ('error' in started) throw new Error(started.error);
    await h.service.idle();
    const update = h.service.runs()[0]!.targets.find((target) => target.repo === 'skills:occam:update');
    expect(update).toMatchObject({ phase: 'skipped', error: expect.stringContaining('没审完') });
    expect(await branches(h.skillsRemote)).toEqual(['main']);
  });

  it('skips the day once the weekly window is over the limit, and says so once', async () => {
    const h = await harness({ answer: () => LEARNED, quota: { windows: [{ label: '5 小时窗口', usedPercent: 5 }, { label: '本周', usedPercent: 85 }] } });
    const check = await h.service.checkAuto();
    expect(check).toMatchObject({ block: 'quota' });
    expect(check.reason).toContain('85%');
    expect(h.told).toHaveLength(1);
    expect(h.told[0]!.text).toContain('今天的课堂精练跳过');
    expect(await h.service.checkAuto()).toMatchObject({ block: 'window-used' });
    expect(h.told).toHaveLength(1);
    expect(h.prompts).toHaveLength(0);
  });

  it('goes ahead over the limit when the weekly window resets today before quotaResetBefore', async () => {
    const h = await harness({
      answer: () => LEARNED,
      tuning: { quotaResetBefore: '10:00' },
      quota: { windows: [{ label: '本周', usedPercent: 92, resets: 'Oct 16 at 9am (UTC)' }] },
    });
    const check = await h.service.checkAuto();
    expect(check.started).toBeDefined();
    await h.service.idle();
    expect(h.service.runs()[0]!.note).toContain('今天 10:00 前就重置，照常整理');
    expect(h.told[0]!.text).toContain('照常整理');
  });

  it('still skips when the reset is not before quotaResetBefore today', async () => {
    const h = await harness({
      answer: () => LEARNED,
      tuning: { quotaResetBefore: '10:00' },
      quota: { windows: [{ label: '本周', usedPercent: 92, resets: 'Oct 20 at 9am (UTC)' }] },
    });
    expect(await h.service.checkAuto()).toMatchObject({ block: 'quota' });
    expect(h.prompts).toHaveLength(0);
  });

  it('reports an unreadable external library and goes on', async () => {
    const h = await harness({
      answer: () => LEARNED,
      tuning: { externalLibraries: [{ name: 'locked', url: join(root, 'nope.git') }] },
    });
    const started = await h.service.start({ id: 'ou-admin' });
    if ('error' in started) throw new Error(started.error);
    await h.service.idle();
    const run = h.service.runs()[0]!;
    expect(run.external?.[0]).toMatchObject({ library: 'locked', files: 0, error: expect.stringContaining('拉取失败') });
    // The own skill still lacks its hint: the learning turn runs for that alone.
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain('<missing_argument_hint>');
    expect(run.status).toBe('succeeded');
  });
});

const NOTHING = JSON.stringify({ memory: [], skills: [] });

/** `count` notes of `size` characters each. */
function notes(count: number, size: number, prefix = 'n'): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`notes/${prefix}${i}.md`, `${prefix}${i} `.padEnd(size, '知')]));
}

describe('课堂精练 续跑', { timeout: TIMEOUT }, () => {
  it('keeps running until the external library is read through, one card per run', async () => {
    const big = await bareRemote('big', notes(6, 2_000));
    const h = await harness({ answer: () => NOTHING, tuning: { maxInputChars: 10_000, externalLibraries: [{ name: 'big', url: big }] } });
    const started = await h.service.start({ id: 'ou-admin' }, () => undefined);
    if ('error' in started) throw new Error(started.error);
    await h.service.idle();
    const runs = [...h.service.runs()].reverse();
    // 5 000 characters per run: two notes each, three runs in a row.
    expect(runs.map((run) => [run.status, run.round ?? 1, run.external?.[0]?.files, run.external?.[0]?.pending])).toEqual([
      ['succeeded', 1, 2, 4],
      ['succeeded', 2, 2, 2],
      ['succeeded', 3, 2, 0],
    ]);
    expect(runs[1]!.note).toContain('续跑第 2 轮');
    expect(runs[1]!.note).toContain('4 个外部库文件');
    expect(h.prompts).toHaveLength(3);
    const status = await h.service.status();
    expect(status.external[0]).toMatchObject({ name: 'big', cursor: { pending: 0 } });
  });

  it('stops at drainRounds', async () => {
    const big = await bareRemote('big', notes(6, 2_000));
    const h = await harness({
      answer: () => NOTHING,
      tuning: { maxInputChars: 10_000, drainRounds: 2, externalLibraries: [{ name: 'big', url: big }] },
    });
    const started = await h.service.start({ id: 'ou-admin' });
    if ('error' in started) throw new Error(started.error);
    await h.service.idle();
    expect(h.service.runs().map((run) => run.external?.[0]?.pending)).toEqual([2, 4]);
  });

  it('gives a library with nothing new no share of the budget', async () => {
    const big = await bareRemote('big', notes(4, 2_000));
    const quiet = await bareRemote('quiet', { 'notes/old.md': 'old' });
    const h = await harness({
      answer: () => NOTHING,
      tuning: {
        maxInputChars: 10_000,
        drainRounds: 1,
        externalLibraries: [
          { name: 'quiet', url: quiet },
          { name: 'big', url: big },
        ],
      },
    });
    // The quiet library is read once, so it has nothing new the next time.
    const first = await h.service.start({ id: 'ou-admin' });
    if ('error' in first) throw new Error(first.error);
    await h.service.idle();
    await pushFiles(big, notes(4, 2_000, 'm'), 'more');
    const second = await h.service.start({ id: 'ou-admin' });
    if ('error' in second) throw new Error(second.error);
    await h.service.idle();
    const run = h.service.runs()[0]!;
    // Half of 10 000 all to the library with news: two notes, not one.
    expect(run.external).toEqual([
      { library: 'quiet', head: expect.any(String), files: 0, pending: 0 },
      { library: 'big', head: expect.any(String), files: 2, pending: 4 },
    ]);
  });

  it('an automatic chain cut short by a user task picks up again once the profile is idle', async () => {
    const big = await bareRemote('big', notes(4, 2_000));
    let busy = false;
    let turns = 0;
    const h = await harness({
      answer: () => {
        // A user shows up while the first run is learning.
        if (++turns === 1) busy = true;
        return NOTHING;
      },
      busy: () => busy,
      tuning: { maxInputChars: 10_000, externalLibraries: [{ name: 'big', url: big }] },
    });
    const check = await h.service.checkAuto();
    expect(check.started).toBeDefined();
    await h.service.idle();
    expect(h.service.runs().map((run) => [run.status, run.external?.[0]?.pending])).toEqual([['succeeded', 2]]);

    // Still busy: the check waits.
    expect(await h.service.checkAuto()).toMatchObject({ block: 'busy' });
    busy = false;
    const resumed = await h.service.checkAuto();
    expect(resumed.started).toBeDefined();
    await h.service.idle();
    const latest = h.service.runs()[0]!;
    expect([latest.status, latest.round, latest.external?.[0]?.pending]).toEqual(['succeeded', 2, 0]);
    expect(latest.note).toContain('续跑第 2 轮');
    // Done: back to one run per window, and the window was not used up by the 续跑.
    expect(await h.service.checkAuto()).toMatchObject({ block: 'window-used' });
    expect(h.told.map((item) => item.text.split('\n')[0])).toHaveLength(2);
  });

  it('going by the pool, a busy profile does not hold it back; only a full pool does', async () => {
    const big = await bareRemote('big', notes(6, 2_000));
    let tight = false;
    let turns = 0;
    const h = await harness({
      answer: () => {
        // The pool fills up during the second run.
        if (++turns === 2) tight = true;
        return NOTHING;
      },
      busy: () => true, // topics, groups, scheduled jobs: always something running
      tight: () => tight,
      tuning: { maxInputChars: 10_000, externalLibraries: [{ name: 'big', url: big }] },
    });
    const check = await h.service.checkAuto();
    expect(check.started).toBeDefined();
    await h.service.idle();
    const runs = [...h.service.runs()].reverse();
    // The first run and its 续跑 ran although the profile was busy; the full pool stopped the chain after the second.
    expect(runs.map((run) => [run.status, run.round ?? 1, run.external?.[0]?.pending])).toEqual([
      ['succeeded', 1, 4],
      ['succeeded', 2, 2],
    ]);
    expect(await h.service.checkAuto()).toMatchObject({ block: 'busy', reason: expect.stringContaining('进程池已满') });
    // Room again: the rest is read.
    tight = false;
    expect((await h.service.checkAuto()).started).toBeDefined();
    await h.service.idle();
    expect(h.service.runs()[0]).toMatchObject({ status: 'succeeded', round: 3 });
    expect(h.service.runs()[0]!.external?.[0]?.pending).toBe(0);
    // A user message does not stop a run while slots are free.
    expect(h.service.preempt('有新的用户消息')).toBe(false);
  });

  it('a run cancelled by hand ends the chain', async () => {
    const big = await bareRemote('big', notes(4, 2_000));
    let service: DreamService | undefined;
    const h = await harness({
      answer: () => {
        service?.cancel();
        return NOTHING;
      },
      tuning: { maxInputChars: 10_000, externalLibraries: [{ name: 'big', url: big }] },
    });
    service = h.service;
    const started = await h.service.start({ id: 'ou-admin' });
    if ('error' in started) throw new Error(started.error);
    await h.service.idle();
    expect(h.service.runs().map((run) => run.status)).toEqual(['cancelled']);
    // The day's own run still comes (inside the window), but as a first run, not a 续跑.
    const check = await h.service.checkAuto();
    expect(check.started).toBeDefined();
    await h.service.idle();
    expect(h.service.runs()[0]!.round).toBeUndefined();
    expect(h.service.runs()[0]!.note ?? '').not.toContain('续跑');
  });
});
