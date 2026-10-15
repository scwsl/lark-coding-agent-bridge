import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../src/agent/types.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })));
});

/**
 * A stand-in for `codex app-server --listen stdio://` speaking just enough of
 * the protocol: thread/start|resume, turn/start (a reply per turn), and
 * turn/interrupt for turns whose text contains SLOW. Turns containing ASK
 * first send the client an approval request. Every message it receives is
 * appended to messages.jsonl; argv goes to argv.json.
 */
async function createFakeAppServer(): Promise<{ path: string; dir: string; messages(): Promise<Array<Record<string, any>>>; argv(): Promise<string[][]> }> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-server-'));
  cleanup.push(dir);
  const path = join(dir, 'fake-codex.mjs');
  const messagesPath = join(dir, 'messages.jsonl');
  const argvPath = join(dir, 'argv.jsonl');
  await writeFile(
    path,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('codex-cli 0.159.2'); process.exit(0); }
appendFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv) + '\\n');
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
let turns = 0; let slow; let asked; let gated; const decisions = [];
const finish = (threadId, turnId, status, text) => {
  if (text) send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'm' + turnId, text } } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 105 }, total: {} } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status, error: null } } });
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  appendFileSync(${JSON.stringify(messagesPath)}, line + '\\n');
  if (gated && (msg.id === 501 || msg.id === 502)) {
    decisions.push(msg.result?.decision);
    if (gated.step === 'command') {
      gated.step = 'file';
      send({ method: 'item/started', params: { threadId: gated.threadId, turnId: gated.turnId, item: { type: 'fileChange', id: 'fc-1', status: 'inProgress', changes: [{ path: '/repo/notes.md', kind: { type: 'add' }, diff: 'hi' }] } } });
      return send({ id: 502, method: 'item/fileChange/requestApproval', params: { threadId: gated.threadId, turnId: gated.turnId, itemId: 'fc-1', startedAtMs: 2 } });
    }
    const g = gated; gated = undefined;
    return finish(g.threadId, g.turnId, 'completed', 'decisions: ' + decisions.join(','));
  }
  if (msg.id === 99 && asked) { const a = asked; asked = undefined; return finish(a.threadId, a.turnId, 'completed', 'after refusal'); }
  if (msg.method === 'initialize') return send({ id: msg.id, result: { userAgent: 'fake' } });
  if (msg.method === 'thread/start') return send({ id: msg.id, result: { thread: { id: 'thr-new' } } });
  if (msg.method === 'thread/resume') return send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
  if (msg.method === 'turn/start') {
    const turnId = 'turn-' + (++turns);
    const threadId = msg.params.threadId;
    const text = msg.params.input[0].text;
    send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
    if (text.includes('ASK')) {
      // Hold the turn until the client answers, as Codex would.
      asked = { threadId, turnId };
      return send({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId, turnId } });
    }
    if (text.includes('SLOW')) { slow = { threadId, turnId }; return; }
    if (text.includes('TOUCH')) {
      gated = { threadId, turnId, step: 'command' };
      return send({ id: 501, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'cmd-1', command: "/bin/zsh -lc 'touch x.txt'", proposedExecpolicyAmendment: ['/bin/zsh', '-lc', 'touch x.txt'], startedAtMs: 1 } });
    }
    return finish(threadId, turnId, 'completed', 'reply ' + turns);
  }
  if (msg.method === 'turn/interrupt') {
    send({ id: msg.id, result: {} });
    if (slow) finish(slow.threadId, slow.turnId, 'interrupted');
    return;
  }
});
process.stdin.on('end', () => process.exit(0));
`,
    'utf8',
  );
  await chmod(path, 0o755);
  const readJsonl = async (p: string) =>
    (await readFile(p, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { path, dir, messages: () => readJsonl(messagesPath), argv: () => readJsonl(argvPath) };
}

async function nextTurn(iterator: AsyncIterator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
    out.push(next.value);
    if (next.value.type === 'done' || next.value.type === 'error') break;
  }
  return out;
}

async function preparedRun(adapter: CodexAdapter, opts: AgentRunOptions): Promise<AgentRun> {
  await adapter.prepareRun(opts);
  return adapter.run(opts);
}

describe('Codex app-server transport', () => {
  it.each([undefined, 'thr-old'])('forwards smart-session compaction to app-server (%s)', async (threadId) => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir });
    const run = await preparedRun(adapter, { runId: 'compact', cwd, prompt: 'hello', threadId, compactWindowTokens: 300000 });
    try {
      await nextTurn(run.events[Symbol.asyncIterator]());
      expect((await fake.argv())[0]).toContain('model_auto_compact_token_limit=300000');
    } finally {
      run.endInput?.();
      await run.waitForExit(2000);
    }
  });
  it('serves later turns of the conversation from the same process', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, { runId: 'r1', prompt: 'first', cwd, model: 'gpt-6-luna', effort: 'low', sandbox: 'workspace-write' });
    const events = run.events[Symbol.asyncIterator]();

    expect(await nextTurn(events)).toEqual([
      { type: 'system', threadId: 'thr-new' },
      { type: 'final_text', content: 'reply 1' },
      { type: 'usage', inputTokens: 100, cachedInputTokens: 60, outputTokens: 5, reasoningOutputTokens: 0 },
      { type: 'done', threadId: 'thr-new', terminationReason: 'normal' },
    ]);
    expect(run.send?.('second')).toBe(true);
    expect((await nextTurn(events)).find((e) => e.type === 'final_text')).toEqual({ type: 'final_text', content: 'reply 2' });

    run.endInput?.();
    expect(await run.waitForExit(2_000)).toBe(true);
    expect(run.send?.('third')).toBe(false);

    expect(await fake.argv()).toEqual([['app-server', '--listen', 'stdio://', '-c', 'approval_policy="never"', '-c', 'shell_environment_policy.inherit="all"']]);
    const messages = await fake.messages();
    expect(messages.map((m) => m.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start', 'turn/start']);
    expect(messages[2]?.params).toEqual({ cwd, sandbox: 'workspace-write', approvalPolicy: 'never', model: 'gpt-6-luna' });
    expect(messages[3]?.params).toMatchObject({ threadId: 'thr-new', effort: 'low' });
    // Every turn carries the bridge system prompt, like the exec path's stdin.
    expect(messages[3]?.params.input[0].text).toContain('lark-channel-bridge');
    expect(messages[3]?.params.input[0].text).toContain('first');
    expect(messages[4]?.params.input[0].text).toContain('second');
  });

  it('resumes an existing thread', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, { runId: 'r2', prompt: 'again', cwd, threadId: 'thr-old' });
    const turn = await nextTurn(run.events[Symbol.asyncIterator]());
    expect(turn.at(-1)).toEqual({ type: 'done', threadId: 'thr-old', terminationReason: 'normal' });
    expect((await fake.messages())[2]).toMatchObject({ method: 'thread/resume', params: { threadId: 'thr-old' } });
    await run.stop();
  });

  it('interrupts a running turn through the protocol on stop', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, { runId: 'r3', prompt: 'SLOW work', cwd, stopGraceMs: 1_000 });
    const events = run.events[Symbol.asyncIterator]();
    expect((await events.next()).value).toEqual({ type: 'system', threadId: 'thr-new' });
    // Let the turn get going before stopping it.
    await new Promise((resolve) => setTimeout(resolve, 150));

    await run.stop();
    const rest = await nextTurn(events);
    expect(rest.at(-1)).toEqual({ type: 'done', threadId: 'thr-new', terminationReason: 'interrupted' });
    expect((await fake.messages()).map((m) => m.method)).toContain('turn/interrupt');
    expect(await run.waitForExit(1_000)).toBe(true);
  });

  it('refuses requests from the server instead of leaving Codex waiting', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, { runId: 'r4', prompt: 'ASK first', cwd });
    await nextTurn(run.events[Symbol.asyncIterator]());
    const refusal = (await fake.messages()).find((m) => m.id === 99);
    expect(refusal?.error).toMatchObject({ code: -32601 });
    await run.stop();
  });

  it('stays on codex exec when the profile needs exec-only behaviour', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const home = join(fake.dir, 'home');
    const exec = async (adapter: CodexAdapter, runId: string): Promise<boolean> => {
      const run = await preparedRun(adapter, { runId, prompt: 'x', cwd });
      await run.stop();
      return run.send === undefined;
    };
    expect(await exec(new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: home, transport: 'exec' }), 'e1')).toBe(true);
    expect(await exec(new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: home, ignoreUserConfig: true }), 'e2')).toBe(true);
    // ignoreRules (the default) must keep execpolicy rules out, which only exec can do.
    await mkdir(join(home, 'rules'), { recursive: true });
    await writeFile(join(home, 'rules', 'default.rules'), 'prefix_rule(pattern=["rm"], decision="forbidden")\n');
    expect(await exec(new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: home }), 'e3')).toBe(true);
    expect(await exec(new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: home, ignoreRules: false }), 'e4')).toBe(false);
  });

  it('falls back to codex exec for later runs once the app-server cannot start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-no-app-server-'));
    cleanup.push(dir);
    const path = join(dir, 'old-codex.mjs');
    // An older Codex: answers --version, but has no app-server subcommand.
    await writeFile(
      path,
      `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('codex-cli 0.40.0'); process.exit(0); }
