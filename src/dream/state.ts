import { readFile } from 'node:fs/promises';
import { isAgentKind, type AgentKind } from '../agent/registry';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { ExternalCursor } from './external';
import type { DreamAutoCheck, DreamAutoLedger } from './schedule';

/**
 * Local bookkeeping of 课堂精练 — never knowledge itself. What was proposed
 * lives in the target repositories' Draft PRs; this file only remembers which
 * conversations were already read, which runs happened and where their PRs
 * are, so a run is incremental and a half-finished publish can be resumed.
 * No transcript text is ever stored here.
 */

export type DreamRunStatus = 'queued' | 'running' | 'deferred' | 'succeeded' | 'failed' | 'cancelled';

/**
 * How far one target repository of a run got. `committed`: the draft exists as
 * a local commit only; `pushed`: the branch is on the remote but no PR yet;
 * `pr-created`: done. With `publish: push` (`direct`) the commit goes onto
 * the default branch itself and `published` is done. A retry picks up from
 * the phase it stopped at.
 */
export type DreamTargetPhase = 'skipped' | 'failed' | 'committed' | 'pushed' | 'pr-created' | 'published';

export interface DreamSessionRecord {
  /** `<agentId>:<handle>`. */
  key: string;
  agentId: AgentKind;
  /** Claude session id / Codex thread id. */
  handle: string;
  scopeId: string;
  cwd: string;
  firstSeenAt: number;
  /** Last time the bridge ran a turn in it (from the session catalog). */
  lastSeenAt: number;
  /** Exchanges already turned into a draft. */
  consumed: number;
  /** Hash of the last consumed exchange, to notice a rewritten transcript. */
  consumedHash?: string;
  /** When {@link consumed} last moved (or the conversation was found to hold nothing new). */
  consumedAt?: number;
}

export interface DreamTarget {
  /** `knowledge` or `skills:<library>`. */
  repo: string;
  label: string;
  branch: string;
  base?: string;
  commit?: string;
  phase: DreamTargetPhase;
  /** Proposals written into this repository. */
  items: number;
  prUrl?: string;
  prNumber?: number;
  error?: string;
  /** Local checkout, kept for retries and `/practice diff`. */
  checkoutDir?: string;
  /** PR title / body, kept so a retry opens exactly the PR the first try meant to. */
  title?: string;
  body?: string;
  /** Draft PR that reverts this target's merged batch (`/practice revert`). */
  revertPrUrl?: string;
  /** `publish: push`: committed on {@link base} itself and pushed there, no PR. */
  direct?: boolean;
}

export interface DreamRun {
  /** Batch id; also the `dream/<id>` branch name of every target. */
  id: string;
  status: DreamRunStatus;
  /** Who started it: an admin (`/practice run`, Web) or 自动整理. Absent in runs from before P2: manual. */
  trigger?: 'manual' | 'auto';
  actorId: string;
  startedAt: number;
  endedAt?: number;
  /** One line for status: the outcome, or why it was deferred / failed / cancelled. */
  note?: string;
  sessions: number;
  scopes: number;
  exchanges: number;
  memoryItems: number;
  skillItems: number;
  rejected: number;
  /** Conversations left for a later run, and why. */
  deferred: Array<{ key: string; reason: string }>;
  targets: DreamTarget[];
  /**
   * Every draft of the batch was committed and the cursors moved past its
   * input, in one write. Before this point an interrupted batch is dropped
   * whole (its input is read again); after it, its drafts are only ever
   * pushed / opened, never redone.
   */
  checkpointAt?: number;
  /** 课前学习 of this run: the commit each external library was read up to (cursor after the checkpoint). */
  external?: Array<{ library: string; head: string; files: number; pending: number; error?: string }>;
  /** 课前学习 read files but its turn failed: the libraries' cursors did not move. */
  learnFailed?: boolean;
  /** 续跑: the how-manieth run in a row of one start (absent: the first). */
  round?: number;
  /** An automatic run gave way to a user task before its checkpoint; what was done is kept, the rest deferred. */
  yielded?: boolean;
  /** 浅睡·召回统计 of this run: what the conversations read since the last scan. */
  recall?: { sessions: number; exchanges: number; reads: number };
  /** 梦境日记 of this run (Markdown), for `/practice diary`; only runs that got as far as publishing. */
  diary?: string;
}

