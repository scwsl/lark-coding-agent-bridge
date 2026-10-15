import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { CodexConfig } from '../../config/profile-schema';
import { mergeProcessEnv, spawnProcess } from '../../platform/spawn';
import type { QuotaReading, QuotaReadOptions, QuotaWindow } from '../quota';

/**
 * Codex's rate-limit windows through `codex app-server`: `initialize` →
 * `initialized` → `account/rateLimits/read`, then the process is closed. No
 * thread, no turn, and never `account/rateLimitResetCredit/consume`. Real
 * response sample: tests/fixtures/codex-rate-limits.json.
 */
export async function readCodexQuota(
  codex: Pick<CodexConfig, 'binaryPath' | 'codexHome' | 'inheritCodexHome' | 'env'> | undefined,
  opts: QuotaReadOptions,
): Promise<QuotaReading | undefined> {
  if (!codex?.binaryPath) return undefined;
  const home = codex.codexHome ?? (codex.inheritCodexHome === true || !opts.profileDir ? undefined : join(opts.profileDir, 'codex-home'));
  const child = spawnProcess(codex.binaryPath, ['app-server', '--listen', 'stdio://'], {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: mergeProcessEnv(process.env, { ...(codex.env ?? {}), ...(home ? { CODEX_HOME: home } : {}) }),
  });
  const send = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);
  try {
    const result = await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), opts.timeoutMs ?? 30_000);
      timer.unref?.();
      const done = (value: unknown) => {
        clearTimeout(timer);
        resolve(value);
      };
      child.once('error', () => done(undefined));
      child.once('exit', () => done(undefined));
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', (line) => {
        let message: { id?: unknown; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          return;
        }
        if (message.id === 1) {
          if (message.error) return done(undefined);
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (message.id === 2) {
          done(message.error ? undefined : message.result);
        }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'lark-channel-bridge', version: '1.0.0' } } });
    });
    return result === undefined ? undefined : parseCodexRateLimits(result);
  } finally {
    child.stdin?.end();
    child.kill('SIGTERM');
  }
}

interface RateWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

export function parseCodexRateLimits(result: unknown): QuotaReading | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const raw = result as {
    ordinaryUsageAllowed?: unknown;
    rateLimits?: unknown;
    rateLimitsByLimitId?: Record<string, unknown>;
  };
  const bucket = (raw.rateLimitsByLimitId?.codex ?? raw.rateLimits) as
    | { primary?: RateWindow | null; secondary?: RateWindow | null; rateLimitReachedType?: unknown; spendControlReached?: unknown }
    | undefined;
  if (!bucket || typeof bucket !== 'object') return undefined;
  const windows: QuotaWindow[] = [];
  for (const window of [bucket.primary, bucket.secondary]) {
    if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) continue;
    const minutes = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : undefined;
    windows.push({
      label: minutes === 300 ? '5 小时窗口' : minutes === 10_080 ? '本周' : minutes ? `${minutes} 分钟窗口` : '额度窗口',
      usedPercent: window.usedPercent,
      ...(typeof window.resetsAt === 'number' ? { resets: new Date(window.resetsAt * 1000).toISOString() } : {}),
    });
  }
  const blocked =
    raw.ordinaryUsageAllowed === false ||
    (bucket.rateLimitReachedType !== null && bucket.rateLimitReachedType !== undefined) ||
    bucket.spendControlReached === true;
  return { windows, ...(blocked ? { blocked: true } : {}) };
}
