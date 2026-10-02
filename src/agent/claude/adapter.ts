import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { isAlive, listDescendants, signalAll } from '../process-tree';
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { translateEvent } from './stream-json';

export interface ClaudeAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
}

type ClaudeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'claude',
      agentName: 'Claude Code',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for ClaudeAdapter.run');
    }

    // The prompt and bridge system prompt must NOT go through argv. On Windows,
    // `claude` resolves to a `claude.cmd` shim and cross-spawn routes it through
    // `cmd.exe /d /s /c`, which interprets `<` and `>` as redirection operators
    // — that silently eats the prompt's `<bridge_context>` XML, so claude runs
    // with an empty request and replies with its default greeting instead of a
    // stream-json response. Pass the prompt via stdin and the appended system
    // prompt via a temp file (the same approach the Codex adapter uses) so no
    // special characters ever reach the shell.
    const systemPromptFile = writeSystemPromptFile(buildBridgeSystemPrompt(this.botIdentity));

    // stdin stays open (`--input-format stream-json`) so mid-run supplements
    // can be fed in through `inject`; `--replay-user-messages` echoes each
    // message back once claude has consumed it, which is what tells a real
    // end of run apart from an intermediate turn (see ClaudeInput).
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--replay-user-messages',
      '--verbose',
      '--permission-mode',
      opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
      '--append-system-prompt-file',
      systemPromptFile.path,
    ];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ClaudeChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      effort: opts.effort,
    });

    // Listeners MUST be attached synchronously here, before we return.
    // The 'error' and exit-related events can fire in the next tick; if we
    // defer attachment to the async-generator body, those events fire into
    // the void and the generator hangs.
    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn claude: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
      systemPromptFile.cleanup();
    });
    const input = new ClaudeInput(child.stdin);
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      input.detach();
      systemPromptFile.cleanup();
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    input.write(opts.prompt);

    // Default 5s if caller didn't specify — claude often has live
    // subprocesses (lark-cli waiting for OAuth, long Bash, etc.) and the
    // old 500ms was nowhere near enough for them to flush state before the
    // SIGKILL cascade. Callers (channel.ts, /doctor) override per-run with
    // a value derived from preferences.
    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      pid: child.pid,
      events: createEventStream(child, stderrChunks, () => runtimeError, input),
      inject(prompt: string, preview: string): boolean {
        const ok = input.write(prompt, preview);
        log.info('agent', ok ? 'inject' : 'inject-refused', {
          pid: child.pid ?? null,
          promptChars: prompt.length,
        });
        return ok;
      },
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        // Take the whole tree down, not just claude: a stop has to end the
        // commands it started too (see listDescendants).
        const descendants = child.pid ? listDescendants(child.pid) : [];
        log.info('agent', 'stop-sigterm', {
          pid: child.pid ?? null,
          graceMs: stopGraceMs,
          descendants: descendants.length,
        });
        child.kill('SIGTERM');
        signalAll(descendants, 'SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            const survivors = descendants.filter(isAlive);
            if (child.exitCode === null && child.signalCode === null) {
              // Anything spawned during the grace window is still attached.
              if (child.pid) survivors.push(...listDescendants(child.pid));
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
                descendants: survivors.length,
              });
              child.kill('SIGKILL');
            } else if (survivors.length > 0) {
              log.warn('agent', 'stop-sigkill-descendants', { count: survivors.length });
            }
            signalAll(survivors, 'SIGKILL');
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            // claude is gone, but a child that ignored SIGTERM may not be:
            // then let the timer above force it once the grace window ends.
            if (descendants.some(isAlive)) return;
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

/**
 * How long an intermediate `result` (one that left written input unconsumed)
 * may be followed by silence before we stop waiting for the next turn and
 * close stdin. claude normally starts the queued turn immediately; this only
 * guards against it never doing so.
 */
const NEXT_TURN_GUARD_MS = 30_000;

/**
 * The streaming stdin of one claude process, plus the bookkeeping that decides
 * when the run is really over. Every message written carries a uuid, and
 * `--replay-user-messages` echoes it back once claude actually consumes it —
 * a supplement sent mid-tool-call is echoed only when the tool finishes and
 * the model picks it up. A `result` therefore only ends the run when nothing
 * written is still unread; otherwise claude has another turn queued. That
 * also covers a resumed session whose first turn is a stale background-task
 * notification: its `result` arrives before the bridge prompt is read, and
 * treating it as the end used to swallow the user's message.
 */
