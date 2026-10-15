import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import { git } from '../../../src/git/exec';
import { startUiServer } from '../../../src/ui/server';
import type { UiServerHandle, UiSupervisor } from '../../../src/ui/types';

/** The console's skill library and knowledge endpoints, against real git repositories. */

// Several real git rounds per test; the 5s default is too tight in a full run.
const GIT_TIMEOUT_MS = 30_000;

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

let rootDir: string;
let configPath: string;
let handle: UiServerHandle;
let base: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let online: Map<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function makeControls(profile: string): Promise<any> {
  const root = (await loadRootConfig(configPath))!;
  return { configPath, profile, cfg: runtimeProfileConfig(root, profile), profileConfig: root.profiles[profile]! };
}

function stubSupervisor(): UiSupervisor {
  return {
    isOnline: (p) => online.has(p),
    controlsFor: (p) => online.get(p),
    channelFor: () => undefined,
    list: () => [],
    startProfile: async () => {},
    stopProfile: async () => {},
    restartProfile: async () => {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'x-ui-token': handle.token, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json() };
}

async function commitAll(repo: string, message: string): Promise<void> {
  for (const args of [
    ['add', '-A'],
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message],
  ]) {
    const result = await git(repo, args);
    if (!result.ok) throw new Error(result.stderr);
  }
}

