import { appendFile, readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

export interface AuditEntry {
  at: number;
  /** `tool`: a side-effecting step a run took; `approval`: an approval's lifecycle. */
  kind: 'tool' | 'approval';
  event?: string;
  actorId: string;
  actorName?: string;
  source: string;
  scopeId: string;
  chatId?: string;
  agent?: string;
  tool: string;
  summary: string;
  gated?: boolean;
  approvalId?: string;
  decidedBy?: string;
  allowTurn?: boolean;
}

const RETAIN_DAYS = 90;

/**
 * Who had the bot do what: an append-only JSONL file in the profile dir
 * (0600). Old lines are dropped on load; nothing else ever rewrites it.
 */
export class AuditLog {
  private readonly path: string;
  private writing: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
  }

  /** Drop entries past the retention window. */
  async load(): Promise<void> {
    const entries = await this.readAll();
    const cutoff = this.now() - RETAIN_DAYS * 86_400_000;
    const kept = entries.filter((e) => e.at >= cutoff);
    if (kept.length !== entries.length) {
      await writeFileAtomic(this.path, kept.map((e) => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 });
    }
  }

  append(entry: Omit<AuditEntry, 'at'> & { at?: number } | Record<string, unknown>): void {
    const line = `${JSON.stringify({ at: this.now(), ...entry })}\n`;
    this.writing = this.writing
      .then(() => appendFile(this.path, line, { mode: 0o600 }))
      .catch((err) => log.warn('audit', 'append-failed', { err: String(err) }));
  }

  /** Newest first. */
  async query(opts: { sinceMs?: number; actorId?: string; limit: number }): Promise<AuditEntry[]> {
    await this.writing;
    const since = opts.sinceMs ?? 0;
    return (await this.readAll())
      .filter((e) => e.at >= since && (!opts.actorId || e.actorId === opts.actorId))
      .reverse()
      .slice(0, opts.limit);
  }

  async flush(): Promise<void> {
    await this.writing;
  }

  private async readAll(): Promise<AuditEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('audit', 'read-failed', { err: String(err) });
      return [];
    }
    const out: AuditEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (typeof entry.at === 'number' && typeof entry.actorId === 'string') out.push(entry);
      } catch {
        // a torn line from a crash mid-append
      }
    }
    return out;
  }
}
