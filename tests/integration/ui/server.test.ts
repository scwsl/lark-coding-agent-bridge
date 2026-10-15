import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import { register } from '../../../src/runtime/registry';
import { startUiServer } from '../../../src/ui/server';
import type { UiServerHandle, UiSupervisor } from '../../../src/ui/types';

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

const roots: string[] = [];
let handle: UiServerHandle;
let rootDir: string;
let configPath: string;
let base: string;
// profile -> controls (a MutableProfileState/Controls-ish object)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let online: Map<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function makeControls(profile: string): Promise<any> {
  const root = (await loadRootConfig(configPath))!;
  return {
    configPath,
    profile,
    cfg: runtimeProfileConfig(root, profile),
    profileConfig: root.profiles[profile]!,
    ownerRefreshState: 'unknown',
    processId: 'test',
    refreshOwner: async () => {},
    restart: async () => {},
  };
}

function stubSupervisor(): UiSupervisor {
  return {
    isOnline: (p) => online.has(p),
    controlsFor: (p) => online.get(p),
    channelFor: () => undefined,
    list: () =>
      [...online.keys()].map((p) => ({
        profile: p,
        agentKind: 'claude' as const,
        online: true,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        botName: `bot-${p}`,
      })),
    startProfile: async (p) => {
      online.set(p, await makeControls(p));
    },
    stopProfile: async (p) => {
      online.delete(p);
    },
    restartProfile: async () => {},
  };
}