class ClaudeInput {
  /** uuid → supplement preview (undefined for the run's initial prompt). */
  private readonly unread = new Map<string, string | undefined>();
  private closed = false;

  constructor(private readonly stdin: Writable) {}

  write(prompt: string, preview?: string): boolean {
    if (this.closed || this.stdin.destroyed || this.stdin.writableEnded) return false;
    const uuid = randomUUID();
    this.unread.set(uuid, preview);
    const line = JSON.stringify({
      type: 'user',
      uuid,
      session_id: '',
      parent_tool_use_id: null,
      message: { role: 'user', content: prompt },
    });
    this.stdin.write(`${line}\n`, 'utf8');
    return true;
  }

  /** Mark a replayed message as read; returns its preview if it was a supplement. */
  ack(uuid: unknown): string | undefined {
    if (typeof uuid !== 'string' || !this.unread.has(uuid)) return undefined;
    const preview = this.unread.get(uuid);
    this.unread.delete(uuid);
    return preview;
  }

  get unreadCount(): number {
    return this.unread.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** No more input: claude finishes whatever it has and exits. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.stdin.destroyed && !this.stdin.writableEnded) this.stdin.end();
  }

  /** The process is gone; refuse further writes without touching the pipe. */
  detach(): void {
    this.closed = true;
  }
}

interface ClaudeResultLine {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  isReplay?: boolean;
  uuid?: unknown;
}

async function* createEventStream(
  child: ClaudeChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  input: ClaudeInput,
): AsyncGenerator<AgentEvent> {
  // If fork itself failed synchronously, child.pid is undefined. The 'error'
  // event (ENOENT etc.) fires in the next tick, so also check getError().
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn claude: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
  let sawResult = false;
  let finished = false;
  let nextTurnGuard: ReturnType<typeof setTimeout> | undefined;
  const clearNextTurnGuard = (): void => {
    if (nextTurnGuard) clearTimeout(nextTurnGuard);
    nextTurnGuard = undefined;
  };
  try {
    for await (const line of rl) {
      sawStdout = true;
      clearNextTurnGuard();
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const raw = (parsed && typeof parsed === 'object' ? parsed : {}) as ClaudeResultLine;
      if (raw.type === 'user' && raw.isReplay === true) {
        const preview = input.ack(raw.uuid);
        if (preview !== undefined) yield { type: 'supplement', preview };
        continue;
      }
      if (raw.type === 'result') {
        sawResult = true;
        const failed = raw.is_error === true || (raw.subtype !== undefined && raw.subtype !== 'success');
        if (input.unreadCount > 0 && !failed && !input.isClosed) {
          log.info('agent', 'turn-result-more-input', {
            pid: child.pid ?? null,
            unread: input.unreadCount,
          });
          for (const evt of translateEvent(parsed)) {
            if (evt.type !== 'done') yield evt;
          }
          nextTurnGuard = setTimeout(() => {
            log.warn('agent', 'next-turn-guard-expired', {
              pid: child.pid ?? null,
              unread: input.unreadCount,
              guardMs: NEXT_TURN_GUARD_MS,
            });
            input.close();
          }, NEXT_TURN_GUARD_MS);
          continue;
        }
        input.close();
        finished = true;
      }
      yield* translateEvent(parsed);
    }
  } finally {
    clearNextTurnGuard();
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: 'error',
      message: `claude runtime error: ${earlyRuntimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }

  // When the child is killed by a signal, exitCode stays null and signalCode
  // carries the name. Both must be checked or we'll attach an 'exit' listener
  // for an event that already fired and hang forever.
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: `claude exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
  } else if (runtimeError) {
    yield {
      type: 'error',
      message: `claude runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
  } else if (sawResult && !finished) {
    // stdin was closed by the next-turn guard and claude exited cleanly
    // without another result: the last completed turn is the answer.
    yield { type: 'done', terminationReason: 'normal' };
  }
}

/**
 * Persist the appended system prompt to a throwaway temp file so it can be
 * passed via `--append-system-prompt-file` instead of argv. Returns the path
 * plus an idempotent, best-effort cleanup that removes the temp directory.
 */
function writeSystemPromptFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-claude-'));
  const path = join(dir, 'append-system-prompt.md');
  writeFileSync(path, content, 'utf8');
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: the OS will reclaim the temp dir eventually
      }
    },
  };
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
