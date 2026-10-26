import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAccountsPaths, ClaudeAccountPool } from '../../src/agent/claude/accounts.js';
import { SWITCH_LINE_PROMPT } from '../../src/agent/claude/account-failover.js';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

/**
 * A claude stand-in: on the CLI's own login (no CLAUDE_CODE_OAUTH_TOKEN) the
 * quota is spent and the request is refused the way Claude Code 2.1 reports
 * it; on a token it answers. Every invocation is recorded.
 */
const FAKE = `
const fs = require('node:fs');
const readline = require('node:readline');
const [record] = process.argv.slice(-1);
const argv = process.argv.slice(2, -1);
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.once('line', (line) => {
  const msg = JSON.parse(line);
  fs.appendFileSync(record, JSON.stringify({ argv, token: token ?? null, prompt: msg.message.content }) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  out({ type: 'user', isReplay: true, uuid: msg.uuid });
  if (!token) {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour',
      unifiedWindows: { five_hour: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } });
    out({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your limit · resets 3pm" }] } });
    out({ type: 'result', subtype: 'success', is_error: true, session_id: 'sess-1', num_turns: 1 });
  } else {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.02 } } } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'answered on ' + token }] } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', num_turns: 1 });
  }
  process.exit(0);
});
`;

describe('Claude account failover (process)', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
  });

  it('respawns on the next account with its token, resuming the refused session', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcb-failover-'));
    cleanup.push(dir);
    const record = join(dir, 'record.jsonl');
    const script = join(dir, 'claude-fake.js');
    await writeFile(script, FAKE);
    const binary = join(dir, 'claude');
    await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@" "${record}"\n`, { mode: 0o755 });
    await chmod(binary, 0o755);

    const paths = claudeAccountsPaths(dir);
    await writeFile(paths.configFile, JSON.stringify({ accounts: [{ id: 'default' }, { id: 'b', label: 'backup' }] }));
    const pool = new ClaudeAccountPool({ paths, readSecret: async () => 'sk-ant-oat01-b' });
    const adapter = new ClaudeAdapter({ binary, accounts: pool, probeQuota: false });
    await adapter.prepareRun();

    const run = adapter.run({ runId: 'run-1', prompt: 'hello', cwd: dir, sessionId: 'sess-0' });
    const events: AgentEvent[] = [];
    for await (const evt of run.events) events.push(evt);
    await pool.flush();

    const calls = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[]; token: string | null; prompt: string });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ token: null, prompt: 'hello' });
    expect(calls[0]!.argv.join(' ')).toContain('--resume sess-0');
    expect(calls[1]!.token).toBe('sk-ant-oat01-b');
    expect(calls[1]!.argv.join(' ')).toContain('--resume sess-1');
    expect(calls[1]!.prompt).toContain('额度用尽');
    expect(calls[1]!.prompt).toContain('hello');

    expect(events.filter((e) => e.type === 'rate_limit' && e.blocked)).toEqual([]);
    expect(events).toContainEqual({ type: 'text', delta: 'answered on sk-ant-oat01-b' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'account', label: 'backup' }));
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect(pool.pick()?.id).toBe('b');
  });

  it('leaves an account at its switch line between two steps', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcb-reserve-'));
    cleanup.push(dir);
    const record = join(dir, 'record.jsonl');
    const script = join(dir, 'claude-fake.js');
    // On the CLI login: one tool step at 85%, then it would go on for a long time.
    await writeFile(
      script,
      `
const fs = require('node:fs');
const readline = require('node:readline');
const [record] = process.argv.slice(-1);
const argv = process.argv.slice(2, -1);
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.once('line', (line) => {
  const msg = JSON.parse(line);
  fs.appendFileSync(record, JSON.stringify({ argv, token: token ?? null, prompt: msg.message.content }) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  out({ type: 'user', isReplay: true, uuid: msg.uuid });
  if (!token) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.85, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
    setTimeout(() => {
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'kept going on the reserve' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', num_turns: 2 });
      process.exit(0);
    }, 20000);
  } else {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'finished on ' + token }] } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', num_turns: 1 });
    process.exit(0);
  }
});
`,
    );
    const binary = join(dir, 'claude');
    await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@" "${record}"\n`, { mode: 0o755 });
    await chmod(binary, 0o755);

    const paths = claudeAccountsPaths(dir);
    await writeFile(
      paths.configFile,
      JSON.stringify({ accounts: [{ id: 'default', lines: { five_hour: 80 } }, { id: 'b', label: 'backup' }] }),
    );
    const pool = new ClaudeAccountPool({ paths, readSecret: async () => 'sk-ant-oat01-b' });
    const adapter = new ClaudeAdapter({ binary, accounts: pool, probeQuota: false });
    await adapter.prepareRun();

    const started = Date.now();
    const run = adapter.run({ runId: 'run-2', prompt: 'hello', cwd: dir, sessionId: 'sess-0' });
    const events: AgentEvent[] = [];
    for await (const evt of run.events) events.push(evt);
    await pool.flush();

    expect(Date.now() - started).toBeLessThan(15_000);
    const calls = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[]; token: string | null; prompt: string });
    expect(calls.map((c) => c.token)).toEqual([null, 'sk-ant-oat01-b']);
    expect(calls[1]!.argv.join(' ')).toContain('--resume sess-1');
    expect(calls[1]!.prompt).toBe(SWITCH_LINE_PROMPT);
    expect(events).not.toContainEqual({ type: 'text', delta: 'kept going on the reserve' });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'account', label: 'backup', reason: '5 小时窗口用量到了 80% 的切换线' }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
  });
});
