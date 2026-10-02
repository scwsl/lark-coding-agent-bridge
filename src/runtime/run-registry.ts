import { readFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import { isAlive } from './registry';

/**
 * What we need to know about an in-flight run to tell its chat that the run
 * died — after the fact, from a fresh process that has none of the run's
 * in-memory state. Deliberately small: everything here has to survive a
 * SIGKILL, so it is written before the run starts producing output.
 */
export interface RunRecord {
  runId: string;
  /** Session scope key (`chatId` or `chatId:threadId`). */
  scope: string;
  chatId: string;
  /** The message that triggered the run — what the notice replies to. */
  originMessageId: string;
  /** Topic id, so the notice lands in the right topic rather than at top level. */
  threadId?: string;
  /** First line of the prompt, for a recognisable notice. */
  promptPreview: string;
  startedAt: number;
  /** pid of the bridge daemon that owns this run. */
  ownerPid: number;
  /**
   * Who the run would be resumed for, recorded only for runs the bot owner
   * started — the only ones resumed without being asked again.
   */
  resumeAs?: { senderId: string; senderName?: string; chatType: 'p2p' | 'group' | 'topic'; locale?: 'zh' | 'en' };
  /** The task ledger the agent announced (see the system prompt), once it did. */
  ledger?: string;
}

/**
 * Records whose owner is alive but that are older than this are swept anyway.
 * Guards against a pid that got reused by an unrelated long-lived process,
 * which would otherwise pin a dead record in the file forever.
 */
export const RUN_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

type RunMap = Record<string, RunRecord>;

function isRunRecord(x: unknown): x is RunRecord {
  if (!x || typeof x !== 'object') return false;
  const r = x as Partial<RunRecord>;
  return (
    typeof r.runId === 'string' &&
    typeof r.scope === 'string' &&
    typeof r.chatId === 'string' &&
    typeof r.originMessageId === 'string' &&
    typeof r.promptPreview === 'string' &&
    typeof r.startedAt === 'number' &&
    typeof r.ownerPid === 'number'
  );
}

/**
 * Read a profile's runs file without constructing a registry — the observer
 * path for profiles some *other* process hosts. Never mutates the file.
 */
export async function readRunRecords(path: string): Promise<RunRecord[]> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    return Object.values(raw).filter(isRunRecord);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('run-registry', 'read-failed', { path, err: String(err) });
    }
    return [];
  }
}

/**
 * Durable list of runs that are currently executing. The in-memory
 * `ActiveRuns` dies with the process; this one is what lets the *next*
 * process discover that a run never finished.
 */
export class RunRegistry {
  private data: RunMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly pid: number;

  constructor(path: string = paths.runsFile, pid: number = process.pid) {
    this.path = path;
    this.pid = pid;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Record<string, unknown>;
      this.data = {};
      for (const [runId, entry] of Object.entries(raw)) {
        if (!isRunRecord(entry)) continue;
        this.data[runId] = entry;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.warn('run-registry', 'load-failed', { err: String(err) });
      this.data = {};
    }
  }

  start(rec: Omit<RunRecord, 'ownerPid'>): void {
    this.data[rec.runId] = { ...rec, ownerPid: this.pid };
    this.schedulePersist();
  }

  /** Add facts learned mid-run (e.g. its task ledger) to a live record. */
  annotate(runId: string, patch: Pick<RunRecord, 'ledger'>): void {
    const rec = this.data[runId];
    if (!rec) return;
    this.data[runId] = { ...rec, ...patch };
    this.schedulePersist();
  }

  finish(runId: string): void {
    if (!(runId in this.data)) return;
    delete this.data[runId];
    this.schedulePersist();
  }

  /**
   * Records left behind by a daemon that is gone — the SIGKILL / crash /
   * power-loss path. Removed from the registry as they are returned, so a
   * notice is sent at most once.
   */
  takeOrphans(now: number = Date.now()): RunRecord[] {
    const orphans = Object.values(this.data).filter((r) => {
      if (r.ownerPid === this.pid) return false;
      if (!isAlive(r.ownerPid)) return true;
      return now - r.startedAt > RUN_STALE_AFTER_MS;
    });
    if (orphans.length === 0) return [];
    for (const r of orphans) delete this.data[r.runId];
    this.schedulePersist();
    return orphans;
  }

  /**
   * Runs this process still owns — used on graceful shutdown, where we can
   * report the interruption ourselves instead of leaving it to the next boot.
   */
  takeOwn(): RunRecord[] {
    const own = Object.values(this.data).filter((r) => r.ownerPid === this.pid);
    if (own.length === 0) return [];
    for (const r of own) delete this.data[r.runId];
    this.schedulePersist();
    return own;
  }

  size(): number {
    return Object.keys(this.data).length;
  }

  /** Non-mutating snapshot of the records this process owns. */
  listOwn(): RunRecord[] {
    return Object.values(this.data).filter((r) => r.ownerPid === this.pid);
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    const snapshot = { ...this.data };
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(snapshot, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => {
        log.fail('run-registry', err, { step: 'persist' });
      });
  }
}
