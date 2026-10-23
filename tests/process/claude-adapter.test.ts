import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';
import { ownerOnlyGuard } from '../../src/policy/owner-guard.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('ClaudeAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh run with stream-json, verbose, permission mode, and bridge prompt args', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-fresh' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-fresh',
      prompt: 'hello',
      cwd: fake.dir,
      permissionMode: 'acceptEdits',
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-fresh', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(await realpath(fake.dir));
    expect(record.env.LARK_CHANNEL).toBe('1');
    // The prompt goes via stdin, and the bridge system prompt via a temp file,
    // so neither ever touches argv (which cmd.exe would mangle on Windows).
    expect(record.stdin).toBe('hello');
    expect(record.argv.slice(0, 10)).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--replay-user-messages',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--append-system-prompt-file',
    ]);
    expect(record.argv).not.toContain('hello');
    expect(record.systemPrompt).toContain('lark-channel-bridge 运行约定');
    expect(record.systemPrompt).toContain('__bridge_cb');
    expect(record.systemPrompt).toContain('LARK_CHANNEL_PROFILE');
    expect(record.systemPrompt).toContain('LARKSUITE_CLI_CONFIG_DIR');
    expect(record.systemPrompt).not.toContain('lark-cli config bind --source lark-channel');
    expect(record.systemPrompt).not.toContain('__claude_cb');
    expect(record.argv).not.toContain('--resume');
    expect(record.argv).not.toContain('--model');
  });

  it('injects the active bridge profile env into spawned runs', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-profile' }],
    });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'codex-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', 'codex-dev', 'lark-cli-source', 'config.json');

    const run = new ClaudeAdapter({
      binary: fake.path,
      larkChannel: {
        profile: 'codex-dev',
        rootDir,
        configPath,
        larkCliConfigDir,
        larkCliSourceConfigFile,
      },
    }).run({
      runId: 'run-profile-env',
      prompt: 'profile',
      cwd: fake.dir,
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'codex-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
    });
  });

  it('passes resume and model after the base CLI contract', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-resumed' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: fake.dir,
      sessionId: 'sess-old',
      model: 'sonnet',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-resumed', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(record.argv.slice(-4)).toEqual(['--resume', 'sess-old', '--model', 'sonnet']);
    expect(record.argv[8]).toBe('bypassPermissions');
  });

  it('includes stderr when the process exits non-zero', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'before failure' }] } }],
      stderr: 'boom\n',
      exitCode: 42,
      exitWithoutEof: true,
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'claude exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    let run: ReturnType<ClaudeAdapter['run']>;
    if (process.platform === 'win32') {
      const fake = await createFakeClaude({
        lines: [],
        stderr: 'missing command\n',
        exitCode: 1,
      });
      cleanup.push(fake.dir);
      run = new ClaudeAdapter({ binary: fake.path }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: fake.dir,
      });
    } else {
      const missing = join(tmpdir(), `missing-claude-${Date.now()}`);
      run = new ClaudeAdapter({ binary: missing }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: tmpdir(),
      });
    }

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn claude|spawn returned no pid|claude exited with code/,
    );
  });

  it('waits for post-done process exit before stop fallback is needed', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-tail' }],
      exitDelayMs: 150,
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-tail',
      prompt: 'tail',
      cwd: fake.dir,
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', sessionId: 'sess-tail', terminationReason: 'normal' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    expect(await run.waitForExit(1_000)).toBe(true);
    await iterator.return?.();
  });

  it('does not end the run on a result that arrives before the prompt is read', async () => {
    // A resumed session can first flush a stale background-task notification
    // turn; its result must not be mistaken for the answer to our prompt.
    const fake = await createFakeClaude({
      lines: [
        { type: 'result', session_id: 'sess-stale', result: 'stale notification' },
        REPLAY,
        { type: 'assistant', message: { content: [{ type: 'text', text: 'real answer' }] } },
        { type: 'result', session_id: 'sess-stale' },
      ],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-stale',
      prompt: 'question',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'real answer' },
      { type: 'done', sessionId: 'sess-stale', terminationReason: 'normal' },
    ]);
  });

  it('folds an injected supplement into the running run', async () => {
    const fake = await createFakeClaude({
      lines: [
        REPLAY,
        { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
      ],
      followUps: [
        [
          REPLAY,
          { type: 'assistant', message: { content: [{ type: 'text', text: 'with supplement' }] } },
          { type: 'result', session_id: 'sess-steer' },
        ],
      ],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-steer',
      prompt: 'task',
      cwd: fake.dir,
    });

    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'text' && event.delta === 'working') {
        expect(run.inject?.('supplement prompt', '补充：加上 BANANA')).toBe(true);
      }
    }

    expect(events).toEqual([
      { type: 'text', delta: 'working' },
      { type: 'supplement', preview: '补充：加上 BANANA' },
      { type: 'text', delta: 'with supplement' },
      { type: 'done', sessionId: 'sess-steer', terminationReason: 'normal' },
    ]);
    expect(run.inject?.('too late', 'late')).toBe(false);
    const record = await readRecord(fake.recordPath);
    expect(record.messages).toEqual(['task', 'supplement prompt']);
  });

  it('keeps going when a supplement lands just as a turn ends', async () => {
    // The supplement is written before claude reports the first result but is
    // only read afterwards, as a turn of its own.
    const fake = await createFakeClaude({
      lines: [REPLAY, { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }],
      followUps: [
        [
          { type: 'result', session_id: 'sess-late' },
          REPLAY,
          { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } },
          { type: 'result', session_id: 'sess-late' },
        ],
      ],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-late',
      prompt: 'task',
      cwd: fake.dir,
    });

    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'text' && event.delta === 'first') run.inject?.('more', '补充');
    }

    expect(events).toEqual([
      { type: 'text', delta: 'first' },
      { type: 'supplement', preview: '补充' },
      { type: 'text', delta: 'second' },
      { type: 'done', sessionId: 'sess-late', terminationReason: 'normal' },
    ]);
  });

  it('keeps taking input after a turn that left background tasks running', async () => {
    // The turn ends with a background sub-agent still at work: the process
    // must live on (stdin open) so the next message can be handed to it
    // instead of the bridge killing that work.
    const fake = await createFakeClaude({
      lines: [
        { type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 'agent-1' }] },
        { type: 'result', session_id: 'sess-bg' },
      ],
      followUps: [
        [
          { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'next' }] } },
          { type: 'result', session_id: 'sess-bg' },
        ],
      ],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-bg',
      prompt: 'task',
      cwd: fake.dir,
    });

    const events: AgentEvent[] = [];
    let handedOver: boolean | undefined;
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'done' && handedOver === undefined) handedOver = run.send?.('next message');
    }

    expect(handedOver).toBe(true);
    expect(events).toEqual([
      { type: 'background', count: 1 },
      { type: 'done', sessionId: 'sess-bg', terminationReason: 'normal' },
      { type: 'background', count: 0 },
      { type: 'text', delta: 'next' },
      { type: 'done', sessionId: 'sess-bg', terminationReason: 'normal' },
    ]);
    // No background task left after the second turn: input closed, process gone.
    expect(run.send?.('too late')).toBe(false);
    const record = await readRecord(fake.recordPath);
    expect(record.messages).toEqual(['task', 'next message']);
  });

  it('ends on an error result even with input still unread', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'sess-err' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-err',
      prompt: 'task',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-err', terminationReason: 'normal' },
    ]);
  });

  it('routes every tool call of a gated run through the approval hook', async () => {
    const fake = await createFakeClaude({ lines: [{ type: 'result', session_id: 'sess-gated' }] });
    cleanup.push(fake.dir);
    const decide = async () => ({ decision: 'deny' as const, reason: 'n/a' });

    await collect(
      new ClaudeAdapter({ binary: fake.path }).run({
        runId: 'run-gated',
        prompt: 'x',
        cwd: fake.dir,
        approvals: { hookCommand: "node /opt/hook.mjs '/tmp/s.sock' tok", hookTimeoutSec: 330, decide },
      }).events,
    );
    const gated = await readRecord(fake.recordPath);
    expect(gated.settings).toEqual({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: "node /opt/hook.mjs '/tmp/s.sock' tok", timeout: 330 }] }] },
    });
    expect(gated.argv[gated.argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
  });

  it('puts the owner guard and the approval hook in one settings file', async () => {
    const fake = await createFakeClaude({ lines: [{ type: 'result', session_id: 'sess-both' }] });
    cleanup.push(fake.dir);
    const guard = ownerOnlyGuard({
      larkChannelHome: join(fake.dir, '.lark-channel'),
      guestRoots: [],
      workspace: fake.dir,
      home: fake.dir,
    });

    await collect(
      new ClaudeAdapter({ binary: fake.path }).run({
        runId: 'run-both',
        prompt: 'x',
        cwd: fake.dir,
        guard,
        approvals: { hookCommand: 'node /opt/hook.mjs tok', hookTimeoutSec: 330, decide: async () => ({ decision: 'deny', reason: 'n/a' }) },
      }).events,
    );
    const record = await readRecord(fake.recordPath);
    // Claude takes a single `--settings`: both hooks must live in it.
    expect(record.argv.filter((a) => a === '--settings')).toHaveLength(1);
    const hooks = (record.settings as { hooks: { PreToolUse: Array<{ matcher: string }> } }).hooks.PreToolUse;
    expect(hooks.map((h) => h.matcher)).toEqual(['Bash|Read|Edit|MultiEdit|Write|NotebookEdit|Glob|Grep', '*']);
    // The guard's other flags still reach argv.
    expect(record.argv).toContain('--disallowedTools');
  });

  it('keeps a gated run read-only when no approval hook could be set up', async () => {
    const fake = await createFakeClaude({ lines: [{ type: 'result', session_id: 'sess-ro' }] });
    cleanup.push(fake.dir);
    await collect(
      new ClaudeAdapter({ binary: fake.path }).run({
        runId: 'run-ro',
        prompt: 'x',
        cwd: fake.dir,
        approvals: { decide: async () => ({ decision: 'deny', reason: 'n/a' }) },
      }).events,
    );
    const record = await readRecord(fake.recordPath);
    expect(record.argv[record.argv.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(record.settings).toBeNull();
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new ClaudeAdapter({ binary: 'unused' }).run({ runId: 'run-no-cwd', prompt: 'hi' }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** Marks where the fake echoes the message it just read (`--replay-user-messages`). */
const REPLAY = '$replay';

/**
 * A stream-json claude stand-in: reads one JSON message per stdin line and
 * answers the first with `lines`, the n-th follow-up with `followUps[n-1]`.
 * Each reply echoes the message at its `REPLAY` marker (or first, if absent)
 * and the fake exits once stdin closes — or right away with `exitWithoutEof`.
 */
async function createFakeClaude(options: {
  lines: unknown[];
  followUps?: unknown[][];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
  exitWithoutEof?: boolean;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-adapter-test-'));
  const path = join(dir, 'fake-claude.mjs');
  const recordPath = join(dir, 'argv.json');
  const turns = [options.lines, ...(options.followUps ?? [])];
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync, readFileSync } from "node:fs";',
      'import { createInterface } from "node:readline";',
      'const argv = process.argv.slice(2);',
      'const spIdx = argv.indexOf("--append-system-prompt-file");',
      'const systemPrompt = spIdx !== -1 ? readFileSync(argv[spIdx + 1], "utf8") : null;',
      'const setIdx = argv.indexOf("--settings");',
      'const settings = setIdx !== -1 ? JSON.parse(readFileSync(argv[setIdx + 1], "utf8")) : null;',
      `const turns = ${JSON.stringify(turns)};`,
      `const REPLAY = ${JSON.stringify(REPLAY)};`,
      'const messages = [];',
      'const finish = () => {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv,',
      '    stdin: messages[0] ?? "",',
      '    messages,',
      '    systemPrompt,',
      '    settings,',
      '    cwd: process.cwd(),',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '      LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '      LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '    },',
      '  }));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '};',
      'const rl = createInterface({ input: process.stdin });',
      'rl.on("line", (raw) => {',
      '  if (!raw.trim()) return;',
      '  const msg = JSON.parse(raw);',
      '  messages.push(msg.message.content);',
      '  const out = turns[messages.length - 1] ?? [];',
      '  const echo = { type: "user", isReplay: true, uuid: msg.uuid, message: msg.message };',
      '  if (!out.includes(REPLAY)) console.log(JSON.stringify(echo));',
      '  for (const line of out) console.log(JSON.stringify(line === REPLAY ? echo : line));',
      options.exitWithoutEof ? '  if (messages.length === 1) finish();' : '',
      '});',
      options.exitWithoutEof ? '' : 'rl.on("close", finish);',
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  stdin: string;
  messages: string[];
  systemPrompt: string | null;
  settings: unknown;
  cwd: string;
  env: {
    LARK_CHANNEL?: string;
    LARK_CHANNEL_PROFILE?: string;
    LARK_CHANNEL_HOME?: string;
    LARK_CHANNEL_CONFIG?: string;
    LARKSUITE_CLI_CONFIG_DIR?: string;
  };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    stdin: string;
    messages: string[];
    systemPrompt: string | null;
    settings: unknown;
    cwd: string;
    env: {
      LARK_CHANNEL?: string;
      LARK_CHANNEL_PROFILE?: string;
      LARK_CHANNEL_HOME?: string;
      LARK_CHANNEL_CONFIG?: string;
      LARKSUITE_CLI_CONFIG_DIR?: string;
    };
  };
}