if (process.argv[2] === 'app-server') { console.error("error: unrecognized subcommand 'app-server'"); process.exit(2); }
process.stdin.resume(); process.stdin.on('end', () => { console.log(JSON.stringify({ type: 'turn.completed' })); process.exit(0); });
`,
      'utf8',
    );
    await chmod(path, 0o755);
    const cwd = await realpath(dir);
    const adapter = new CodexAdapter({ binary: path, profileStateDir: dir, codexHome: join(dir, 'home') });

    const first = await preparedRun(adapter, { runId: 'f1', prompt: 'x', cwd });
    const firstEvents = await nextTurn(first.events[Symbol.asyncIterator]());
    expect(firstEvents.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('start-up failed') });

    const second = await preparedRun(adapter, { runId: 'f2', prompt: 'y', cwd });
    expect(second.send).toBeUndefined();
    expect((await nextTurn(second.events[Symbol.asyncIterator]())).at(-1)).toMatchObject({ type: 'done' });
  });

  it('asks the bridge before commands and file changes on a gated run, inside a read-only sandbox', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const asked: Array<{ tool: string; summary: string }> = [];
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, {
      runId: 'g1',
      prompt: 'TOUCH and write notes',
      cwd,
      sandbox: 'danger-full-access',
      approvals: {
        decide: async (request) => {
          asked.push(request);
          return request.tool === 'command_execution'
            ? { decision: 'allow', reason: 'ok' }
            : { decision: 'deny', reason: 'no' };
        },
      },
    });
    const turn = await nextTurn(run.events[Symbol.asyncIterator]());

    expect(asked).toEqual([
      // Codex wraps every command in its shell; the bridge judges and shows the script inside.
      { tool: 'command_execution', summary: 'touch x.txt', readOnly: false, command: 'touch x.txt' },
      { tool: 'file_change', summary: '修改文件：/repo/notes.md' },
    ]);
    expect(turn).toContainEqual({ type: 'final_text', content: 'decisions: accept,decline' });
    expect(turn).toContainEqual({ type: 'tool_use', id: 'fc-1', name: 'file_change', input: { paths: ['/repo/notes.md'] } });
    expect((await fake.messages())[2]?.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'untrusted' });
    await run.stop();
  });
});
