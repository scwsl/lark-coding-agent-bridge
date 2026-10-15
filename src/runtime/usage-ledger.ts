import { readFile } from 'node:fs/promises';
import type { AgentEvent } from '../agent/types';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

export interface UsageTotals {
  /** Agent turns (one per usage report). */
  turns: number;
  /** Whole prompt, cached part included. */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Estimate; Codex reports none, so this only covers agents that do. */
  costUsd: number;
}

export interface UsageEntry {
  actorId: string;
  /** Latest display name seen for the actor, for reports. */
  actorName?: string;
  /** Where the run came from: im / card / comment / meeting / cron / doctor… */
  source: string;
  scopeId: string;
  usage: Extract<AgentEvent, { type: 'usage' }>;
  at?: number;
}

interface ActorDay {
  total: UsageTotals;
  bySource: Record<string, UsageTotals>;
  byScope: Record<string, UsageTotals>;
}

interface LedgerData {
  version: 1;
  /** Local calendar day (YYYY-MM-DD) → actor id → that day's consumption. */
  days: Record<string, Record<string, ActorDay>>;
  names: Record<string, string>;
}

export interface UsageReportRow {
  actorId: string;
  actorName?: string;
  total: UsageTotals;
  bySource: Record<string, UsageTotals>;
}

/** Days of history kept; enough for a monthly view. */
const RETAIN_DAYS = 35;

export function emptyTotals(): UsageTotals {
  return { turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function addInto(target: UsageTotals, add: UsageTotals): void {
  target.turns += add.turns;
  target.inputTokens += add.inputTokens;
  target.cachedInputTokens += add.cachedInputTokens;
  target.outputTokens += add.outputTokens;
  target.costUsd += add.costUsd;
}

export function localDayKey(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Per-profile record of who consumed how much of the owner's agent quota,
 * aggregated per local day so `/usage` stays a cheap lookup. Written with
 * the same atomic 0600 discipline as the other runtime state.
 */
export class UsageLedger {
  private data: LedgerData = { version: 1, days: {}, names: {} };
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<LedgerData>;
      if (raw && raw.version === 1 && raw.days && typeof raw.days === 'object') {
        this.data = { version: 1, days: raw.days, names: raw.names ?? {} };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.warn('usage-ledger', 'load-failed', { err: String(err) });
    }
  }

  record(entry: UsageEntry): void {
    const add: UsageTotals = {
      turns: 1,
      inputTokens: entry.usage.inputTokens ?? 0,
      cachedInputTokens: entry.usage.cachedInputTokens ?? 0,
      outputTokens: entry.usage.outputTokens ?? 0,
      costUsd: entry.usage.costUsd ?? 0,
    };
    const at = entry.at ?? Date.now();
    const day = (this.data.days[localDayKey(at)] ??= {});
    const actor = (day[entry.actorId] ??= { total: emptyTotals(), bySource: {}, byScope: {} });
    addInto(actor.total, add);
    addInto((actor.bySource[entry.source] ??= emptyTotals()), add);
    addInto((actor.byScope[entry.scopeId] ??= emptyTotals()), add);
    if (entry.actorName) this.data.names[entry.actorId] = entry.actorName;
    this.prune(at);
    this.schedulePersist();
  }

  /**
   * Consumption per actor over the `days` local days ending today, heaviest
   * first. Pass `actorId` to restrict the report to one person.
   */
  report(opts: { days: number; actorId?: string; now?: number }): UsageReportRow[] {
    const now = opts.now ?? Date.now();
    const rows = new Map<string, UsageReportRow>();
    for (let i = 0; i < opts.days; i++) {
      const day = this.data.days[localDayKey(now - i * 86_400_000)];
      if (!day) continue;
      for (const [actorId, usage] of Object.entries(day)) {
        if (opts.actorId && actorId !== opts.actorId) continue;
        let row = rows.get(actorId);
        if (!row) {
          row = { actorId, ...(this.data.names[actorId] ? { actorName: this.data.names[actorId] } : {}), total: emptyTotals(), bySource: {} };
          rows.set(actorId, row);
        }
        addInto(row.total, usage.total);
        for (const [source, totals] of Object.entries(usage.bySource)) {
          addInto((row.bySource[source] ??= emptyTotals()), totals);
        }
      }
    }
    return [...rows.values()].sort(
      (a, b) => b.total.costUsd - a.total.costUsd || b.total.inputTokens + b.total.outputTokens - (a.total.inputTokens + a.total.outputTokens),
    );
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private prune(now: number): void {
    const oldest = localDayKey(now - (RETAIN_DAYS - 1) * 86_400_000);
    for (const key of Object.keys(this.data.days)) {
      if (key < oldest) delete this.data.days[key];
    }
  }

  private schedulePersist(): void {
    const snapshot = JSON.stringify(this.data);
    this.saving = this.saving
      .then(() => writeFileAtomic(this.path, snapshot, { mode: 0o600 }))
      .catch((err) => log.warn('usage-ledger', 'persist-failed', { err: String(err) }));
  }
}

/** `12.3k` / `1.2M` style token count. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

/** Short one-line usage summary for card bylines: `24.8k in / 51 out · ≈$0.03`. */
export function formatUsageLine(totals: Pick<UsageTotals, 'inputTokens' | 'outputTokens' | 'costUsd'>): string {
  const cost = totals.costUsd > 0 ? ` · ≈$${totals.costUsd < 0.01 ? totals.costUsd.toFixed(3) : totals.costUsd.toFixed(2)}` : '';
  return `${formatTokens(totals.inputTokens)} in / ${formatTokens(totals.outputTokens)} out${cost}`;
}