interface DreamStateData {
  version: 1;
  sessions: Record<string, DreamSessionRecord>;
  runs: DreamRun[];
  /** Hashes of proposals already put into a PR: a rejected one is not proposed again. */
  published: string[];
  /** 自动整理 bookkeeping. */
  auto?: DreamAutoLedger;
  /** 课前学习: how far each external library has been read. */
  external?: Record<string, ExternalCursor>;
}

const MAX_SESSIONS = 1000;
const MAX_RUNS = 30;
const MAX_PUBLISHED = 5000;

export class DreamStateStore {
  private data: DreamStateData = { version: 1, sessions: {}, runs: [], published: [] };
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Load the file. A run still marked queued / running was cut off by a
   * restart: it is closed as failed — its sessions' cursors never moved, so
   * the next run reads the same input again, and any target that reached
   * `committed` / `pushed` is resumed rather than redone.
   *
   * `readOnly` is for a viewer in another process (the web console looking at
   * a profile run by its own daemon): runs are taken as they are and nothing
   * is written back.
   */
  async load(now = Date.now(), options: { readOnly?: boolean } = {}): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    let parsed: Partial<DreamStateData>;
    try {
      parsed = JSON.parse(text) as Partial<DreamStateData>;
    } catch (err) {
      log.warn('dream', 'state-parse-failed', { err: String(err) });
      return;
    }
    const sessions: Record<string, DreamSessionRecord> = {};
    for (const [key, raw] of Object.entries(parsed.sessions ?? {})) {
      const record = normalizeSession(key, raw);
      if (record) sessions[key] = record;
    }
    let interrupted = false;
    let cutAfterCheckpoint = 0;
    const runs = (Array.isArray(parsed.runs) ? parsed.runs : []).filter(isRun).map((run) => {
      if (options.readOnly || (run.status !== 'queued' && run.status !== 'running')) return run;
      interrupted = true;
      if (run.checkpointAt !== undefined) {
        cutAfterCheckpoint = Math.max(cutAfterCheckpoint, run.checkpointAt);
        // Drafts committed and input consumed: only pushing / opening PRs was
        // left, and the next run picks that up.
        return { ...run, status: 'succeeded' as const, endedAt: now, note: '进程重启时中断；草稿已保存，下一轮补推、补开 PR' };
      }
      // Cut off before the checkpoint: whatever was committed locally is
      // dropped — the input is read again and would otherwise be proposed twice.
      return {
        ...run,
        status: 'failed' as const,
        endedAt: now,
        note: '进程重启时中断，下次整理会重新读取这些会话',
        targets: run.targets.map((target) =>
          target.phase === 'committed' || target.phase === 'pushed'
            ? { ...target, phase: 'failed' as const, error: '进程重启时中断，草稿作废' }
            : target,
        ),
      };
    });
    const published = (Array.isArray(parsed.published) ? parsed.published : []).filter(
      (hash): hash is string => typeof hash === 'string',
    );
    let auto = normalizeAuto(parsed.auto);
    // A batch cut off after its checkpoint did read its input: it counts as
    // the last completed run for 间隔够.
    if (cutAfterCheckpoint > (auto?.lastCompletedAt ?? 0)) {
      auto = { ...(auto ?? { consecutiveFailures: 0 }), lastCompletedAt: cutAfterCheckpoint };
    }
    const external = normalizeExternal(parsed.external);
    this.data = { version: 1, sessions, runs, published, ...(auto ? { auto } : {}), ...(external ? { external } : {}) };
    if (interrupted) this.schedulePersist();
  }

  autoLedger(): DreamAutoLedger {
    const auto = this.data.auto ?? { consecutiveFailures: 0 };
    return { ...auto, ...(auto.lastCheck ? { lastCheck: cloneCheck(auto.lastCheck) } : {}) };
  }

  updateAuto(patch: Partial<DreamAutoLedger>): void {
    const next: DreamAutoLedger = { ...(this.data.auto ?? { consecutiveFailures: 0 }), ...patch };
    for (const key of Object.keys(next) as Array<keyof DreamAutoLedger>) if (next[key] === undefined) delete next[key];
    this.data.auto = next;
    this.schedulePersist();
  }

  externalCursor(library: string): ExternalCursor | undefined {
    const cursor = this.data.external?.[library];
    return cursor ? { ...cursor, ...(cursor.pending ? { pending: [...cursor.pending] } : {}) } : undefined;
  }

  /** Move external libraries' cursors outside a checkpoint (read, nothing worth drafting). */
  advanceExternal(cursors: Readonly<Record<string, ExternalCursor>>): void {
    if (Object.keys(cursors).length === 0) return;
    this.data.external = { ...(this.data.external ?? {}), ...cloneExternal(cursors) };
    this.schedulePersist();
  }

  /**
   * The batch's commit point, in one write: its drafts are committed, these
   * cursors move and these proposal hashes count as proposed.
   */
  checkpoint(
    id: string,
    at: number,
    advances: ReadonlyArray<{ key: string; consumed: number; hash: string }>,
    published: readonly string[],
    external: Readonly<Record<string, ExternalCursor>> = {},
  ): void {
    const run = this.data.runs.find((item) => item.id === id);
    if (!run) return;
    run.checkpointAt = at;
    if (Object.keys(external).length > 0) this.data.external = { ...(this.data.external ?? {}), ...cloneExternal(external) };
    for (const item of advances) {
      const record = this.data.sessions[item.key];
      if (!record) continue;
      const { consumedHash: _previous, ...rest } = record;
      this.data.sessions[item.key] = { ...rest, consumed: item.consumed, consumedHash: item.hash, consumedAt: at };
    }
    const fresh = published.filter((hash) => !this.data.published.includes(hash));
    this.data.published.push(...fresh);
    if (this.data.published.length > MAX_PUBLISHED) {
      this.data.published.splice(0, this.data.published.length - MAX_PUBLISHED);
    }
    this.schedulePersist();
  }

  sessions(): DreamSessionRecord[] {
    return Object.values(this.data.sessions).map((record) => ({ ...record }));
  }

  session(key: string): DreamSessionRecord | undefined {
    const record = this.data.sessions[key];
    return record ? { ...record } : undefined;
  }

  /** Record that the bridge ran a turn in this conversation. */
  noteSession(input: { agentId: AgentKind; handle: string; scopeId: string; cwd: string; at: number }): void {
    const key = sessionKey(input.agentId, input.handle);
    const existing = this.data.sessions[key];
    if (existing) {
      if (existing.lastSeenAt >= input.at && existing.cwd === input.cwd) return;
      this.data.sessions[key] = { ...existing, lastSeenAt: Math.max(existing.lastSeenAt, input.at), cwd: input.cwd };
    } else {
      this.data.sessions[key] = {
        key,
        agentId: input.agentId,
        handle: input.handle,
        scopeId: input.scopeId,
        cwd: input.cwd,
        firstSeenAt: input.at,
        lastSeenAt: input.at,
        consumed: 0,
      };
      this.prune();
    }
    this.schedulePersist();
  }

  /** Move a conversation's cursor: everything up to `consumed` is in a draft. */
  advance(key: string, consumed: number, hash: string | undefined, at: number): void {
    const record = this.data.sessions[key];
    if (!record) return;
    const { consumedHash: _previous, ...rest } = record;
    this.data.sessions[key] = { ...rest, consumed, ...(hash ? { consumedHash: hash } : {}), consumedAt: at };
    this.schedulePersist();
  }

  runs(): DreamRun[] {
    return this.data.runs.map(cloneRun);
  }

  run(id: string): DreamRun | undefined {
    const run = this.data.runs.find((item) => item.id === id);
    return run ? cloneRun(run) : undefined;
  }

  latestRun(): DreamRun | undefined {
    const run = this.data.runs.at(-1);
    return run ? cloneRun(run) : undefined;
  }

  addRun(run: DreamRun): void {
    this.data.runs.push(cloneRun(run));
    if (this.data.runs.length > MAX_RUNS) this.data.runs.splice(0, this.data.runs.length - MAX_RUNS);
    this.schedulePersist();
  }

  updateRun(id: string, patch: Partial<Omit<DreamRun, 'id'>>): DreamRun | undefined {
    const index = this.data.runs.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const next = { ...this.data.runs[index]!, ...patch, id };
    this.data.runs[index] = cloneRun(next);
    this.schedulePersist();
    return cloneRun(next);
  }

  /** Replace one target of a run (matched by `repo`), or append it. */
  saveTarget(id: string, target: DreamTarget): void {
    const run = this.data.runs.find((item) => item.id === id);
    if (!run) return;
    const index = run.targets.findIndex((item) => item.repo === target.repo);
    if (index < 0) run.targets.push({ ...target });
    else run.targets[index] = { ...target };
    this.schedulePersist();
  }

  isPublished(hash: string): boolean {
    return this.data.published.includes(hash);
  }

  markPublished(hashes: readonly string[]): void {
    const fresh = hashes.filter((hash) => !this.data.published.includes(hash));
    if (fresh.length === 0) return;
    this.data.published.push(...fresh);
    if (this.data.published.length > MAX_PUBLISHED) {
      this.data.published.splice(0, this.data.published.length - MAX_PUBLISHED);
    }
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  /** Over the cap, drop the conversations read longest ago. */
  private prune(): void {
    const keys = Object.keys(this.data.sessions);
    if (keys.length <= MAX_SESSIONS) return;
    const oldest = Object.values(this.data.sessions)
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt)
      .slice(0, keys.length - MAX_SESSIONS);
    for (const record of oldest) delete this.data.sessions[record.key];
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      })
      .catch((err: unknown) => {
        log.fail('dream', err, { step: 'persist' });
      });
  }
}

