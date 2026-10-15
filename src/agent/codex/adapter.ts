import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SandboxMode } from '../../config/profile-schema';
import type { EffortLevel } from '../../config/schema';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { clampCodexEffort } from '../models';
import { buildCodexArgs, codexCompactionArgs } from './argv';
import { CodexJsonlTranslator, type CodexFinishReason } from './jsonl';
import { readThreadUsageBaseline, subtractBaseline, type CodexUsageTotals } from './thread-usage';
import { startCodexAppServerRun } from './app-server-run';
import pkg from '../../../package.json';

export interface CodexAdapterOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
  /** Profile-configured extras for the codex child (`codex.env`); bridge-managed keys win. */
  env?: Record<string, string>;
  /** See CodexConfig.transport; defaults to `app-server`. */
  transport?: 'app-server' | 'exec';
}

/** Variables the bridge sets itself; a profile's `codex.env` must not shadow them. */
function isBridgeManagedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return upper === 'CODEX_HOME' || upper.startsWith('LARK_CHANNEL') || upper === 'LARKSUITE_CLI_CONFIG_DIR';
}

type CodexChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly codexHome: string | undefined;
  private readonly inheritCodexHome: boolean;
  private readonly ignoreUserConfig: boolean;
  private readonly ignoreRules: boolean;
  private readonly sandbox: SandboxMode;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  /** Thread usage read in prepareRun, keyed by runId, consumed by run. */
  private readonly usageBaselines = new Map<string, CodexUsageTotals | undefined>();
  /** Transport chosen in prepareRun, keyed by runId; unprepared runs use `exec`. */
  private readonly transports = new Map<string, 'app-server' | 'exec'>();
  private readonly transport: 'app-server' | 'exec';
  /** Set once an app-server never managed to open a conversation; later runs use exec. */
  private appServerUnavailable: string | undefined;
  private readonly extraEnv: Record<string, string>;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: CodexAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.codexHome = opts.codexHome;
    this.inheritCodexHome = opts.inheritCodexHome !== false;
    this.ignoreUserConfig = opts.ignoreUserConfig === true;
    this.ignoreRules = opts.ignoreRules !== false;
    this.transport = opts.transport ?? 'app-server';
    this.sandbox = opts.sandbox ?? 'danger-full-access';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
    this.extraEnv = Object.fromEntries(
      Object.entries(opts.env ?? {}).filter(([key]) => !isBridgeManagedEnvKey(key)),
    );
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'codex',
      agentName: 'Codex CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(opts?: AgentRunOptions): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
    if (!opts) return;
    const transport = await this.chooseTransport(opts);
    this.transports.set(opts.runId, transport);
    // `exec` reports thread-cumulative usage: read the resumed thread's usage
    // so far before Codex starts appending this run's turn to the rollout.
    // (The app-server reports per-call usage, so it needs no baseline.)
    if (transport === 'exec' && opts.threadId) {
      this.usageBaselines.set(opts.runId, await this.readBaseline(opts.threadId));
    }
  }

  /**
   * The app-server keeps one process per conversation, but it has no
   * equivalent of `exec`'s --ignore-user-config / --ignore-rules; profiles
   * that rely on those stay on `exec`.
   */
  private async chooseTransport(opts: AgentRunOptions): Promise<'app-server' | 'exec'> {
    if (this.transport === 'exec' || this.ignoreUserConfig || this.appServerUnavailable) return 'exec';
    if (this.ignoreRules && (await hasExecpolicyRules(this.codexHomeDir(), opts.cwd))) return 'exec';
    return 'app-server';
  }

  private childEnv(): NodeJS.ProcessEnv {
    const envOverrides: NodeJS.ProcessEnv = { ...this.extraEnv, ...buildLarkChannelEnv(this.larkChannel) };
    if (this.codexHome) {
      envOverrides.CODEX_HOME = this.codexHome;
    } else if (!this.inheritCodexHome) {
      envOverrides.CODEX_HOME = join(this.profileStateDir, 'codex-home');
    }
    return mergeProcessEnv(process.env, envOverrides);
  }

  private readBaseline(threadId: string): Promise<CodexUsageTotals | undefined> {
    return readThreadUsageBaseline(this.codexHomeDir(), threadId).catch(() => undefined);
  }

  /** The CODEX_HOME a spawned run uses (mirrors the env set in `run`). */
  private codexHomeDir(): string {
    if (this.codexHome) return this.codexHome;
    if (!this.inheritCodexHome) return join(this.profileStateDir, 'codex-home');
    return this.extraEnv.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex');
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for CodexAdapter.run');
    }

    // Fit the stored level to the chosen model so an over-high pick steps
    // down instead of Codex rejecting the run.
    const effort = clampCodexEffort(opts.model, opts.effort as EffortLevel | undefined);
    const transport = this.transports.get(opts.runId) ?? 'exec';
    this.transports.delete(opts.runId);
    if (transport === 'app-server') {
      const run = startCodexAppServerRun({
        runId: opts.runId,
        binary: this.binary,
        cwd: opts.cwd,
        env: this.childEnv(),
        config: [
          '-c', 'approval_policy="never"',
          '-c', 'shell_environment_policy.inherit="all"',
          ...codexCompactionArgs(opts.compactWindowTokens),
        ],
        prompt: prefixBridgeSystemPrompt(opts.prompt, this.botIdentity),
        ...(opts.images?.length ? { images: opts.images } : {}),
        ...(opts.threadId ? { threadId: opts.threadId } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(effort ? { effort } : {}),
        sandbox: opts.sandbox ?? this.sandbox,
        stopGraceMs: opts.stopGraceMs ?? this.defaultStopGraceMs,
        clientVersion: pkg.version,
        ...(opts.approvals ? { approvals: opts.approvals } : {}),
        onStartupFailure: (reason) => {
          // This Codex can't serve the app-server protocol (too old, or it
          // hangs): stop trying, so the next message goes through exec.
          this.appServerUnavailable = reason;
          log.warn('agent', 'codex-app-server-disabled', { reason: reason.slice(0, 300) });
        },
      });
      // Later turns get the same bridge system prompt the first one did.
      return { ...run, send: (prompt: string) => run.send?.(prefixBridgeSystemPrompt(prompt, this.botIdentity)) ?? false };
    }
    const args = buildCodexArgs({
      cwd: opts.cwd,
      // exec can't ask anyone: a gated run there stays read-only.
      sandbox: opts.approvals ? 'read-only' : (opts.sandbox ?? this.sandbox),
      threadId: opts.threadId,
      images: opts.images,
      ignoreUserConfig: this.ignoreUserConfig,
      ignoreRules: this.ignoreRules,
      model: opts.model,
      effort,
      compactWindowTokens: opts.compactWindowTokens,
    });
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: this.childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as CodexChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasThread: Boolean(opts.threadId),
      promptChars: opts.prompt.length,
      images: opts.images?.length ?? 0,
      model: opts.model,
      effort,
      compactWindowTokens: opts.compactWindowTokens,
    });

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
          runtimeError = new Error(`failed to spawn codex: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let stopReason: CodexFinishReason | undefined;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end(prefixBridgeSystemPrompt(opts.prompt, this.botIdentity), 'utf8');
    // `turn.completed` carries thread-cumulative totals; this run is measured
    // from the thread's totals before it (read in prepareRun when possible).
    const prepared = this.usageBaselines.has(opts.runId);
    const baseline: Promise<CodexUsageTotals | undefined> = prepared
      ? Promise.resolve(this.usageBaselines.get(opts.runId))
      : opts.threadId
        ? this.readBaseline(opts.threadId)
        : Promise.resolve(undefined);
    this.usageBaselines.delete(opts.runId);

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, () => stopReason, baseline),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
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

async function* createEventStream(
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => CodexFinishReason | undefined,
  usageBaseline: Promise<CodexUsageTotals | undefined>,
): AsyncGenerator<AgentEvent> {
  const translator = new CodexJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
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
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      for (const evt of translator.translate(parsed)) {
        yield evt.type === 'usage' ? subtractBaseline(evt, await usageBaseline) : evt;
      }
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield* translator.fail(`codex runtime error: ${earlyRuntimeError.message}`);
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    if (!translator.terminalEmitted()) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      yield* translator.fail(`codex exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield* translator.fail(`codex runtime error: ${runtimeError.message}`);
    return;
  }

  yield* translator.finish();
}

async function waitForExitCode(child: CodexChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}

/**
 * Whether Codex would load execpolicy `.rules` files for this run — the user
 * ones under CODEX_HOME or the project's own — which `--ignore-rules` keeps
 * out on `exec` but the app-server has no switch for.
 */
async function hasExecpolicyRules(codexHome: string, cwd: string | undefined): Promise<boolean> {
  const dirs = [join(codexHome, 'rules'), ...(cwd ? [join(cwd, '.codex', 'rules')] : [])];
  for (const dir of dirs) {
    try {
      if ((await readdir(dir)).some((name) => name.endsWith('.rules'))) return true;
    } catch {
      // No such directory: nothing to load from it.
    }
  }
  return false;
}
