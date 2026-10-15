import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEvent } from '../types';

/** Token totals as Codex reports them: cumulative over a whole thread. */
export interface CodexUsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

type UsageEvent = Extract<AgentEvent, { type: 'usage' }>;

/**
 * `codex exec` reports the *thread's* running totals on `turn.completed`,
 * so a resumed run's figures include every earlier turn. The thread's
 * rollout file records the totals after each turn (`token_count` events);
 * the last one before a run starts is the baseline that run's own share is
 * measured from. Undefined when the rollout can't be found or has no totals.
 */
export async function readThreadUsageBaseline(
  codexHome: string,
  threadId: string,
): Promise<CodexUsageTotals | undefined> {
  const file = await findRollout(join(codexHome, 'sessions'), threadId);
  if (!file) return undefined;
  const lines = (await readFile(file, 'utf8')).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"token_count"')) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        payload?: { type?: string; info?: { total_token_usage?: Record<string, unknown> } | null };
      };
      const totals = entry.payload?.type === 'token_count' ? entry.payload.info?.total_token_usage : undefined;
      if (totals) return toTotals(totals);
    } catch {
      // A torn last line while Codex is still writing; keep looking upward.
    }
  }
  return undefined;
}

/** This run's own share of a thread-cumulative usage report. */
export function subtractBaseline(usage: UsageEvent, baseline: CodexUsageTotals | undefined): UsageEvent {
  if (!baseline) return usage;
  const minus = (value: number | undefined, base: number): number | undefined =>
    value === undefined ? undefined : Math.max(0, value - base);
  return {
    ...usage,
    inputTokens: minus(usage.inputTokens, baseline.inputTokens),
    cachedInputTokens: minus(usage.cachedInputTokens, baseline.cachedInputTokens),
    outputTokens: minus(usage.outputTokens, baseline.outputTokens),
    reasoningOutputTokens: minus(usage.reasoningOutputTokens, baseline.reasoningOutputTokens),
  };
}

export async function findRollout(sessionsDir: string, threadId: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir, { recursive: true });
  } catch {
    return undefined;
  }
  const suffix = `-${threadId}.jsonl`;
  const match = entries.filter((name) => name.endsWith(suffix)).sort().at(-1);
  return match ? join(sessionsDir, match) : undefined;
}

function toTotals(raw: Record<string, unknown>): CodexUsageTotals {
  const n = (key: string): number => (typeof raw[key] === 'number' ? (raw[key] as number) : 0);
  return {
    inputTokens: n('input_tokens'),
    cachedInputTokens: n('cached_input_tokens'),
    outputTokens: n('output_tokens'),
    reasoningOutputTokens: n('reasoning_output_tokens'),
  };
}