export function sessionKey(agentId: AgentKind, handle: string): string {
  return `${agentId}:${handle}`;
}

function cloneCheck(check: DreamAutoCheck): DreamAutoCheck {
  return {
    ...check,
    ...(check.material ? { material: { ...check.material } } : {}),
    ...(check.quota ? { quota: { ...check.quota } } : {}),
  };
}

function normalizeAuto(raw: unknown): DreamAutoLedger | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Partial<DreamAutoLedger>;
  const failures = typeof item.consecutiveFailures === 'number' && item.consecutiveFailures >= 0 ? Math.floor(item.consecutiveFailures) : 0;
  return {
    consecutiveFailures: failures,
    ...(typeof item.lastWindowKey === 'string' ? { lastWindowKey: item.lastWindowKey } : {}),
    ...(typeof item.lastCompletedAt === 'number' ? { lastCompletedAt: item.lastCompletedAt } : {}),
    ...(typeof item.lastFailedAt === 'number' ? { lastFailedAt: item.lastFailedAt } : {}),
    ...(item.lastCheck && typeof item.lastCheck === 'object' && typeof item.lastCheck.at === 'number'
      ? { lastCheck: cloneCheck(item.lastCheck) }
      : {}),
  };
}

function cloneRun(run: DreamRun): DreamRun {
  return {
    ...run,
    deferred: run.deferred.map((item) => ({ ...item })),
    targets: run.targets.map((target) => ({ ...target })),
    ...(run.external ? { external: run.external.map((item) => ({ ...item })) } : {}),
  };
}

