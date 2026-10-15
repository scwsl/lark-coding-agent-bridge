import { runCapture } from '../../git/exec';
import type { QuotaReading, QuotaReadOptions, QuotaWindow } from '../quota';

/**
 * Claude Code's subscription windows from `claude -p "/usage"` — a local
 * command that prints the account's usage and starts no model turn. Output
 * (2026-10, real sample in tests/fixtures/claude-usage.txt):
 *
 *   Current session: 4% used · resets Oct 14, 3:19am (Asia/Shanghai)
 *   Current week (all models): 50% used · resets Oct 18, 2:59pm (Asia/Shanghai)
 *   Current week (Fable): 0% used · resets Oct 18, 3pm (Asia/Shanghai)
 *
 * Model-specific weekly windows only limit that model and are left out.
 */
export async function readClaudeQuota(opts: QuotaReadOptions, binary = 'claude'): Promise<QuotaReading | undefined> {
  const result = await runCapture(binary, opts.cwd, ['-p', '/usage'], { timeoutMs: opts.timeoutMs ?? 60_000, maxBytes: 64_000 });
  if (!result.ok) return undefined;
  const windows = parseClaudeUsage(result.stdout);
  return windows.length > 0 ? { windows } : undefined;
}

export function parseClaudeUsage(text: string): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const raw of text.split('\n')) {
    const match = /^\s*Current ([^:]+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/.exec(raw);
    if (!match) continue;
    const scope = match[1]!.trim();
    const label = scope === 'session' ? '5 小时窗口' : scope === 'week (all models)' ? '本周' : undefined;
    if (!label) continue;
    windows.push({ label, usedPercent: Number(match[2]), ...(match[3] ? { resets: match[3] } : {}) });
  }
  return windows;
}
