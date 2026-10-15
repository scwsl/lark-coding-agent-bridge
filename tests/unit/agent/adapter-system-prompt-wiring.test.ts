import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import {
  buildBridgeSystemPrompt,
  prefixBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter';
import { CodexAdapter } from '../../../src/agent/codex/adapter';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
});

describe('ClaudeAdapter system prompt wiring', () => {
  it('appends the identity-aware bridge system prompt via a temp file after setBotIdentity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    // The prompt goes via stdin, never argv (cmd.exe would mangle it on Windows).
    expect(await readFirstStreamJsonPrompt(child.stdin)).toBe('hi');
    expect(systemPromptFileContent()).toBe(
      buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    expect(await readFirstStreamJsonPrompt(child.stdin)).toBe('hi');
    expect(systemPromptFileContent()).toBe(buildBridgeSystemPrompt(undefined));
  });

  it('asks Claude Code to auto-compact against the 会话智能压缩 window only when one is given', () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp', compactWindowTokens: 300_000 });
    adapter.run({ runId: 'r2', prompt: 'hi', cwd: '/tmp' });

    const envOf = (call: number) =>
      (spawnMock.spawnProcess.mock.calls[call]?.[2] as { env: NodeJS.ProcessEnv }).env;
    expect(envOf(0).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('300000');
    expect(envOf(1).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  });

  function systemPromptFileContent(): string {
    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    const flagIndex = args.indexOf('--append-system-prompt-file');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args).not.toContain('--append-system-prompt');
    return readFileSync(args[flagIndex + 1] as string, 'utf8');
  }
});

describe('CodexAdapter system prompt wiring', () => {
  function codexAdapter(): CodexAdapter {
    return new CodexAdapter({
      binary: '/usr/local/bin/codex',
      profileStateDir: '/tmp/codex-profile',
    });
  }

  it('prefixes stdin with the identity-aware bridge system prompt after setBotIdentity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = codexAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stdin = await readAll(child.stdin);
    expect(stdin).toBe(
      prefixBridgeSystemPrompt('hi', { openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = codexAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stdin = await readAll(child.stdin);
    expect(stdin).toBe(prefixBridgeSystemPrompt('hi', undefined));
  });
});

async function readAll(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Claude keeps stdin open (stream-json input); read just the first message. */
async function readFirstStreamJsonPrompt(stream: PassThrough): Promise<string> {
  let buf = '';
  for await (const chunk of stream) {
    buf += String(chunk);
    const nl = buf.indexOf('\n');
    if (nl !== -1) {
      const line = JSON.parse(buf.slice(0, nl)) as { message: { content: string } };
      return line.message.content;
    }
  }
  throw new Error('stdin ended before a full stream-json line');
}