/** A repository with `skills/<name>/SKILL.md` for each entry. */
async function sourceRepo(name: string, skills: Record<string, string>): Promise<string> {
  const repo = join(rootDir, 'remotes', name);
  await mkdir(repo, { recursive: true });
  const init = await git(repo, ['init', '-q', '--initial-branch=main']);
  if (!init.ok) throw new Error(init.stderr);
  for (const [skill, description] of Object.entries(skills)) {
    await mkdir(join(repo, 'skills', skill), { recursive: true });
    await writeFile(join(repo, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${description}\n---\n\n正文\n`);
  }
  await commitAll(repo, 'init');
  return repo;
}

async function bareRemote(): Promise<string> {
  const remote = join(rootDir, 'remotes', 'knowledge.git');
  await mkdir(remote, { recursive: true });
  const init = await git(remote, ['init', '--bare', '--initial-branch=main']);
  if (!init.ok) throw new Error(init.stderr);
  return remote;
}

async function profileOnDisk(profile: string) {
  return (await loadRootConfig(configPath))!.profiles[profile]!;
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-ui-knowledge-'));
  configPath = join(rootDir, 'config.json');
  const root = createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }));
  root.profiles.work = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { ...app, id: 'cli_work' } } });
  await saveRootConfig(root, configPath);
  await writeActiveProfile(rootDir, 'claude');
  online = new Map();
  online.set('claude', await makeControls('claude'));
  handle = await startUiServer({ supervisor: stubSupervisor(), version: 'test', rootDir });
  base = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.close();
  await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe('console: skill libraries', { timeout: GIT_TIMEOUT_MS }, () => {
  it('adds, syncs and removes a library of a profile this process does not run', async () => {
    const url = await sourceRepo('team-skills', { deploy: '发布步骤', triage: '排查流程' });
    const mirrors = join(rootDir, 'profiles', 'work', 'skill-libraries');

    const empty = await call('GET', '/api/skills?profile=work');
    expect(empty.data).toMatchObject({ live: false, syncIntervalMinutes: 60, libraries: [] });

    const added = await call('POST', '/api/skills?profile=work', { action: 'add', url, exclude: 'triage' });
    expect(added.status).toBe(200);
    expect(added.data.results).toMatchObject([{ name: 'team-skills', ok: true }]);
    expect(added.data.libraries).toMatchObject([
      { name: 'team-skills', url, exclude: ['triage'], present: true, skills: [{ name: 'deploy', description: '发布步骤' }] },
    ]);
    expect((await profileOnDisk('work')).skills?.libraries).toEqual([{ name: 'team-skills', url, exclude: ['triage'] }]);
    expect(await readdir(mirrors)).toEqual(['team-skills']);

    const synced = await call('POST', '/api/skills?profile=work', { action: 'sync' });
    expect(synced.data.results).toMatchObject([{ name: 'team-skills', ok: true, changed: false }]);
    // The last sync is remembered between requests for a profile run elsewhere.
    expect((await call('GET', '/api/skills?profile=work')).data.libraries[0].lastSyncAt).toEqual(expect.any(Number));

    const removed = await call('POST', '/api/skills?profile=work', { action: 'remove', name: 'team-skills' });
    expect(removed.data.libraries).toEqual([]);
    expect((await profileOnDisk('work')).skills).toBeUndefined();
    expect(await readdir(mirrors)).toEqual([]);
  });

  it('saves nothing for a library that is invalid, taken or cannot be pulled', async () => {
    const url = await sourceRepo('team', { deploy: '发布步骤' });
    expect((await call('POST', '/api/skills?profile=work', { action: 'add', url })).status).toBe(200);

    const invalid = await call('POST', '/api/skills?profile=work', { action: 'add', url: 'not a url' });
    expect(invalid).toMatchObject({ status: 400, data: { error: expect.stringContaining('不像 git') } });
    const taken = await call('POST', '/api/skills?profile=work', { action: 'add', url, name: 'team' });
    expect(taken).toMatchObject({ status: 400, data: { error: expect.stringContaining('已经有叫') } });
    const missing = await call('POST', '/api/skills?profile=work', {
      action: 'add',
      url: join(rootDir, 'remotes', 'nope'),
    });
    expect(missing).toMatchObject({ status: 400, data: { error: expect.stringContaining('拉取 nope 失败') } });

    expect((await profileOnDisk('work')).skills?.libraries.map((library) => library.name)).toEqual(['team']);
    expect(await readdir(join(rootDir, 'profiles', 'work', 'skill-libraries'))).toEqual(['team']);
    expect((await call('POST', '/api/skills?profile=work', { action: 'remove', name: 'nope' })).status).toBe(404);
  });

  it('lists library skills hidden behind the profile’s own skill of the same name', async () => {
    const url = await sourceRepo('team', { deploy: '库里的', triage: '排查流程' });
    const own = join(rootDir, 'profiles', 'work', 'knowledge', 'skills', 'deploy');
    await mkdir(own, { recursive: true });
    await writeFile(join(own, 'SKILL.md'), '---\nname: deploy\ndescription: 自己的\n---\n');

    const added = await call('POST', '/api/skills?profile=work', { action: 'add', url });
    expect(added.data.libraries[0].shadowed).toEqual(['deploy']);
  });

  it('changes the sync interval, live for a profile this process runs', async () => {
    const reschedule = vi.fn();
    online.get('claude').skillLibraries = { status: async () => [], listSkills: async () => [], reschedule };

    const saved = await call('POST', '/api/skills?profile=claude', { action: 'interval', minutes: 15 });
    expect(saved.data).toMatchObject({ live: true, syncIntervalMinutes: 15 });
    expect(online.get('claude').profileConfig.skills.syncIntervalMinutes).toBe(15);
    expect((await profileOnDisk('claude')).skills).toEqual({ libraries: [], syncIntervalMinutes: 15 });
    expect(reschedule).toHaveBeenCalledTimes(1);

    for (const minutes of [-1, 1.5, 'x', 100_000]) {
      expect((await call('POST', '/api/skills?profile=claude', { action: 'interval', minutes })).status).toBe(400);
    }
  });
});

describe('console: knowledge repo', { timeout: GIT_TIMEOUT_MS }, () => {
  it('binds, syncs and unbinds the knowledge directory', async () => {
    const remote = await bareRemote();
    const before = await call('GET', '/api/knowledge?profile=work');
    expect(before.data).toMatchObject({ live: false, repo: false, profileMemories: 0, syncIntervalMinutes: 30 });
    expect(before.data.remote).toBeUndefined();

    const bound = await call('POST', '/api/knowledge?profile=work', { action: 'bind', url: remote });
    expect(bound.status).toBe(200);
    expect(bound.data).toMatchObject({ repo: true, remote, branch: 'main' });

    await writeFile(join(rootDir, 'profiles', 'work', 'knowledge', 'MEMORY.md'), '- [a1b2c3] 控制台同步\n');
    const synced = await call('POST', '/api/knowledge?profile=work', { action: 'sync' });
    expect(synced.data).toMatchObject({ outcome: { pushed: true }, profileMemories: 1, dirty: false, ahead: 0 });
    expect((await git(remote, ['show', 'main:MEMORY.md'])).stdout).toContain('控制台同步');

    const unbound = await call('POST', '/api/knowledge?profile=work', { action: 'unbind' });
    expect(unbound.data).toMatchObject({ repo: true });
    expect(unbound.data.remote).toBeUndefined();
    // Local content stays.
    await expect(stat(join(rootDir, 'profiles', 'work', 'knowledge', 'MEMORY.md'))).resolves.toBeTruthy();
  });

  it('reports a bad remote or a sync with nothing bound as an error', async () => {
    const bad = await call('POST', '/api/knowledge?profile=work', { action: 'bind', url: 'not a url' });
    expect(bad).toMatchObject({ status: 400, data: { error: expect.stringContaining('绑定失败') } });
    const unbound = await call('POST', '/api/knowledge?profile=work', { action: 'sync' });
    expect(unbound).toMatchObject({ status: 400, data: { error: expect.stringContaining('还不是 git 仓库') } });
  });

  it('feeds a running profile’s auto-sync: interval, manual result, status', async () => {
    const remote = await bareRemote();
    const autoSync = {
      status: () => ({ intervalMinutes: 30, syncing: false, failures: 0, last: { at: 1, trigger: 'auto', ok: true } }),
      noteManual: vi.fn(),
      reschedule: vi.fn(),
    };
    online.get('claude').knowledgeAutoSync = autoSync;

    const view = await call('GET', '/api/knowledge?profile=claude');
    expect(view.data).toMatchObject({ live: true, autoSync: { syncing: false, failures: 0, last: { ok: true } } });

    expect((await call('POST', '/api/knowledge?profile=claude', { action: 'bind', url: remote })).status).toBe(200);
    expect((await call('POST', '/api/knowledge?profile=claude', { action: 'sync' })).status).toBe(200);
    expect(autoSync.noteManual).toHaveBeenCalledWith(expect.objectContaining({ pushed: true }));

    const saved = await call('POST', '/api/knowledge?profile=claude', { action: 'interval', minutes: 0 });
    expect(saved.data.syncIntervalMinutes).toBe(0);
    expect((await profileOnDisk('claude')).knowledge).toEqual({ syncIntervalMinutes: 0 });
    expect(online.get('claude').profileConfig.knowledge).toEqual({ syncIntervalMinutes: 0 });
    expect(autoSync.reschedule).toHaveBeenCalledTimes(1);
  });
});
