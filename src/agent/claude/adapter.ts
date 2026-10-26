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
import { claudeGuardArgs } from '../../policy/owner-guard';
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { claudeAccountName } from './account';
import { runWithAccountFailover } from './account-failover';
import { probeAccountQuota, refreshPickQuota } from './quota-probe';
import type { ClaudeAccountPool, PickedAccount } from './accounts';
import { restoredSessionCost } from './session-cost';
import { translateEvent } from './stream-json';

export interface ClaudeAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
  /** The profile's subscription accounts; runs move to another one when the quota runs out. */
  accounts?: ClaudeAccountPool;
  /**
   * Check a stale account's quota before a run starts on it (see
   * refreshPickQuota). Default true; tests whose fake CLI answers no probe turn it off.
   */
  probeQuota?: boolean;
}

type ClaudeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly accounts: ClaudeAccountPool | undefined;
  private botIdentity: AgentBotIdentity | undefined;
  /** When each account's quota was last checked before a run (see refreshPickQuota). */
  private readonly quotaCheckedAt = new Map<string, number>();
  private readonly probeQuota: boolean;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
    this.larkChannel = opts.larkChannel;
    this.accounts = opts.accounts;
    this.probeQuota = opts.probeQuota ?? true;
  }

  async prepareRun(opts?: AgentRunOptions): Promise<void> {
    // Pick up accounts added or removed since the last run.
    await this.accounts?.refresh();
    // Then check that the account the run would get still has the room the
    // bridge last saw: its owner may have used it since.
    if (this.probeQuota && this.accounts?.multi) {
      await refreshPickQuota(this.accounts, {
        ...(opts?.accountLineCap ? { cap: opts.accountLineCap } : {}),
        probe: (pool, account) => probeAccountQuota(pool, account, this.binary),
        checkedAt: this.quotaCheckedAt,
      });
    }
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
    const pool = this.accounts;
    if (!pool) return this.spawnRun(opts, undefined);
    return runWithAccountFailover(opts, {
      pool,
      spawn: (attemptOpts, account) => this.spawnRun(attemptOpts, account),
      labelOf: (account) => (account.env.CLAUDE_CODE_OAUTH_TOKEN ? Promise.resolve(account.label) : claudeAccountName()),
    });
  }

  /** One claude process, on `account` (undefined: the CLI's own login, untouched). */
  private spawnRun(opts: AgentRunOptions, account: PickedAccount | undefined): AgentRun {
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
    // end of run apart from an intermediate turn (see ClaudeInput). A turn
    // that ends with background tasks still running keeps it open too: the
    // process lives on to run the turns those tasks trigger, and the bridge
    // hands it the next user message (`send`) instead of killing that work.
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--replay-user-messages',
      '--verbose',
      '--permission-mode',
      gatedPermissionMode(opts),
      '--append-system-prompt-file',
      systemPromptFile.path,
    ];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    // The owner guard (non-owner runs) and the approval hook (gated runs) are
    // both PreToolUse hooks; Claude takes one `--settings`, so they share a
    // single settings *file* (also keeps quotes off argv for cmd.exe).
    const guard = opts.guard ? claudeGuardArgs(opts.guard) : undefined;
    const { args: guardArgs, settings: guardSettings } = splitSettingsArg(guard?.args ?? []);
    args.push(...guardArgs);
    const settings = mergeHookSettings(
      guardSettings,
      opts.approvals?.hookCommand
        ? approvalHookSettings(opts.approvals.hookCommand, opts.approvals.hookTimeoutSec ?? 330)
        : undefined,
    );
    const settingsFile = settings ? writeSettingsFile(settings) : undefined;
    if (settingsFile) args.push('--settings', settingsFile.path);

    // Read before spawn: the session total Claude is about to restore.
    const costBaseline = opts.sessionId ? (restoredSessionCost(opts.sessionId, opts.cwd) ?? 0) : 0;

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, {
        ...buildLarkChannelEnv(this.larkChannel),
        ...(guard?.env ?? {}),
        // 会话智能压缩: Claude Code auto-compacts against this window instead
        // of the model's full (up to 1M-token) one.
        ...(opts.compactWindowTokens ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(opts.compactWindowTokens) } : {}),
        // Subagents default to this model; one their definition or call names wins.
        ...(opts.subagentModel ? { CLAUDE_CODE_SUBAGENT_MODEL: opts.subagentModel } : {}),
        // Another subscription account: its token outranks the CLI's own login.
        ...(account?.env ?? {}),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ClaudeChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      effort: opts.effort,
      ...(account ? { account: account.id } : {}),
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
      settingsFile?.cleanup();
    });
    const input = new ClaudeInput(child.stdin);
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      input.detach();
      systemPromptFile.cleanup();
      settingsFile?.cleanup();
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
    // Set once stop() is asked for, so the SIGTERM exit (code 143) is read as
    // a stop — the same `interrupted` the codex adapter reports — not a crash.
    let stopRequested = false;

    return {
      runId: opts.runId,
      pid: child.pid,
      events: createEventStream(child, stderrChunks, () => runtimeError, input, () => stopRequested, costBaseline),
      send(prompt: string): boolean {
        const ok = input.write(prompt);
        log.info('agent', ok ? 'send' : 'send-refused', { pid: child.pid ?? null, promptChars: prompt.length });
        return ok;
      },
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
        stopRequested = true;
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
  wasStopped: () => boolean = () => false,
  costBaseline = 0,
): AsyncGenerator<AgentEvent> {
  // `total_cost_usd` is the session's running total: restored on resume, then
  // accumulated over every turn the process runs (supplements add turns).
  // Report each turn's own share. A total below the baseline means Claude
  // restored nothing, so count from zero rather than report a free turn.
  let costSoFar = costBaseline;
  const perTurnCost = (evt: AgentEvent): AgentEvent => {
    if (evt.type !== 'usage' || evt.costUsd === undefined) return evt;
    if (evt.costUsd < costSoFar) costSoFar = 0;
    const turnCost = evt.costUsd - costSoFar;
    costSoFar = evt.costUsd;
    return { ...evt, costUsd: turnCost };
  };
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
  // Background tasks claude last reported: stdin stays open while any run.
  let background = 0;
  const track = (evt: AgentEvent): AgentEvent => {
    if (evt.type === 'background') background = evt.count;
    return perTurnCost(evt);
  };
  // The `done` of the last turn that was not taken as the end: replayed if
  // claude exits without a final one, so the session id is not lost.
  let heldDone: AgentEvent | undefined;
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
            if (evt.type === 'done') heldDone = evt;
            else yield track(evt);
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
        // Background tasks still running: they report back as further turns
        // of this process, so keep it taking input (see RunExecutor linger).
        if (background === 0) input.close();
        else log.info('agent', 'turn-result-background', { pid: child.pid ?? null, background });
        finished = true;
      }
      for (const evt of translateEvent(parsed)) yield track(evt);
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

  if (wasStopped()) {
    // Asked to stop (/stop, the card's stop button, idle timeout, shutdown):
    // whatever the exit code, the run was ended on purpose.
    yield { type: 'done', terminationReason: 'interrupted' };
    return;
  }

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
    yield heldDone ?? { type: 'done', terminationReason: 'normal' };
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