function get(path: string, token?: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { headers: { ...(token ? { 'x-ui-token': token } : {}), ...headers } });
}
function post(path: string, token: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'x-ui-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-ui-'));
  roots.push(rootDir);
  configPath = join(rootDir, 'config.json');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await saveRootConfig(
    createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } })),
    configPath,
  );
  // second profile 'work' on disk (offline)
  const rc = (await loadRootConfig(configPath))!;
  await mkdir(join(rootDir, 'profiles', 'work'), { recursive: true });
  rc.profiles.work = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { ...app, id: 'cli_work' } } });
  await saveRootConfig(rc, configPath);
  await writeActiveProfile(rootDir, 'claude');

  online = new Map();
  online.set('claude', await makeControls('claude')); // claude online, work offline

  handle = await startUiServer({ supervisor: stubSupervisor(), version: 'test', rootDir });
  base = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.close();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('ui server (supervisor-backed)', () => {
  it.each(['claude', 'work', 'codex'])('persists smart-session toggle for online/offline profile %s', async (profile) => {
    if (profile === 'codex') {
      const root = (await loadRootConfig(configPath))!;
      root.profiles.codex = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex' }, accounts: { app } });
      await saveRootConfig(root, configPath);
    }
    const url = `/api/config?profile=${profile}`;
    expect((await json(await get(url, handle.token))).smartSession).toBe(false);
    expect((await json(await get(url, handle.token))).autoWorktreeCleanup).toBe(false);
    expect((await json(await post(url, handle.token, { autoWorktreeCleanup: true }))).autoWorktreeCleanup).toBe(true);
    await post(url, handle.token, { autoWorktreeCleanup: 'false' });
    expect((await loadRootConfig(configPath))!.profiles[profile]!.preferences?.autoWorktreeCleanup).toBe(true);
    expect((await json(await post(url, handle.token, { autoWorktreeCleanup: false }))).autoWorktreeCleanup).toBe(false);
    expect((await json(await get(url, handle.token))).dream).toBe(false);
    expect((await json(await post(url, handle.token, { dream: true }))).dream).toBe(true);
    await post(url, handle.token, { dream: 'false' });
    expect((await loadRootConfig(configPath))!.profiles[profile]!.preferences?.dream).toBe(true);
    expect((await json(await post(url, handle.token, { dream: false }))).dream).toBe(false);
    expect((await json(await get(url, handle.token))).dreamAuto).toBe(false);
    expect((await json(await post(url, handle.token, { dreamAuto: true }))).dreamAuto).toBe(true);
    await post(url, handle.token, { dreamAuto: 'false' });
    expect((await loadRootConfig(configPath))!.profiles[profile]!.preferences?.dreamAuto).toBe(true);
    expect((await json(await post(url, handle.token, { dreamAuto: false }))).dreamAuto).toBe(false);
    expect((await json(await post(url, handle.token, { smartSession: true }))).smartSession).toBe(true);
    if (online.has(profile)) expect(online.get(profile).cfg.preferences.smartSession).toBe(true);
    expect((await loadRootConfig(configPath))!.profiles[profile]!.preferences?.smartSession).toBe(true);
    // Older clients/invalid submissions must preserve the existing preference.
    await post(url, handle.token, { maxConcurrentRuns: 4 });
    await post(url, handle.token, { smartSession: 'false' });
    expect((await json(await get(url, handle.token))).smartSession).toBe(true);
    expect((await json(await post(url, handle.token, { smartSession: false }))).smartSession).toBe(false);
    expect((await loadRootConfig(configPath))!.profiles[profile]!.preferences?.smartSession).toBe(false);
  });
  it('shows 梦境整理 status and runs it only for a profile this process hosts', async () => {
    // offline profile: read from its state file, nothing written back, no actions
    await writeFile(
      join(rootDir, 'profiles', 'work', 'dream-state.json'),
      JSON.stringify({
        version: 1,
        sessions: {},
        published: [],
        runs: [{ id: 'b1', status: 'running', actorId: 'ou', startedAt: 1, sessions: 0, scopes: 0, exchanges: 0, memoryItems: 0, skillItems: 0, rejected: 0, deferred: [], targets: [{ repo: 'knowledge', label: '知识库', branch: 'dream/b1', phase: 'pr-created', items: 1, prUrl: 'https://x/pull/3', prNumber: 3, checkoutDir: '/secret/path', body: 'draft text' }] }],
      }),
    );
    const offline = await json(await get('/api/dream?profile=work', handle.token));
    expect(offline).toMatchObject({ live: false, enabled: false, running: { id: 'b1', trigger: 'manual' }, openedPrs: 1, auto: { enabled: false } });
    expect(JSON.stringify(offline)).not.toContain('/secret/path');
    expect(JSON.stringify(offline)).not.toContain('draft text');
    const refused = await post('/api/dream?profile=work', handle.token, { action: 'run' });
    expect(refused.status).toBe(409);
    expect(JSON.parse(await readFile(join(rootDir, 'profiles', 'work', 'dream-state.json'), 'utf8')).runs[0].status).toBe('running');

    // hosted profile: actions go to its live service
    const start = vi.fn(async () => ({ run: { id: 'b2' } }));
    const revert = vi.fn(async (id: string) => ({ id, results: [{ label: '知识库', prUrl: 'https://x/pull/4', note: '撤销 Draft PR 已开' }] }));
    online.get('claude').dream = {
      status: async () => ({ enabled: true, settings: {}, agent: 'Claude Code', targets: { knowledge: {}, skills: {} }, runs: [], openedPrs: 0, pendingDrafts: 0, trackedSessions: 0, auto: { enabled: false, settings: {}, ledger: { consecutiveFailures: 0 } } }),
      start,
      cancel: () => false,
      revert,
    };
    const started = await json(await post('/api/dream?profile=claude', handle.token, { action: 'run' }));
    expect(started).toMatchObject({ live: true, message: expect.stringContaining('b2') });
    expect(start).toHaveBeenCalledWith({ id: 'web-console', name: 'Web 控制台' });
    const reverted = await json(await post('/api/dream?profile=claude', handle.token, { action: 'revert', id: 'b1' }));
    expect(reverted).toMatchObject({ message: expect.stringContaining('撤销 Draft PR 已开') });
    expect(revert).toHaveBeenCalledWith('b1');
    expect((await post('/api/dream?profile=claude', handle.token, { action: 'revert' })).status).toBe(400);
    expect((await post('/api/dream?profile=claude', handle.token, { action: 'nope' })).status).toBe(400);
  });

  it('rejects API calls without the token', async () => {
    expect((await get('/api/status')).status).toBe(401);
    expect((await get('/api/config', 'wrong-token-value')).status).toBe(401);
  });

  it('rejects cross-origin requests', async () => {
    const res = await get('/api/status', handle.token, { origin: 'http://evil.example.com' });
    expect(res.status).toBe(403);
  });

  it('serves the console shell without a token', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('控制台');
  });

  it('returns status and config for the active (online) profile', async () => {
    const status = await json(await get('/api/status', handle.token));
    expect(status).toMatchObject({ hosted: true, version: 'test', activeProfile: 'claude', online: 1 });

    const config = await json(await get('/api/config', handle.token));
    expect(config.mode).toBe('personal');
    expect(config.live).toBe(true);
  });

  it('applies a config change live to an online profile and persists it', async () => {
    const view = await json(
      await post('/api/config', handle.token, { mode: 'team', maxConcurrentRuns: 7, requireMentionInGroup: false }),
    );
    expect(view.mode).toBe('team');
    expect(view.live).toBe(true);
    expect(online.get('claude').profileConfig.mode).toBe('team'); // in-memory controls updated

    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.profiles.claude.mode).toBe('team');
  });

  it('reads and writes an offline profile on disk (deferred, live=false)', async () => {
    const view = await json(await get('/api/config?profile=work', handle.token));
    expect(view.live).toBe(false);

    const saved = await json(
      await post('/api/config?profile=work', handle.token, { mode: 'team' }),
    );
    expect(saved.live).toBe(false);
    const disk = JSON.parse(await readFile(configPath, 'utf8'));
    expect(disk.profiles.work.mode).toBe('team');
    expect(disk.profiles.claude.mode).toBe('personal');
  });

  it('adds and removes access entries', async () => {
    const added = await json(await post('/api/access', handle.token, { action: 'add', kind: 'user', id: 'ou_alice' }));
    expect(added.allowedUsers).toContain('ou_alice');
    const removed = await json(await post('/api/access', handle.token, { action: 'remove', kind: 'user', id: 'ou_alice' }));
    expect(removed.allowedUsers).not.toContain('ou_alice');
  });

  it('sets and clears a per-chat @-mention override, and drops it when the chat is removed', async () => {
    await json(await post('/api/access', handle.token, { action: 'add', kind: 'chat', id: 'oc_grp' }));

    // Set an override (respond to all — no @ needed).
    const set = await json(
      await post('/api/access', handle.token, { action: 'set-mention', kind: 'chat', id: 'oc_grp', requireMention: false }),
    );
    expect(set.chatRequireMention).toEqual({ oc_grp: false });
    expect(online.get('claude').profileConfig.access.chatRequireMention).toEqual({ oc_grp: false });

    // Clear it (follow global) with null.
    const cleared = await json(
      await post('/api/access', handle.token, { action: 'set-mention', kind: 'chat', id: 'oc_grp', requireMention: null }),
    );
    expect(cleared.chatRequireMention).toEqual({});

    // Re-set then remove the chat → override is dropped too.
    await json(await post('/api/access', handle.token, { action: 'set-mention', kind: 'chat', id: 'oc_grp', requireMention: true }));
    const afterRemove = await json(
      await post('/api/access', handle.token, { action: 'remove', kind: 'chat', id: 'oc_grp' }),
    );
    expect(afterRemove.allowedChats).not.toContain('oc_grp');
    expect(afterRemove.chatRequireMention).toEqual({});
  });

  it('lists profiles with online flag from the supervisor', async () => {
    const { profiles } = await json(await get('/api/profiles', handle.token));
    const byName = Object.fromEntries(profiles.map((p: { name: string }) => [p.name, p]));
    expect(byName.claude.running).toBe(true);
    expect(byName.claude.hostedHere).toBe(true);
    expect(byName.work.running).toBe(false);
    expect(byName.work.hostedHere).toBe(false);
  });

  it('reports a profile kept alive by another process as running but not hosted here', async () => {
    // Simulate a separate `start --profile work` daemon: a live registry
    // entry this console's in-memory supervisor never started.
    await register({
      appId: 'cli_work',
      tenant: 'feishu',
      profileName: 'work',
      agentKind: 'claude',
      configPath,
      version: 'test',
      registryFile: resolveAppPaths({ rootDir }).userRegistryFile,
    });

    const { profiles } = await json(await get('/api/profiles', handle.token));
    const byName = Object.fromEntries(profiles.map((p: { name: string }) => [p.name, p]));
    expect(byName.work.running).toBe(true);
    expect(byName.work.hostedHere).toBe(false);
  });

  it('lists online channels from the supervisor', async () => {
    const { bots } = await json(await get('/api/bots', handle.token));
    expect(bots.map((b: { profileName: string }) => b.profileName)).toEqual(['claude']);
  });

  it('starts and stops a profile via the supervisor', async () => {
    expect((await post('/api/profiles/start', handle.token, { profile: 'work' })).status).toBe(200);
    expect(online.has('work')).toBe(true);
    expect((await post('/api/profiles/stop', handle.token, { profile: 'claude' })).status).toBe(200);
    expect(online.has('claude')).toBe(false);
  });

  it('returns 404 for an unknown QR registration session', async () => {
    const res = await get('/api/profiles/qr/status?sessionId=nope', handle.token);
    expect(res.status).toBe(404);
  });

  it('lists runs from a hosted profile via its runsMonitor', async () => {
    // Fixed before the request: computing it inside snapshot() would land
    // after the server read its clock and make the elapsed time 4999ms.
    const startedAt = Date.now() - 5_000;
    online.get('claude').runsMonitor = {
      snapshot: () => [
        {
          scope: 'oc_chat_a',
          source: 'im',
          chatId: 'oc_chat_a',
          promptPreview: '写周报',
          startedAt,
          queueDepth: 1,
        },
      ],
      interrupt: () => true,
    };
    online.get('claude').knownChats = [{ id: 'oc_chat_a', name: '研发群' }];

    const { runs } = await json(await get('/api/runs', handle.token));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      profile: 'claude',
      scope: 'oc_chat_a',
      chatName: '研发群',
      promptPreview: '写周报',
      queueDepth: 1,
      source: 'im',
      status: 'running',
    });
    expect(runs[0].elapsedMs).toBeGreaterThanOrEqual(5_000);
  });

  it('stops a hosted run and rejects stop for a non-hosted profile', async () => {
    const interrupted: string[] = [];
    online.get('claude').runsMonitor = {
      snapshot: () => [],
      interrupt: (scope: string) => {
        interrupted.push(scope);
        return true;
      },
    };

    const ok = await post('/api/runs/stop', handle.token, { profile: 'claude', scope: 'oc_chat_a' });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ ok: true, interrupted: true });
    expect(interrupted).toEqual(['oc_chat_a']);

    // 'work' is on disk but not hosted here → observe-only.
    const denied = await post('/api/runs/stop', handle.token, { profile: 'work', scope: 'oc_x' });
    expect(denied.status).toBe(409);

    const missing = await post('/api/runs/stop', handle.token, { profile: 'claude' });
    expect(missing.status).toBe(400);
  });
});
