import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { failoverPrompt, runWithAccountFailover } from '../../../src/agent/claude/account-failover.js';
import {
  accountsReport,
  accountSecretId,
  claudeAccountsPaths,
  ClaudeAccountPool,
  deleteAccount,
  parseAccountsConfig,
  readAccountsConfig,
  saveAccount,
  type PickedAccount,
} from '../../../src/agent/claude/accounts.js';
import { readClaudeQuota } from '../../../src/agent/claude/quota.js';
import { translateEvent } from '../../../src/agent/claude/stream-json.js';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types.js';
import { readVerification } from '../../../src/cli/commands/claude-account.js';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce } from '../../../src/card/run-state.js';
import { getSecret } from '../../../src/config/keystore.js';

const FIXTURES = join(__dirname, '..', '..', 'fixtures');
const dirs: string[] = [];
const pools: ClaudeAccountPool[] = [];
afterEach(async () => {
  // State writes are fire-and-forget; let them land before the directory goes.
  await Promise.all(pools.splice(0).map((pool) => pool.flush()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lcb-accounts-'));
  dirs.push(dir);
  return dir;
}

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 21, 2, 0);

/** A pool over `ids` (after `default`) whose tokens are `tok-<id>`. */
async function poolWith(ids: string[], opts: { switchAtPercent?: number; now?: () => number } = {}) {
  const dir = await tmp();
  const paths = claudeAccountsPaths(dir);
  await writeFile(
    paths.configFile,
    JSON.stringify({
      ...(opts.switchAtPercent ? { switchAtPercent: opts.switchAtPercent } : {}),
      accounts: [{ id: 'default' }, ...ids.map((id) => ({ id, label: `${id}-name` }))],
    }),
  );
  const pool = new ClaudeAccountPool({
    paths,
    now: opts.now ?? (() => NOW),
    readSecret: async (secretId) => `tok-${secretId.replace('claude-oauth-', '')}`,
  });
  await pool.refresh();
  pools.push(pool);
  return { pool, paths, dir };
}

function limit(over: Partial<Extract<AgentEvent, { type: 'rate_limit' }>> = {}): Extract<AgentEvent, { type: 'rate_limit' }> {
  return { type: 'rate_limit', blocked: false, at: NOW, ...over };
}

describe('Claude account list', () => {
  it('keeps valid entries, adds the CLI login in front and defaults the threshold', () => {
    const config = parseAccountsConfig(
      JSON.stringify({ accounts: [{ id: 'b', label: ' Bee ' }, { id: 'bad id' }, { id: 'b' }, 7], switchAtPercent: 400 }),
    );
    expect(config).toEqual({ switchAtPercent: 98, accounts: [{ id: 'default' }, { id: 'b', label: 'Bee' }] });
    expect(parseAccountsConfig('not json').accounts).toEqual([{ id: 'default' }]);
  });

  it('stores the token in the profile keystore and removes both again', async () => {
    const dir = await tmp();
    const paths = claudeAccountsPaths(dir);
    await saveAccount(paths, { id: 'b', label: 'Bee', token: 'sk-ant-oat01-secret' });
    expect(await getSecret(accountSecretId('b'), paths.keystore)).toBe('sk-ant-oat01-secret');
    expect(readAccountsConfig(paths).accounts.map((a) => a.id)).toEqual(['default', 'b']);
    expect(await readFile(paths.configFile, 'utf8')).not.toContain('secret');
    await expect(saveAccount(paths, { id: 'default', token: 'x' })).rejects.toThrow();

    expect(await deleteAccount(paths, 'b')).toBe(true);
    expect(await getSecret(accountSecretId('b'), paths.keystore)).toBeUndefined();
    expect(readAccountsConfig(paths).accounts.map((a) => a.id)).toEqual(['default']);
  });
});

describe('ClaudeAccountPool', () => {
  it('without a list has only the CLI login, which runs with an untouched environment', async () => {
    const dir = await tmp();
    const pool = new ClaudeAccountPool({ paths: claudeAccountsPaths(dir), readSecret: async () => undefined });
    await pool.refresh();
    expect(pool.multi).toBe(false);
    expect(pool.pick()).toEqual({ id: 'default', env: {} });
  });

  it('leaves out an account whose token is missing', async () => {
    const dir = await tmp();
    const paths = claudeAccountsPaths(dir);
    await writeFile(paths.configFile, JSON.stringify({ accounts: [{ id: 'default' }, { id: 'b' }] }));
    const pool = new ClaudeAccountPool({ paths, readSecret: async () => undefined });
    await pool.refresh();
    expect(pool.accounts().map((a) => a.id)).toEqual(['default']);
  });

  it('prefers the first account with room, skips a full or refused one, and returns once it resets', async () => {
    let now = NOW;
    const { pool } = await poolWith(['b', 'c'], { now: () => now });
    expect(pool.pick()?.id).toBe('default');

    pool.observe('default', limit({ windows: [{ kind: 'five_hour', usedPercent: 99, resetsAt: NOW + HOUR }] }));
    expect(pool.pick()).toMatchObject({ id: 'b', label: 'b-name', env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-b' } });

    pool.observe('b', limit({ blocked: true, resetsAt: NOW + 2 * HOUR }));
    expect(pool.pick()?.id).toBe('c');

    // A refusal message carries no reset of its own: the earlier one stands.
    pool.observe('b', limit({ blocked: true }));
    expect(pool.availableAt('b')).toBe(NOW + 2 * HOUR);

    now = NOW + HOUR + 1;
    expect(pool.pick()?.id).toBe('default');
  });

  it('ignores model-specific windows unless they refuse, and honours the threshold', async () => {
    const { pool } = await poolWith(['b'], { switchAtPercent: 90 });
    pool.observe('default', limit({ windows: [{ kind: 'seven_day_opus', usedPercent: 100, resetsAt: NOW + HOUR }] }));
    expect(pool.pick()?.id).toBe('default');
    pool.observe('default', limit({ windows: [{ kind: 'seven_day', usedPercent: 91, resetsAt: NOW + HOUR }] }));
    expect(pool.pick()?.id).toBe('b');
  });

  it('when every account is spent, picks the one that frees up first but has none ready', async () => {
    const { pool } = await poolWith(['b']);
    pool.observe('default', limit({ blocked: true, resetsAt: NOW + 3 * HOUR }));
    pool.observe('b', limit({ blocked: true, resetsAt: NOW + HOUR }));
    expect(pool.pick()?.id).toBe('b');
    expect(pool.pickReady()).toBeUndefined();
  });

  it('an allowed report lifts a refusal', async () => {
    const { pool } = await poolWith(['b']);
    pool.observe('default', limit({ blocked: true, resetsAt: NOW + HOUR }));
    pool.observe('default', limit({ windows: [{ kind: 'five_hour', usedPercent: 5 }] }));
    expect(pool.pick()?.id).toBe('default');
  });

  it('persists what it learned and reads it back in a new process', async () => {
    const { pool, paths } = await poolWith(['b']);
    pool.observe('b', limit({ windows: [{ kind: 'five_hour', usedPercent: 40, resetsAt: NOW + HOUR }] }));
    await pool.flush();
    const again = new ClaudeAccountPool({ paths, now: () => NOW, readSecret: async () => 'tok' });
    await again.refresh();
    expect(again.quotaReading('b')).toEqual({
      windows: [{ label: '5 小时窗口', usedPercent: 40, resets: new Date(NOW + HOUR).toISOString() }],
    });
    expect(again.quotaReading('default')).toBeUndefined();
  });

  it('re-reads the list when the file changes', async () => {
    const { pool, paths } = await poolWith([]);
    expect(pool.multi).toBe(false);
    await writeFile(paths.configFile, JSON.stringify({ accounts: [{ id: 'default' }, { id: 'b' }] }));
    const later = new Date(Date.now() + 5_000);
    await utimes(paths.configFile, later, later);
    await pool.refresh();
    expect(pool.multi).toBe(true);
  });

  it('reports each account for /usage', async () => {
    const { pool } = await poolWith(['b']);
    pool.observe('default', limit({ blocked: true, resetsAt: NOW + HOUR, windows: [{ kind: 'five_hour', usedPercent: 100, resetsAt: NOW + HOUR }] }));
    const lines = accountsReport(pool, 'scwsl.wang', NOW);
    expect(lines[0]).toContain('**scwsl.wang**（default）：5 小时窗口 100%');
    expect(lines[0]).toContain('额度用尽');
    expect(lines[1]).toContain('▶ **b-name**（b）：还没有运行记录');
  });
});

/** A scripted claude attempt. */
function fakeRun(events: AgentEvent[], log: string[] = []): AgentRun {
  return {
    runId: 'r',
    pid: 1,
    events: (async function* () {
      yield* events;
    })(),
    stop: async () => {
      log.push('stop');
    },
    waitForExit: async () => true,
  };
}

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const evt of run.events) out.push(evt);
  return out;
}

const OPTS: AgentRunOptions = { runId: 'r', prompt: 'hello', cwd: '/tmp', sessionId: 's0' };
const refused: AgentEvent[] = [
  { type: 'system', sessionId: 's1' },
  limit({ blocked: true, limitType: 'five_hour', resetsAt: NOW + HOUR }),
  limit({ blocked: true, message: "You've hit your limit" }),
  { type: 'usage', costUsd: 0 },
  { type: 'done', sessionId: 's1', terminationReason: 'normal' },
];

describe('account failover', () => {
  it('passes a normal run through, recording its quota and naming the account', async () => {
    const { pool } = await poolWith(['b']);
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return fakeRun([
          { type: 'system', sessionId: 's1' },
          limit({ windows: [{ kind: 'five_hour', usedPercent: 12, resetsAt: NOW + HOUR }] }),
          { type: 'text', delta: 'hi' },
          { type: 'done', sessionId: 's1', terminationReason: 'normal' },
        ]);
      },
      labelOf: async () => 'scwsl.wang',
    });
    const events = await collect(run);
    expect(spawned).toEqual(['default']);
    expect(events[0]).toEqual({ type: 'account', label: 'scwsl.wang' });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(pool.quotaReading('default')?.windows[0]?.usedPercent).toBe(12);
  });

  it('says nothing about accounts when there is only one', async () => {
    const { pool } = await poolWith([]);
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: () => fakeRun([{ type: 'done', terminationReason: 'normal' }]),
      labelOf: async () => 'me',
    });
    expect((await collect(run)).map((e) => e.type)).toEqual(['done']);
  });

  it('moves a refused run to the next account and resumes the same session there', async () => {
    const { pool } = await poolWith(['b']);
    const calls: Array<{ account: PickedAccount; opts: AgentRunOptions }> = [];
    const stops: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (opts, account) => {
        calls.push({ account, opts });
        return calls.length === 1
          ? fakeRun(refused, stops)
          : fakeRun([
              { type: 'system', sessionId: 's1' },
              { type: 'text', delta: 'done on b' },
              { type: 'done', sessionId: 's1', terminationReason: 'normal' },
            ]);
      },
      labelOf: async (account) => (account.id === 'default' ? 'scwsl.wang' : account.label),
    });
    const events = await collect(run);

    expect(calls.map((c) => c.account.id)).toEqual(['default', 'b']);
    expect(calls[1]!.account.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-b' });
    expect(calls[1]!.opts).toMatchObject({ sessionId: 's1', prompt: failoverPrompt('hello') });
    expect(calls[1]!.opts.prompt).toContain('hello');
    // The refusal and the refused turn's end never reach the card.
    expect(events.filter((e) => e.type === 'rate_limit')).toEqual([]);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events).toContainEqual({ type: 'account', label: 'b-name', switchedFrom: 'scwsl.wang' });
    expect(pool.availableAt('default')).toBe(NOW + HOUR);
    expect(stops).toEqual([]);

    const state = events.reduce(reduce, initialState);
    expect(state.terminal).toBe('done');
    expect(state.sponsor).toBe('b-name');
    const card = JSON.stringify(renderCard(state, { meta: { title: 'Occam', sponsor: 'scwsl.wang' } }));
    expect(card).toContain('Sponsor: b-name');
    expect(card).toContain('已切换到 b-name');
  });

  it('pauses as before when no other account has room, at the soonest reset', async () => {
    const { pool } = await poolWith(['b']);
    pool.observe('b', limit({ blocked: true, resetsAt: NOW + 30 * 60_000 }));
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return fakeRun(refused);
      },
      labelOf: async () => 'me',
    });
    const events = await collect(run);
    expect(spawned).toEqual(['default']);
    const state = events.reduce(reduce, initialState);
    expect(state.terminal).toBe('paused');
    // Account b frees up first: that is when the task can go on.
    expect(events.find((e) => e.type === 'rate_limit')).toMatchObject({ blocked: true, resetsAt: NOW + 30 * 60_000 });
  });

  it('does not switch when the agent works past the refusal', async () => {
    const { pool } = await poolWith(['b']);
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return fakeRun([
          limit({ blocked: true, resetsAt: NOW + HOUR }),
          { type: 'text', delta: 'still going' },
          { type: 'done', terminationReason: 'normal' },
        ]);
      },
      labelOf: async () => 'me',
    });
    const events = await collect(run);
    expect(spawned).toEqual(['default']);
    expect(events.map((e) => e.type)).toEqual(['account', 'rate_limit', 'text', 'done']);
  });

  it('does not retry a refusal in a background turn after the user turn ended', async () => {
    const { pool } = await poolWith(['b']);
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return fakeRun([
          { type: 'text', delta: 'answer' },
          { type: 'done', sessionId: 's1', terminationReason: 'normal' },
          limit({ blocked: true, resetsAt: NOW + HOUR }),
          { type: 'done', sessionId: 's1', terminationReason: 'normal' },
        ]);
      },
      labelOf: async () => 'me',
    });
    const events = await collect(run);
    expect(spawned).toEqual(['default']);
    expect(events.map((e) => e.type)).toEqual(['account', 'text', 'done', 'rate_limit', 'done']);
    expect(pool.availableAt('default')).toBe(NOW + HOUR);
  });

  it('does not switch a run that was stopped', async () => {
    const { pool } = await poolWith(['b']);
    const spawned: string[] = [];
    const run = runWithAccountFailover(OPTS, {
      pool,
      spawn: (_opts, account) => {
        spawned.push(account.id);
        return fakeRun([limit({ blocked: true }), { type: 'done', terminationReason: 'interrupted' }]);
      },
      labelOf: async () => 'me',
    });
    await collect(run);
    expect(spawned).toEqual(['default']);
  });
});