/** A gated run whose approval hook could not be set up stays read-only (plan mode). */
function gatedPermissionMode(opts: AgentRunOptions): string {
  if (opts.approvals && !opts.approvals.hookCommand) return 'plan';
  return opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE;
}

/** Claude Code settings that route every tool call through the approval hook. */
export function approvalHookSettings(command: string, timeoutSec: number): HookSettings {
  return {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: timeoutSec }] }],
    },
  };
}

interface HookSettings {
  hooks: { PreToolUse: unknown[] };
}

/** Pull an inline `--settings <json>` out of an argv list. */
function splitSettingsArg(argv: string[]): { args: string[]; settings?: HookSettings } {
  const at = argv.indexOf('--settings');
  if (at < 0 || at + 1 >= argv.length) return { args: argv };
  return {
    args: [...argv.slice(0, at), ...argv.slice(at + 2)],
    settings: JSON.parse(argv[at + 1]!) as HookSettings,
  };
}

/** One settings object carrying every PreToolUse hook given. */
export function mergeHookSettings(...parts: (HookSettings | undefined)[]): HookSettings | undefined {
  const present = parts.filter((p): p is HookSettings => Boolean(p));
  if (present.length === 0) return undefined;
  return { hooks: { PreToolUse: present.flatMap((p) => p.hooks?.PreToolUse ?? []) } };
}

function writeSettingsFile(settings: object): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-claude-settings-'));
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600 });
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
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