function cloneExternal(cursors: Readonly<Record<string, ExternalCursor>>): Record<string, ExternalCursor> {
  return Object.fromEntries(
    Object.entries(cursors).map(([name, cursor]) => [name, { ...cursor, ...(cursor.pending ? { pending: [...cursor.pending] } : {}) }]),
  );
}

function normalizeExternal(raw: unknown): Record<string, ExternalCursor> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, ExternalCursor> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Partial<ExternalCursor>;
    if (typeof item.commit !== 'string' || !/^[0-9a-f]{7,64}$/.test(item.commit)) continue;
    const pending = Array.isArray(item.pending) ? item.pending.filter((path): path is string => typeof path === 'string') : [];
    out[name] = {
      commit: item.commit,
      learnedAt: typeof item.learnedAt === 'number' ? item.learnedAt : 0,
      ...(pending.length > 0 ? { pending } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeSession(key: string, raw: unknown): DreamSessionRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Partial<DreamSessionRecord>;
  if (!isAgentKind(item.agentId) || typeof item.handle !== 'string' || typeof item.scopeId !== 'string') return undefined;
  if (key !== sessionKey(item.agentId, item.handle)) return undefined;
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    key,
    agentId: item.agentId,
    handle: item.handle,
    scopeId: item.scopeId,
    cwd: typeof item.cwd === 'string' ? item.cwd : '',
    firstSeenAt: num(item.firstSeenAt, 0),
    lastSeenAt: num(item.lastSeenAt, 0),
    consumed: Math.floor(num(item.consumed, 0)),
    ...(typeof item.consumedHash === 'string' ? { consumedHash: item.consumedHash } : {}),
    ...(typeof item.consumedAt === 'number' ? { consumedAt: item.consumedAt } : {}),
  };
}

function isRun(raw: unknown): raw is DreamRun {
  if (!raw || typeof raw !== 'object') return false;
  const run = raw as Partial<DreamRun>;
  return (
    typeof run.id === 'string' &&
    typeof run.status === 'string' &&
    typeof run.startedAt === 'number' &&
    Array.isArray(run.targets) &&
    Array.isArray(run.deferred)
  );
}
