import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { PendingRotation } from './smart-session';

/** One scope's agent-requested close, as written to disk. */
export interface StoredRotation extends PendingRotation {
  requestedAt: number;
}

type RotationMap = Record<string, StoredRotation>;

/** A request nobody followed up on for this long is dropped at load. */
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

function isStoredRotation(x: unknown): x is StoredRotation {
  if (!x || typeof x !== 'object') return false;
  const r = x as Partial<StoredRotation>;
  return (
    typeof r.requestedAt === 'number' &&
    (r.summary === undefined || typeof r.summary === 'string') &&
    (r.handle === undefined || typeof r.handle === 'string')
  );
}

/**
 * 会话智能压缩: scopes whose last answer ended with `[[NEW_SESSION]]`, waiting
 * for the next message to start a fresh conversation. Kept on disk so a
 * restart between the answer and that message doesn't silently keep the old
 * conversation. Without a path (tests that omit appPaths) it is memory-only.
 */
export class PendingRotationStore {
  private data: RotationMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string | undefined;

  constructor(path?: string) {
    this.path = path;
  }

  async load(now: number = Date.now()): Promise<void> {
    if (!this.path) return;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
      this.data = {};
      for (const [scope, entry] of Object.entries(raw)) {
        if (isStoredRotation(entry) && now - entry.requestedAt < MAX_AGE_MS) this.data[scope] = entry;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.warn('rotation-store', 'load-failed', { err: String(err) });
      this.data = {};
    }
  }

  get(scope: string): StoredRotation | undefined {
    return this.data[scope];
  }

  set(scope: string, rotation: PendingRotation, now: number = Date.now()): void {
    this.data[scope] = { ...rotation, requestedAt: now };
    this.schedulePersist();
  }

  /** The scope's request, removed as it is returned. */
  take(scope: string): StoredRotation | undefined {
    const entry = this.data[scope];
    if (!entry) return undefined;
    delete this.data[scope];
    this.schedulePersist();
    return entry;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    if (!this.path) return;
    const path = this.path;
    const snapshot = JSON.stringify(this.data);
    this.saving = this.saving
      .then(() => writeFileAtomic(path, snapshot, { mode: 0o600 }))
      .catch((err) => log.warn('rotation-store', 'persist-failed', { err: String(err) }));
  }
}