describe('Claude rate_limit_event', () => {
  it('reads every window from a real sample', async () => {
    const raw = JSON.parse(await readFile(join(FIXTURES, 'claude-rate-limit-event.json'), 'utf8'));
    const [evt] = [...translateEvent(raw)];
    expect(evt).toMatchObject({
      type: 'rate_limit',
      blocked: false,
      limitType: 'five_hour',
      windows: [
        { kind: 'five_hour', usedPercent: 14, resetsAt: 1792563600_000 },
        { kind: 'seven_day', usedPercent: 11, resetsAt: 1793062800_000 },
      ],
    });
  });
});

describe('claude-account add verification', () => {
  it('accepts a token that answered, reporting its quota', async () => {
    const raw = await readFile(join(FIXTURES, 'claude-rate-limit-event.json'), 'utf8');
    const out = [raw.trim(), JSON.stringify({ type: 'result', subtype: 'success', is_error: false })].join('\n');
    expect(readVerification(out)).toEqual({ ok: true, message: 'ok', quota: '5 小时窗口 14% · 本周 11%' });
  });

  it('rejects a token the API refused', () => {
    const out = [
      JSON.stringify({ type: 'assistant', error: 'authentication_failed', message: { content: [] } }),
      JSON.stringify({ type: 'result', is_error: true, result: 'Invalid bearer token' }),
    ].join('\n');
    expect(readVerification(out)).toMatchObject({ ok: false, message: 'authentication_failed' });
  });
});

describe('quota across accounts', () => {
  it('speaks for the account with the most room, by its last report when /usage cannot answer', { skip: process.platform === 'win32', timeout: 20_000 }, async () => {
    const { pool, dir } = await poolWith(['b']);
    const broken = join(dir, 'claude-broken');
    await writeFile(broken, `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
    await chmod(broken, 0o755);
    pool.observe('default', limit({ windows: [{ kind: 'seven_day', usedPercent: 85, resetsAt: NOW + HOUR }] }));
    pool.observe('b', limit({ windows: [{ kind: 'seven_day', usedPercent: 10, resetsAt: NOW + HOUR }] }));
    const reading = await readClaudeQuota({ cwd: dir }, broken, pool);
    expect(reading?.windows).toEqual([{ label: '本周', usedPercent: 10, resets: expect.any(String) }]);
  });
});
