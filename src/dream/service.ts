import { randomBytes } from 'node:crypto';
import { mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { agentCapability } from '../agent/capability';
import { resolveEffortArg, resolveModelArg } from '../agent/models';
import { fullestQuotaWindow, readAgentQuota, type QuotaReading } from '../agent/quota';
import { agentDescriptor, isAgentKind } from '../agent/registry';
import { readAgentTranscript, type AgentTranscript } from '../agent/session-transcript';
import type { ProfileConfig, SkillLibraryConfig } from '../config/profile-schema';
import {
  getDream,
  getDreamAuto,
  resolveDreamSettings,
  type AppConfig,
  type DreamAutoSettings,
  type DreamSettings,
} from '../config/schema';
import { log } from '../core/logger';
import { maskUrlCredentials } from '../knowledge/libraries';
import type { KnowledgeStore, MemoryEntry, SkillSummary } from '../knowledge/store';
import { knowledgeRemoteUrl } from '../knowledge/sync';
import { evaluateRunPolicy, type RunPolicyAllow } from '../policy/run-policy';
import type { RunExecution, SubmitRunInput } from '../runtime/run-executor';
import type { SessionCatalog, SessionCatalogEntry } from '../session/catalog';
import { acquireDreamLocks, type HeldDreamLocks } from './lock';
import { buildDreamScopePrompt } from './prompt';
import {
  parseDreamOutput,
  validateDreamProposals,
  type DreamRejection,
  type MemoryAddition,
  type MemoryFlag,
  type SkillProposal,
} from './proposal';
import {
  checkoutDiff,
  checkPullRequestAccess,
  commitDraft,
  countOpenDreamPullRequests,
  dreamBranch,
  openDraftPullRequest,
  prepareCheckout,
  pullRequestDiff,
  pullRequestMergeInfo,
  pullRequestState,
  pushDraft,
  revertDraft,
  writeKnowledgeDraft,
  writeSkillDraft,
  type RepoSpec,
} from './publish';
import {
  commitMessage,
  flagLine,
  knowledgePrBody,
  knowledgePrTitle,
  sessionLegend,
  skillsPrBody,
  skillsPrTitle,
  type SessionLegend,
} from './report';
import {
  cheapDreamGate,
  dreamWindowAt,
  materialGate,
  type DreamAutoCheck,
  type DreamAutoLedger,
} from './schedule';
import { measureNewInput, selectDreamInputs, type DreamScopeInput } from './select';
import { DreamStateStore, sessionKey, type DreamRun, type DreamSessionRecord, type DreamTarget } from './state';

/**
 * 课堂精练: the bridge reads the conversations it ran since last time, has the
 * agent draft memory / note / skill proposals per scope in a read-only run,
 * validates them, and opens Draft PRs against the knowledge repo (its
 * `origin`) and the profile's own skill library (from `skills.libraries`).
 * Nothing it produces takes effect until a human merges.
 *
 * A run is started by an admin (`/dream run`, Web) or by 自动整理 — which is
 * not a daily clock but a set of gates ({@link DreamService.checkAuto}). Each
 * run goes draft → checkpoint → publish: every target repository gets its
 * local commit first; only when all of them have one do the cursors move, in
 * one write; pushing and opening PRs come after and are only ever resumed,
 * never redone. A user task stops an automatic run that has not reached its
 * checkpoint.
 *
 * One run per profile at a time, and one per target repository across
 * profiles (a host-wide lock). Off by default; turning the switch off stops
 * new runs, and a run re-checks it before its checkpoint.
 */

export interface DreamActor {
  id: string;
  name?: string;
}

/** The slice of {@link RunExecutor} a dream run needs. */
export interface DreamExecutor {
  submit(input: SubmitRunInput): Promise<RunExecution>;
  closeIdleScope?(scopeId: string): Promise<void>;
}

export interface DreamServiceDeps {
  profile: string;
  stateFile: string;
  /** Scratch space: checkouts per batch, the agent's empty cwd. */
  workDir: string;
  knowledge: KnowledgeStore;
  sessionCatalog?: SessionCatalog;
  executor: DreamExecutor;
  appConfig: () => AppConfig;
  profileConfig: () => ProfileConfig;
  /** An authenticated admin (owner or listed) — decides whose words can change shared rules. */
  isAdmin: (senderId: string) => boolean;
  /** A run is in flight for this chat scope right now. */
  isScopeBusy: (scopeId: string) => boolean;
  /**
   * Anything of the profile's own is running or waiting — a user turn, a
   * scheduled job, background work, queued messages. Dream runs don't count.
   * Absent: never busy.
   */
  isProfileBusy?: () => boolean;
  /** Host-wide directory of the per-repository locks every profile shares. Default: inside {@link workDir}. */
  lockDir?: string;
  /** The profile's state directory (where a profile-local CODEX_HOME lives). */
  profileDir?: string;
  readTranscript?: (record: DreamSessionRecord) => Promise<AgentTranscript | undefined>;
  readQuota?: () => Promise<QuotaReading | undefined>;
  /** Open `dream/*` PRs on a repository; undefined when it cannot be told. */
  countOpenPrs?: (url: string) => Promise<number | undefined>;
  /** How often 自动整理 looks; 0: never on its own (tests call {@link DreamService.checkAuto}). */
  autoCheckMs?: number;
  /** How often a running automatic batch checks that the profile is still idle. */
  watchdogMs?: number;
  now?: () => number;
}

export interface DreamStartOptions {
  trigger?: 'manual' | 'auto';
  /** Share of the run limits to use: 自动整理 without a quota reading runs on half. */
  budget?: number;
}

export type DreamStartResult =
  | { run: DreamRun }
  | { error: string; code?: 'off' | 'running' | 'no-remote' | 'locked' };

export interface DreamTargetsView {
  knowledge: { url?: string; problem?: string };
  skills: { library?: string; problem?: string };
}

export interface DreamStatusView {
  enabled: boolean;
  settings: DreamSettings;
  agent: string;
  targets: DreamTargetsView;
  running?: DreamRun;
  runs: DreamRun[];
  lastSucceededAt?: number;
  /** Draft PRs this profile opened in its recent runs. */
  openedPrs: number;
  /** Drafts kept locally (no push / PR yet), retried by the next run. */
  pendingDrafts: number;
  trackedSessions: number;
  auto: {
    enabled: boolean;
    settings: DreamAutoSettings;
    ledger: DreamAutoLedger;
  };
}

export interface DreamRevertResult {
  id: string;
  results: Array<{ label: string; prUrl?: string; note: string }>;
}

interface CurrentRun {
  id: string;
  trigger: 'manual' | 'auto';
  abort: AbortController;
  done: Promise<void>;
  execution?: RunExecution;
  /** Why it was stopped, in words: an admin, a user task, shutdown. */
  stopped?: string;
}

const KEEP_CHECKOUT_RUNS = 5;
const AUTO_CHECK_MS = 30 * 60_000;
const WATCHDOG_MS = 15_000;
const UNKNOWN_QUOTA_BUDGET = 0.5;
const AUTO_ACTOR: DreamActor = { id: 'dream-auto', name: '自动整理' };

export class DreamService {
  private readonly state: DreamStateStore;
  private readonly now: () => number;
  private current: CurrentRun | undefined;
  /** A start is between its first check and owning {@link current}. */
  private starting = false;
  private reverting = false;
  private checking: Promise<DreamAutoCheck> | undefined;
  private lastCheck: DreamAutoCheck | undefined;
  private autoTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: DreamServiceDeps) {
    this.state = new DreamStateStore(deps.stateFile);
    this.now = deps.now ?? Date.now;
  }

  async init(): Promise<void> {
    await this.state.load(this.now());
    this.unsubscribe = this.deps.sessionCatalog?.onUpsert((entry) => {
      if (this.enabled()) this.noteEntry(entry, entry.updatedAt);
    });
    if (this.enabled()) this.noteCatalog();
    const every = this.deps.autoCheckMs ?? AUTO_CHECK_MS;
    if (every > 0) {
      this.autoTimer = setInterval(() => {
        void this.checkAuto().catch((err: unknown) => log.fail('dream', err, { step: 'auto-check' }));
      }, every);
      this.autoTimer.unref?.();
    }
  }

  async dispose(): Promise<void> {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.stop('bridge 正在停止');
    await this.checking?.catch(() => undefined);
    await this.current?.done.catch(() => undefined);
    await this.state.flush();
  }

  enabled(): boolean {
    return getDream(this.deps.appConfig()) !== undefined;
  }

  autoEnabled(): boolean {
    return getDreamAuto(this.deps.appConfig()) !== undefined;
  }

  async status(): Promise<DreamStatusView> {
    const view = await composeDreamStatus({
      state: this.state,
      running: this.current ? this.state.run(this.current.id) : undefined,
      appConfig: this.deps.appConfig(),
      profileConfig: this.deps.profileConfig(),
      knowledge: this.deps.knowledge,
    });
    // The stored check only changes when its outcome does; this one is fresh.
    if (this.lastCheck) view.auto.ledger.lastCheck = { ...this.lastCheck };
    return view;
  }

  runs(): DreamRun[] {
    return this.state.runs().reverse();
  }

  /**
   * Start a run in the background. `onFinish` hears the outcome once — the
   * only message a run ever sends, and only because someone asked for it;
   * automatic runs pass none.
   */
  async start(actor: DreamActor, onFinish?: (run: DreamRun) => void, options: DreamStartOptions = {}): Promise<DreamStartResult> {
    if (!this.enabled()) return { error: '课堂精练没有打开（/config 里打开「课堂精练」）。', code: 'off' };
    const trigger = options.trigger ?? 'manual';
    if (trigger === 'auto' && !this.autoEnabled()) return { error: '自动整理没有打开。', code: 'off' };
    const already = this.busy();
    if (already) return already;
    this.starting = true;
    let locks: HeldDreamLocks | undefined;
    try {
      // Without a remote there is nowhere to put a draft, and reading the input
      // anyway would only consume it.
      const url = await knowledgeRemoteUrl(this.deps.knowledge).catch(() => undefined);
      if (!url) {
        return { error: '知识库还没有绑定远端仓库，草稿无处提交。先用 `/knowledge bind <git 仓库地址>` 绑定。', code: 'no-remote' };
      }
      const id = batchId(this.now());
      const held = await acquireDreamLocks(this.lockDir(), this.repoTargets(url).map((item) => item.url), {
        profile: this.deps.profile,
        batch: id,
      });
      if ('error' in held) return { error: held.error, code: 'locked' };
      locks = held;
      const run: DreamRun = {
        id,
        status: 'queued',
        trigger,
        actorId: actor.id,
        startedAt: this.now(),
        sessions: 0,
        scopes: 0,
        exchanges: 0,
        memoryItems: 0,
        skillItems: 0,
        rejected: 0,
        deferred: [],
        targets: [],
      };
      this.state.addRun(run);
      const current: CurrentRun = { id, trigger, abort: new AbortController(), done: Promise.resolve() };
      this.current = current;
      const release = locks.release;
      locks = undefined;
      const unwatch = this.watch(current);
      current.done = this.execute(run, actor, current, options.budget ?? 1)
        .catch((err: unknown) => {
          log.fail('dream', err, { step: 'run', batch: id });
          if (this.state.run(id)?.checkpointAt === undefined) this.discardDrafts(id, '整理出错，草稿作废');
          this.finish(id, 'failed', `整理出错：${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(async () => {
          unwatch();
          await release().catch(() => undefined);
          if (this.current === current) this.current = undefined;
          const final = this.state.run(id);
          if (!final) return;
          this.recordOutcome(final);
          if (!onFinish) return;
          try {
            onFinish(final);
          } catch (err) {
            log.fail('dream', err, { step: 'on-finish' });
          }
        });
      return { run: this.state.run(id)! };
    } finally {
      this.starting = false;
      if (locks) await locks.release().catch(() => undefined);
    }
  }

  /** Stop the running batch: no new agent turn, no further publishing step. */
  cancel(): boolean {
    return this.stop('已取消');
  }

  /**
   * A user task takes precedence: stop an automatic batch that has not
   * reached its checkpoint (nothing is consumed, the input is read again
   * later). Manual runs, and a batch already publishing, are left alone.
   */
  preempt(reason: string): boolean {
    const current = this.current;
    if (!current || current.trigger !== 'auto' || current.abort.signal.aborted) return false;
    if (this.state.run(current.id)?.checkpointAt !== undefined) return false;
    log.info('dream', 'preempted', { batch: current.id, reason });
    return this.stop(`让位给用户任务（${reason}）`);
  }

  /** Wait for the running batch, if any (tests, shutdown). */
  async idle(): Promise<void> {
    await this.current?.done.catch(() => undefined);
  }

  /** PRs of recent runs, newest first, each with its live state from `gh` when it answers. */
  async pullRequests(limit = 10): Promise<Array<{ run: DreamRun; target: DreamTarget; state?: string }>> {
    const entries = this.runs()
      .flatMap((run) => run.targets.filter((target) => target.prUrl).map((target) => ({ run, target })))
      .slice(0, limit);
    return Promise.all(
      entries.map(async (entry) => {
        const state = await pullRequestState(this.deps.workDir, entry.target.prUrl!);
        return state ? { ...entry, state } : entry;
      }),
    );
  }

  /** Diff of one batch (default: the latest that produced something). */
  async diff(id?: string): Promise<{ id: string; parts: Array<{ label: string; diff: string }> } | { error: string }> {
    const run = id
      ? this.state.run(id)
      : this.runs().find((item) => item.targets.some((target) => target.commit || target.prUrl));
    if (!run) return { error: id ? `没有批次 \`${id}\`。` : '还没有生成过草稿。' };
    const parts: Array<{ label: string; diff: string }> = [];
    for (const target of run.targets) {
      if (target.checkoutDir && target.commit) {
        const local = await checkoutDiff(target.checkoutDir);
        if (local) {
          parts.push({ label: target.label, diff: local });
          continue;
        }
      }
      if (target.prUrl) {
        const remote = await pullRequestDiff(this.deps.workDir, target.prUrl);
        parts.push({ label: target.label, diff: typeof remote === 'string' ? remote : `（读不到差异：${remote.error}）` });
      }
    }
    if (parts.length === 0) return { error: `批次 \`${run.id}\` 没有可看的差异。` };
    return { id: run.id, parts };
  }

  /**
   * Undo a batch that was merged: per target repository, a Draft PR that
   * reverts its merge — reviewed and merged like any other. A PR still open
   * or closed unmerged never took effect and is only reported.
   */
  async revert(id: string): Promise<DreamRevertResult | { error: string }> {
    const run = this.state.run(id);
    if (!run) return { error: `没有批次 \`${id}\`。` };
    const targets = run.targets.filter((target) => target.prUrl);
    if (targets.length === 0) return { error: `批次 \`${id}\` 没有开出过 PR，没有可撤销的内容。` };
    if (this.reverting) return { error: '已经有一个撤销在进行，稍后再试。' };
    this.reverting = true;
    let locks: HeldDreamLocks | undefined;
    try {
      const knowledgeUrl = await knowledgeRemoteUrl(this.deps.knowledge).catch(() => undefined);
      const repos = this.repoTargets(knowledgeUrl);
      const held = await acquireDreamLocks(this.lockDir(), repos.map((item) => item.url), {
        profile: this.deps.profile,
        batch: `${id} 撤销`,
      });
      if ('error' in held) return { error: held.error };
      locks = held;
      const results: DreamRevertResult['results'] = [];
      for (const target of targets) {
        results.push({ label: target.label, ...(await this.revertTarget(run.id, target, repos)) });
      }
      return { id: run.id, results };
    } finally {
      this.reverting = false;
      await locks?.release().catch(() => undefined);
    }
  }

  /**
   * One look by 自动整理: start a run when every gate passes, otherwise say
   * which one held it back. The outcome is kept for status views.
   */
  async checkAuto(): Promise<DreamAutoCheck> {
    this.checking ??= this.runAutoCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  // ---------------------------------------------------------------------------

  private async runAutoCheck(): Promise<DreamAutoCheck> {
    const now = this.now();
    const settings = getDreamAuto(this.deps.appConfig());
    if (!settings) {
      return this.noteCheck({ at: now, block: 'off', reason: this.enabled() ? '自动整理没有打开' : '课堂精练没有打开' });
    }
    const auto = settings.auto;
    if (this.current || this.starting) return this.noteCheck({ at: now, block: 'running', reason: '已经有一轮整理在进行' });
    const cheap = cheapDreamGate({ now, auto, ledger: this.state.autoLedger() });
    if (cheap) return this.noteCheck({ at: now, ...cheap });
    if (this.deps.isProfileBusy?.()) {
      return this.noteCheck({ at: now, block: 'busy', reason: '有任务在跑或有消息在排队，用户任务优先' });
    }
    const lastActive = this.state.sessions().reduce((latest, record) => Math.max(latest, record.lastSeenAt), 0);
    if (now - lastActive < settings.minIdleMinutes * 60_000) {
      return this.noteCheck({ at: now, block: 'recent-activity', reason: `最近 ${settings.minIdleMinutes} 分钟内有对话，等空闲后再看` });
    }
    const url = await knowledgeRemoteUrl(this.deps.knowledge).catch(() => undefined);
    if (!url) return this.noteCheck({ at: now, block: 'no-remote', reason: '知识库没有绑定远端（/knowledge bind）' });
    if (!this.readOnlyPolicy('自动整理预检', AUTO_ACTOR, this.deps.workDir)) {
      return this.noteCheck({ at: now, block: 'restricted', reason: '当前 agent 配置无法保证只读执行，不开放自动整理' });
    }
    this.noteCatalog();
    const measured = await measureNewInput({ records: this.state.sessions(), settings, read: this.reader() });
    const material = { scopes: measured.scopes, sessions: measured.sessions, chars: measured.chars };
    const gate = materialGate({ now, auto, material, since: this.state.autoLedger().lastCompletedAt ?? measured.oldestAt });
    if (!gate.ok) return this.noteCheck({ at: now, block: 'material', reason: gate.reason, material });
    const openPrs = await this.openDreamPrs(url);
    if (openPrs >= auto.maxOpenPrs) {
      return this.noteCheck({
        at: now,
        block: 'backlog',
        reason: `待审积压：还有 ${openPrs} 个课堂精练 Draft PR 没合并或关闭（上限 ${auto.maxOpenPrs}），暂停自动整理`,
        material: gate.material,
        openPrs,
      });
    }
    const quota = await this.readQuota();
    const context = { material: gate.material, openPrs, quota };
    if ('percent' in quota && quota.percent >= auto.maxQuotaPercent) {
      return this.noteCheck({
        at: now,
        block: 'quota',
        reason: `额度已用 ${quota.percent}%（${quota.label}），到了 ${auto.maxQuotaPercent}% 的上限`,
        ...context,
      });
    }
    // The checks above took a while: a user may have shown up meanwhile.
    if (this.deps.isProfileBusy?.()) {
      return this.noteCheck({ at: now, block: 'busy', reason: '有任务在跑或有消息在排队，用户任务优先', ...context });
    }
    const started = await this.start(AUTO_ACTOR, undefined, {
      trigger: 'auto',
      budget: 'unknown' in quota ? UNKNOWN_QUOTA_BUDGET : 1,
    });
    if ('error' in started) {
      return this.noteCheck({ at: now, block: started.code === 'locked' ? 'locked' : 'running', reason: started.error, ...context });
    }
    this.state.updateAuto({ lastWindowKey: dreamWindowAt(now, auto.window, auto.timezone).key });
    return this.noteCheck({ at: now, started: started.run.id, ...context });
  }

  /** Keep the latest check; the stored one is rewritten only when the outcome changes. */
  private noteCheck(check: DreamAutoCheck): DreamAutoCheck {
    this.lastCheck = check;
    // A switched-off or busy-running profile gets no state file writes for it.
    if (check.block === 'off' || check.block === 'running') return check;
    const stored = this.state.autoLedger().lastCheck;
    if (check.started || !stored || stored.block !== check.block || stored.reason !== check.reason) {
      this.state.updateAuto({ lastCheck: check });
    }
    return check;
  }

  private async openDreamPrs(knowledgeUrl: string): Promise<number> {
    const count = this.deps.countOpenPrs ?? ((url: string) => countOpenDreamPullRequests(this.deps.workDir, url));
    const runs = this.state.runs();
    let worst = 0;
    for (const repo of this.repoTargets(knowledgeUrl)) {
      const live = await count(repo.url).catch(() => undefined);
      // Drafts of ours still waiting to be pushed / opened are part of the
      // backlog too — and all there is to go on when `gh` cannot answer.
      const waiting = runs
        .flatMap((run) => run.targets)
        .filter((target) => target.repo === repo.repo && (target.phase === 'committed' || target.phase === 'pushed')).length;
      worst = Math.max(worst, (live ?? 0) + waiting);
    }
    return worst;
  }

  private async readQuota(): Promise<{ percent: number; label: string } | { unknown: true }> {
    const read =
      this.deps.readQuota ??
      (async () => {
        const cwd = join(this.deps.workDir, 'scratch');
        await mkdir(cwd, { recursive: true, mode: 0o700 });
        return readAgentQuota(this.deps.profileConfig(), {
          cwd,
          ...(this.deps.profileDir ? { profileDir: this.deps.profileDir } : {}),
        });
      });
    const reading = await read().catch(() => undefined);
    const fullest = reading ? fullestQuotaWindow(reading) : undefined;
    return fullest ? { percent: Math.round(fullest.usedPercent), label: fullest.label } : { unknown: true };
  }

  /** While an automatic batch drafts, anything else the profile starts stops it. */
  private watch(current: CurrentRun): () => void {
    const isBusy = this.deps.isProfileBusy;
    if (current.trigger !== 'auto' || !isBusy) return () => undefined;
    const timer = setInterval(() => {
      if (isBusy()) this.preempt('profile 有新任务');
    }, this.deps.watchdogMs ?? WATCHDOG_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private stop(reason: string): boolean {
    const current = this.current;
    if (!current) return false;
    current.stopped ??= reason;
    current.abort.abort();
    void current.execution?.stop().catch(() => undefined);
    return true;
  }

  private busy(): { error: string; code: 'running' } | undefined {
    if (this.current) return { error: `已经有一轮整理在进行（批次 \`${this.current.id}\`）。`, code: 'running' };
    if (this.starting) return { error: '已经有一轮整理正在启动。', code: 'running' };
    return undefined;
  }

  /** Still allowed to take effect: the switch — and for an automatic run, 自动整理 — is on. */
  private switchedOff(run: DreamRun): string | undefined {
    if (!this.enabled()) return '课堂精练已关闭';
    if (run.trigger === 'auto' && !this.autoEnabled()) return '自动整理已关闭';
    return undefined;
  }

  private recordOutcome(run: DreamRun): void {
    const patch: Partial<DreamAutoLedger> = {};
    // Input read and drafted: the clock of 间隔够 restarts, whatever happened to the PRs.
    if (run.checkpointAt !== undefined) patch.lastCompletedAt = run.endedAt ?? this.now();
    if (run.status === 'succeeded') {
      patch.consecutiveFailures = 0;
      patch.lastFailedAt = undefined;
    } else if (run.trigger === 'auto' && (run.status === 'failed' || (run.status === 'deferred' && run.scopes > 0))) {
      patch.consecutiveFailures = this.state.autoLedger().consecutiveFailures + 1;
      patch.lastFailedAt = run.endedAt ?? this.now();
    }
    if (Object.keys(patch).length > 0) this.state.updateAuto(patch);
  }

  private async execute(run: DreamRun, actor: DreamActor, current: CurrentRun, budget: number): Promise<void> {
    const signal = current.abort.signal;
    const stopped = (rest: string) => this.finish(run.id, 'cancelled', `${current.stopped ?? '已取消'}，${rest}`);
    const configured = getDream(this.deps.appConfig());
    if (!configured) return this.finish(run.id, 'cancelled', '课堂精练已关闭');
    const settings = scaleBudget(configured, budget);
    this.state.updateRun(run.id, { status: 'running' });
    await mkdir(this.deps.workDir, { recursive: true, mode: 0o700 });

    // Drafts of earlier runs that were committed but not yet pushed / opened
    // come first: they are retried from the phase they stopped at.
    const resumed = await this.resumePendingTargets(signal);
    if (signal.aborted) return stopped('游标未移动');

    this.noteCatalog();
    const selection = await selectDreamInputs({
      records: this.state.sessions(),
      settings,
      now: this.now(),
      isBusy: this.deps.isScopeBusy,
      read: this.reader(),
    });
    for (const record of selection.idle) this.state.advance(record.key, record.consumed, record.consumedHash, this.now());
    const deferred = [...selection.deferred];
    const sessionsTotal = selection.scopes.reduce((sum, scope) => sum + scope.sessions.length, 0);
    this.state.updateRun(run.id, {
      sessions: sessionsTotal,
      scopes: selection.scopes.length,
      exchanges: selection.scopes.reduce(
        (sum, scope) => sum + scope.sessions.reduce((inner, session) => inner + session.exchanges.length, 0),
        0,
      ),
      deferred,
    });
    if (selection.scopes.length === 0) {
      const note = [resumed, deferred.length > 0 ? `${deferred.length} 个会话延后` : '没有新的已结束会话可整理']
        .filter(Boolean)
        .join('；');
      return this.finish(run.id, deferred.length > 0 && !resumed ? 'deferred' : 'succeeded', note);
    }

    const [profileMemory, skills] = await Promise.all([
      this.deps.knowledge.listMemories({ kind: 'profile' }),
      this.deps.knowledge.listSkills(),
    ]);
    const deadline = this.now() + settings.maxRunMinutes * 60_000;
    const additions: MemoryAddition[] = [];
    const flags: MemoryFlag[] = [];
    const skillProposals: SkillProposal[] = [];
    const rejected: DreamRejection[] = [];
    const done: DreamScopeInput[] = [];

    for (const scope of selection.scopes) {
      if (signal.aborted) return stopped('游标未移动');
      const off = this.switchedOff(run);
      if (off) return this.finish(run.id, 'cancelled', `${off}，游标未移动`);
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        for (const session of scope.sessions) deferred.push({ key: session.record.key, reason: '超出本轮运行时间' });
        continue;
      }
      const chatMemory = await this.deps.knowledge.listMemories({ kind: 'chat', scopeId: scope.scopeId });
      const outcome = await this.proposeForScope(run.id, done.length, scope, {
        actor,
        profileMemory,
        chatMemory,
        skills,
        remainingMs: remaining,
        signal,
      });
      if (signal.aborted) return stopped('游标未移动');
      if ('error' in outcome) {
        for (const session of scope.sessions) deferred.push({ key: session.record.key, reason: outcome.error });
        continue;
      }
      additions.push(...outcome.additions);
      flags.push(...outcome.flags);
      skillProposals.push(...outcome.skills);
      rejected.push(...outcome.rejected);
      done.push(scope);
    }
    this.state.updateRun(run.id, {
      deferred,
      memoryItems: additions.length + flags.length,
      skillItems: skillProposals.length,
      rejected: rejected.length,
    });
    if (done.length === 0) {
      return this.finish(run.id, 'deferred', `${deferred.length} 个会话延后：${deferred[0]?.reason ?? ''}`);
    }

    // Draft: a local commit in every target repository, or the batch is dropped.
    const switchedOff = this.switchedOff(run);
    if (switchedOff) return this.finish(run.id, 'cancelled', `${switchedOff}，游标未移动`);
    const legend = done.flatMap((scope) => scope.sessions.map(sessionLegend));
    const drafted = await this.draftTargets(run.id, { additions, flags, rejected, skills: skillProposals, legend }, signal);
    if (signal.aborted) {
      this.discardDrafts(run.id, '已取消，草稿作废');
      return stopped('草稿作废，游标未移动');
    }
    if (drafted.blocked) {
      this.discardDrafts(run.id, '同批有仓库没能生成草稿，整批作废');
      return this.finish(run.id, 'failed', '有仓库没能生成草稿，整批作废、游标未移动，下次整理会重试');
    }
    const lateOff = this.switchedOff(run);
    if (lateOff) {
      this.discardDrafts(run.id, `${lateOff}，草稿作废`);
      return this.finish(run.id, 'cancelled', `${lateOff}，草稿未发布，游标未移动`);
    }

    // Checkpoint: the drafts exist, so these exchanges are consumed — in one
    // write with the run, so a restart can tell a finished draft phase from
    // an interrupted one.
    this.state.checkpoint(
      run.id,
      this.now(),
      done.flatMap((scope) =>
        scope.sessions.map((session) => ({ key: session.record.key, consumed: session.nextConsumed, hash: session.nextHash })),
      ),
      drafted.published,
    );

    // Publish: push and open PRs. A failure here keeps the draft for the next run.
    for (const target of this.state.run(run.id)?.targets ?? []) {
      if (target.phase !== 'committed') continue;
      if (signal.aborted) break;
      await this.pushAndOpen(run.id, target);
    }
    if (signal.aborted) {
      return this.finish(run.id, 'cancelled', `${current.stopped ?? '已取消'}；草稿已保存，下一轮补推、补开 PR`);
    }
    await this.pruneCheckouts();
    const targets = this.state.run(run.id)?.targets ?? [];
    const problems = targets.filter((target) => target.error);
    const summary = [
      budget < 1 ? '读不到额度，按一半预算运行' : undefined,
      resumed,
      `${done.length} 个范围、${legend.length} 个会话`,
      `记忆 / 笔记 ${additions.length + flags.length} 条，skill ${skillProposals.length} 个，未采纳 ${rejected.length} 条`,
      targets.length === 0 ? '没有值得提交的内容' : undefined,
      deferred.length > 0 ? `${deferred.length} 个会话延后` : undefined,
      problems.length > 0 ? problems.map((target) => `${target.label}：${target.error}`).join('；') : undefined,
    ]
      .filter(Boolean)
      .join('；');
    return this.finish(run.id, 'succeeded', summary);
  }

  private async proposeForScope(
    batch: string,
    ordinal: number,
    scope: DreamScopeInput,
    ctx: {
      actor: DreamActor;
      profileMemory: MemoryEntry[];
      chatMemory: MemoryEntry[];
      skills: SkillSummary[];
      remainingMs: number;
      signal: AbortSignal;
    },
  ): Promise<ReturnType<typeof validateDreamProposals> | { error: string }> {
    const built = buildDreamScopePrompt({
      scope,
      profileMemory: ctx.profileMemory,
      chatMemory: ctx.chatMemory,
      skills: ctx.skills,
      isAdmin: this.deps.isAdmin,
    });
    const answer = await this.runAgent(`dream:${batch}:${ordinal + 1}`, built.prompt, ctx.actor, ctx.remainingMs, ctx.signal);
    if ('error' in answer) return answer;
    const parsed = parseDreamOutput(answer.text);
    if ('error' in parsed) return { error: `模型输出不合格：${parsed.error}` };
    return validateDreamProposals(parsed, {
      scopeId: scope.scopeId,
      refs: built.refs,
      profileMemory: ctx.profileMemory,
      chatMemory: ctx.chatMemory,
      skills: ctx.skills,
      isPublished: (hash) => this.state.isPublished(hash),
    });
  }

  /**
   * The policy of a dream turn: read-only whatever the chat agent is allowed.
   * Undefined when the adapter cannot guarantee that — then nothing runs.
   */
  private readOnlyPolicy(prompt: string, actor: DreamActor, cwdRealpath: string): RunPolicyAllow | undefined {
    const profileConfig = this.deps.profileConfig();
    const readOnly: ProfileConfig = {
      ...profileConfig,
      permissions: { defaultAccess: 'read-only', maxAccess: 'read-only' },
    };
    const policy = evaluateRunPolicy({
      scope: { source: 'dream', actorId: actor.id },
      attachments: [],
      prompt,
      requestedCwd: cwdRealpath,
      cwdRealpath,
      access: { ok: true, reason: 'allowed-admin' },
      capability: agentCapability(readOnly),
      profileConfig: readOnly,
      now: this.now(),
      codexHome: profileConfig.codex?.codexHome,
      inheritCodexHome: profileConfig.codex?.inheritCodexHome,
    });
    if (!policy.ok || policy.accessMode !== 'read-only' || policy.sandbox !== 'read-only' || policy.permissionMode !== 'plan') {
      return undefined;
    }
    return policy;
  }

  /**
   * One read-only agent turn in a fresh conversation of its own, in an empty
   * scratch directory.
   */
  private async runAgent(
    scopeId: string,
    prompt: string,
    actor: DreamActor,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ text: string } | { error: string }> {
    const profileConfig = this.deps.profileConfig();
    const scratch = join(this.deps.workDir, 'scratch');
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const policy = this.readOnlyPolicy(prompt, actor, await realpath(scratch));
    if (!policy) return { error: '无法保证只读执行，已跳过' };
    let execution: RunExecution;
    try {
      execution = await this.deps.executor.submit({
        scopeId,
        policy,
        model: resolveModelArg(profileConfig.agentKind, profileConfig.preferences.model),
        effort: resolveEffortArg(profileConfig.agentKind, profileConfig.preferences.effort),
        nowait: true,
        actor,
        observability: {
          profile: this.deps.profile,
          agent: agentCapability(profileConfig).agentId,
          source: 'dream',
          stage: 'submit',
        },
      });
    } catch (err) {
      return { error: `整理 agent 没能启动（${err instanceof Error ? err.message : String(err)}）` };
    }
    if (this.current) this.current.execution = execution;
    // Stopped in the meantime (a user task, a cancel): the stop above found no execution yet.
    if (signal.aborted) void execution.stop().catch(() => undefined);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void execution.stop().catch(() => undefined);
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => void execution.stop().catch(() => undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    let finalText: string | undefined;
    let streamed = '';
    let failure: string | undefined;
    try {
      for await (const event of execution.subscribe()) {
        if (event.type === 'final_text') finalText = event.content;
        else if (event.type === 'text') streamed += event.delta;
        else if (event.type === 'error') failure = event.message;
        else if (event.type === 'done' && event.terminationReason !== 'normal') failure = event.terminationReason;
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (this.current) this.current.execution = undefined;
      await this.deps.executor.closeIdleScope?.(scopeId).catch(() => undefined);
    }
    if (timedOut) return { error: '超出本轮运行时间' };
    if (signal.aborted) return { error: '已取消' };
    const text = finalText ?? streamed;
    if (failure && !text.trim()) return { error: `整理 agent 运行失败：${failure.slice(0, 200)}` };
    return { text };
  }

  /** The draft phase: a local commit per target repository. Pushing waits for the checkpoint. */
  private async draftTargets(
    id: string,
    input: {
      additions: MemoryAddition[];
      flags: MemoryFlag[];
      rejected: DreamRejection[];
      skills: SkillProposal[];
      legend: SessionLegend[];
    },
    signal: AbortSignal,
  ): Promise<{ blocked: boolean; published: string[] }> {
    let blocked = false;
    const published: string[] = [];
    if (input.additions.length > 0 || input.flags.length > 0) {
      const target = await this.draftKnowledge(id, input, signal);
      if (target.phase === 'failed') blocked = true;
      if (target.commit) published.push(...input.additions.map((item) => item.hash), ...input.flags.map((item) => item.hash));
    }
    if (input.skills.length > 0 && !signal.aborted && !blocked) {
      const outcome = await this.draftSkills(id, input.skills, input.rejected, input.legend, signal);
      if (outcome.blocked) blocked = true;
      published.push(...outcome.published);
    }
    return { blocked, published };
  }

  private async draftKnowledge(
    id: string,
    input: { additions: MemoryAddition[]; flags: MemoryFlag[]; rejected: DreamRejection[]; legend: SessionLegend[] },
    signal: AbortSignal,
  ): Promise<DreamTarget> {
    const target: DreamTarget = { repo: 'knowledge', label: '知识库', branch: dreamBranch(id), phase: 'failed', items: 0 };
    const url = await knowledgeRemoteUrl(this.deps.knowledge);
    if (!url) return this.saveTarget(id, { ...target, error: '知识库没有绑定远端（/knowledge bind），草稿未生成' });
    const dir = join(this.deps.workDir, 'batches', id, 'knowledge');
    const prepared = await prepareCheckout({ repo: 'knowledge', label: '知识库', url }, dir, target.branch);
    if ('error' in prepared) return this.saveTarget(id, { ...target, error: prepared.error });
    if (signal.aborted) return this.saveTarget(id, { ...target, error: '已取消' });
    // Merge / conflict / stale flags go into a per-scope review note, so they
    // show up in the diff and survive the merge as a record; the original
    // entries are never touched.
    const reviewEntries: MemoryAddition[] = input.flags.map((flag) => ({
      kind: 'add',
      scopeId: flag.scopeId,
      target: 'note',
      note: 'dream-review',
      text: `${flagLine(flag)}（理由：${flag.reason}；来源：${flag.sources.map((ref) => ref.ref).join('、')}；批次 ${id}）`,
      reason: flag.reason,
      sources: flag.sources,
      hash: flag.hash,
    }));
    const draft = await writeKnowledgeDraft(dir, [...input.additions, ...reviewEntries]);
    const written = draft.written.filter((item) => !reviewEntries.includes(item));
    const writtenFlags = input.flags.filter((flag) => draft.written.some((item) => item.hash === flag.hash && reviewEntries.includes(item)));
    if (draft.files.length === 0) {
      return this.saveTarget(id, {
        ...target,
        base: prepared.base,
        phase: 'skipped',
        error: draft.errors[0] ?? '提案都已在最新基线里，没有改动',
        checkoutDir: dir,
      });
    }
    const title = knowledgePrTitle(id, written.length + writtenFlags.length);
    const body = knowledgePrBody({
      batchId: id,
      profile: this.deps.profile,
      written,
      flags: writtenFlags,
      duplicates: draft.duplicates.length,
      rejected: input.rejected.filter((item) => item.kind !== 'skill'),
      legend: input.legend,
    });
    return this.commitTarget(
      id,
      { ...target, base: prepared.base, items: written.length + writtenFlags.length, checkoutDir: dir, title, body },
      draft.files,
      `记忆 / 笔记 ${written.length} 条，待确认标记 ${writtenFlags.length} 条`,
    );
  }

  private async draftSkills(
    id: string,
    proposals: SkillProposal[],
    rejected: DreamRejection[],
    legend: SessionLegend[],
    signal: AbortSignal,
  ): Promise<{ blocked: boolean; published: string[] }> {
    const profileConfig = this.deps.profileConfig();
    const libraries = profileConfig.skills?.libraries ?? [];
    const settings = resolveDreamSettings(this.deps.appConfig().preferences?.dreamTuning);
    const fallback = defaultSkillLibrary(libraries, settings.skillLibrary);
    const groups = new Map<string, { library?: SkillLibraryConfig; problem?: string; items: SkillProposal[] }>();
    for (const proposal of proposals) {
      const library =
        proposal.action === 'update'
          ? libraries.find((item) => item.name === proposal.source)
          : 'library' in fallback
            ? fallback.library
            : undefined;
      const key = library?.name ?? '';
      const group = groups.get(key) ?? {
        ...(library ? { library } : {}),
        ...(!library ? { problem: 'problem' in fallback ? fallback.problem : '找不到 skill 所在的库' } : {}),
        items: [],
      };
      group.items.push(proposal);
      groups.set(key, group);
    }
    const published: string[] = [];
    for (const [name, group] of groups) {
      if (signal.aborted) return { blocked: true, published };
      const repo = `skills:${name || '-'}`;
      const label = name ? `skill 库 ${name}` : 'skill 库';
      const target: DreamTarget = { repo, label, branch: dreamBranch(id), phase: 'failed', items: 0 };
      if (!group.library) {
        this.saveTarget(id, { ...target, phase: 'skipped', error: `${group.problem}，${group.items.length} 个 skill 提案未提交` });
        continue;
      }
      const dir = join(this.deps.workDir, 'batches', id, `skills-${group.library.name}`);
      const spec: RepoSpec = { repo, label, url: group.library.url, ...(group.library.ref ? { ref: group.library.ref } : {}) };
      const prepared = await prepareCheckout(spec, dir, target.branch);
      if ('error' in prepared) {
        // Pinned to a tag / commit is a configuration fact, not a hiccup: skip
        // rather than retry forever.
        const permanent = /不能作为写入目标|不合法/.test(prepared.error);
        this.saveTarget(id, { ...target, phase: permanent ? 'skipped' : 'failed', error: prepared.error });
        if (!permanent) return { blocked: true, published };
        continue;
      }
      const draft = await writeSkillDraft(dir, group.library, group.items);
      const skillRejected = [
        ...rejected.filter((item) => item.kind === 'skill'),
        ...draft.rejected.map((item) => ({ scopeId: item.proposal.scopeId, kind: 'skill' as const, reason: item.reason })),
      ];
      if (draft.files.length === 0) {
        this.saveTarget(id, {
          ...target,
          base: prepared.base,
          phase: 'skipped',
          error: draft.rejected[0]?.reason ?? '没有改动',
          checkoutDir: dir,
        });
        continue;
      }
      const result = await this.commitTarget(
        id,
        {
          ...target,
          base: prepared.base,
          items: draft.written.length,
          checkoutDir: dir,
          title: skillsPrTitle(id, draft.written.length),
          body: skillsPrBody({
            batchId: id,
            profile: this.deps.profile,
            library: group.library.name,
            written: draft.written,
            rejected: skillRejected,
            legend,
          }),
        },
        draft.files,
        `skill 提案 ${draft.written.length} 个`,
      );
      if (result.phase === 'failed') return { blocked: true, published };
      published.push(...draft.written.map((item) => item.hash));
    }
    return { blocked: false, published };
  }

  private async commitTarget(id: string, target: DreamTarget, files: string[], summary: string): Promise<DreamTarget> {
    const committed = await commitDraft(target.checkoutDir!, files, commitMessage(id, summary), this.hooksDir());
    if ('error' in committed) return this.saveTarget(id, { ...target, phase: 'failed', error: committed.error });
    return this.saveTarget(id, { ...target, commit: committed.commit, phase: 'committed' });
  }

  /** Before the checkpoint a draft is worth nothing: the input is read again and would be proposed twice. */
  private discardDrafts(id: string, reason: string): void {
    for (const target of this.state.run(id)?.targets ?? []) {
      if (target.phase !== 'committed') continue;
      const { commit: _dropped, ...rest } = target;
      this.saveTarget(id, { ...rest, phase: 'failed', error: reason });
    }
  }

  private async pushAndOpen(id: string, target: DreamTarget): Promise<DreamTarget> {
    const dir = target.checkoutDir!;
    let current = target;
    if (current.phase === 'committed') {
      const access = await checkPullRequestAccess(dir);
      if ('error' in access) {
        // No write access is permanent for this repo (third-party / read-only
        // library); a missing or logged-out gh is not — keep the commit for a retry.
        const permanent = /权限是/.test(access.error);
        return this.saveTarget(id, { ...current, ...(permanent ? { phase: 'skipped' as const } : {}), error: access.error });
      }
      const pushed = await pushDraft(dir, current.branch, this.hooksDir());
      if ('error' in pushed) return this.saveTarget(id, { ...current, error: pushed.error });
      current = this.saveTarget(id, { ...current, phase: 'pushed', error: undefined });
    }
    if (current.phase === 'pushed') {
      const pr = await openDraftPullRequest(dir, {
        branch: current.branch,
        base: current.base ?? 'main',
        title: current.title ?? `课堂精练 ${id}`,
        body: current.body ?? '',
      });
      if ('error' in pr) return this.saveTarget(id, { ...current, error: pr.error });
      current = this.saveTarget(id, {
        ...current,
        phase: 'pr-created',
        prUrl: pr.url,
        ...(pr.number ? { prNumber: pr.number } : {}),
        error: undefined,
      });
    }
    return current;
  }

  /** Retry every earlier draft stuck at `committed` / `pushed`. Returns a summary or ''. */
  private async resumePendingTargets(signal: AbortSignal): Promise<string> {
    let opened = 0;
    let still = 0;
    for (const run of this.state.runs()) {
      for (const target of run.targets) {
        if (target.phase !== 'committed' && target.phase !== 'pushed') continue;
        if (signal.aborted) return '';
        if (!target.checkoutDir) continue;
        const result = await this.pushAndOpen(run.id, target);
        if (result.phase === 'pr-created') opened++;
        else still++;
      }
    }
    if (opened === 0 && still === 0) return '';
    return `补开了 ${opened} 个之前没开成的 PR${still > 0 ? `，还有 ${still} 个仍在等待` : ''}`;
  }

  private async revertTarget(
    id: string,
    target: DreamTarget,
    repos: ReadonlyArray<{ repo: string; url: string }>,
  ): Promise<{ prUrl?: string; note: string }> {
    if (target.revertPrUrl) return { prUrl: target.revertPrUrl, note: '已经开过撤销 PR' };
    const info = await pullRequestMergeInfo(this.deps.workDir, target.prUrl!);
    if ('error' in info) return { note: `读不到 PR 状态：${info.error}` };
    if (info.state === 'OPEN') return { note: '还没合并，没有生效；不要的话直接在平台上关闭这个 PR' };
    if (info.state === 'CLOSED') return { note: '已关闭、没合并，没有生效，不用撤销' };
    if (info.state !== 'MERGED' || !info.mergeCommit) return { note: `PR 状态是 ${info.state || '未知'}，没法撤销` };
    const url = repos.find((item) => item.repo === target.repo)?.url;
    if (!url) return { note: '这个仓库已经不在配置里，没法撤销' };
    const branch = `${dreamBranch(id)}-revert`;
    const dir = join(this.deps.workDir, 'reverts', id, target.repo.replace(/[^\w.-]+/g, '-'));
    const label = target.label;
    const prepared = await prepareCheckout(
      { repo: target.repo, label, url, ...(info.base ? { ref: info.base } : {}) },
      dir,
      branch,
    );
    if ('error' in prepared) return { note: prepared.error };
    const title = `撤销课堂精练 ${id}（${label}）`;
    const reverted = await revertDraft(dir, info.mergeCommit, title, this.hooksDir());
    if ('error' in reverted) return { note: reverted.error };
    const access = await checkPullRequestAccess(dir);
    if ('error' in access) return { note: access.error };
    const pushed = await pushDraft(dir, branch, this.hooksDir());
    if ('error' in pushed) return { note: pushed.error };
    const pr = await openDraftPullRequest(dir, {
      branch,
      base: prepared.base,
      title,
      body: [
        `撤销课堂精练批次 \`${id}\` 合并进 ${label} 的内容（原 PR：${target.prUrl}）。`,
        '',
        `由 profile \`${this.deps.profile}\` 的 \`/dream revert\` 生成。和其他课堂精练 PR 一样，合并这个 PR 才生效。`,
      ].join('\n'),
    });
    if ('error' in pr) return { note: pr.error };
    this.saveTarget(id, { ...target, revertPrUrl: pr.url });
    log.info('dream', 'revert-opened', { batch: id, repo: target.repo });
    return { prUrl: pr.url, note: '撤销 Draft PR 已开' };
  }

  private saveTarget(id: string, target: DreamTarget): DreamTarget {
    const clean = { ...target };
    if (clean.error === undefined) delete clean.error;
    this.state.saveTarget(id, clean);
    return clean;
  }

  private finish(id: string, status: DreamRun['status'], note: string): void {
    this.state.updateRun(id, { status, endedAt: this.now(), note });
    log.info('dream', 'run-finished', { batch: id, status });
  }

  private hooksDir(): string {
    return join(this.deps.workDir, 'no-hooks');
  }

  private lockDir(): string {
    return this.deps.lockDir ?? join(this.deps.workDir, 'locks');
  }

  /** Every repository a run may write to: the knowledge repo and the configured skill libraries. */
  private repoTargets(knowledgeUrl: string | undefined): Array<{ repo: string; url: string }> {
    return [
      ...(knowledgeUrl ? [{ repo: 'knowledge', url: knowledgeUrl }] : []),
      ...(this.deps.profileConfig().skills?.libraries ?? []).map((library) => ({ repo: `skills:${library.name}`, url: library.url })),
    ];
  }

  private reader(): (record: DreamSessionRecord) => Promise<AgentTranscript | undefined> {
    return (
      this.deps.readTranscript ??
      ((record) => readAgentTranscript(record.agentId, this.deps.profileConfig(), record.handle, record.cwd))
    );
  }

  private noteCatalog(): void {
    for (const entry of this.deps.sessionCatalog?.entries() ?? []) this.noteEntry(entry, entry.updatedAt);
  }

  private noteEntry(entry: SessionCatalogEntry, at: number): void {
    if (!isAgentKind(entry.agentId)) return;
    const handle = entry[agentDescriptor(entry.agentId).sessionHandle];
    if (!handle) return;
    this.state.noteSession({ agentId: entry.agentId, handle, scopeId: entry.scopeId, cwd: entry.cwdRealpath, at });
  }

  /** Keep the checkouts of the latest runs and of drafts still waiting for a retry. */
  private async pruneCheckouts(): Promise<void> {
    const root = join(this.deps.workDir, 'batches');
    const runs = this.state.runs();
    const keep = new Set(runs.slice(-KEEP_CHECKOUT_RUNS).map((run) => run.id));
    for (const run of runs) {
      if (run.targets.some((target) => target.phase === 'committed' || target.phase === 'pushed')) keep.add(run.id);
    }
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return;
    }
    for (const name of names) {
      if (keep.has(name)) continue;
      await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined);
      const run = runs.find((item) => item.id === name);
      for (const target of run?.targets ?? []) {
        if (target.checkoutDir) this.state.saveTarget(name, { ...target, checkoutDir: undefined });
      }
    }
    await rm(join(this.deps.workDir, 'reverts'), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The run limits scaled down to a share; never below one session / one minute. */
function scaleBudget(settings: DreamSettings, budget: number): DreamSettings {
  if (budget >= 1) return settings;
  return {
    ...settings,
    maxSessions: Math.max(1, Math.floor(settings.maxSessions * budget)),
    maxInputChars: Math.max(1_000, Math.floor(settings.maxInputChars * budget)),
    maxRunMinutes: Math.max(1, Math.floor(settings.maxRunMinutes * budget)),
  };
}

/**
 * The status of a profile's 课堂精练 from its state file and config. The
 * service passes its own running batch; a viewer in another process (the web
 * console looking at a daemon-run profile) takes the stored one.
 */
export async function composeDreamStatus(input: {
  state: DreamStateStore;
  running?: DreamRun;
  appConfig: AppConfig;
  profileConfig: ProfileConfig;
  knowledge: KnowledgeStore;
}): Promise<DreamStatusView> {
  const runs = input.state.runs();
  const targets = runs.slice(-10).flatMap((run) => run.targets);
  const lastSucceeded = [...runs].reverse().find((run) => run.status === 'succeeded');
  const running =
    input.running ?? [...runs].reverse().find((run) => run.status === 'queued' || run.status === 'running');
  const settings = resolveDreamSettings(input.appConfig.preferences?.dreamTuning);
  const url = await knowledgeRemoteUrl(input.knowledge).catch(() => undefined);
  const library = defaultSkillLibrary(input.profileConfig.skills?.libraries ?? [], settings.skillLibrary);
  return {
    enabled: getDream(input.appConfig) !== undefined,
    settings,
    agent: agentDescriptor(input.profileConfig.agentKind).displayName,
    targets: {
      knowledge: url ? { url: maskUrlCredentials(url) } : { problem: '知识库没有绑定远端（/knowledge bind）' },
      skills: 'library' in library ? { library: library.library.name } : { problem: library.problem },
    },
    ...(running ? { running } : {}),
    runs: runs.slice(-5).reverse(),
    ...(lastSucceeded?.endedAt ? { lastSucceededAt: lastSucceeded.endedAt } : {}),
    openedPrs: targets.filter((target) => target.phase === 'pr-created').length,
    pendingDrafts: targets.filter((target) => target.phase === 'committed' || target.phase === 'pushed').length,
    trackedSessions: input.state.sessions().length,
    auto: {
      enabled: getDreamAuto(input.appConfig) !== undefined,
      settings: settings.auto,
      ledger: input.state.autoLedger(),
    },
  };
}

/**
 * The library new skills go to: the configured `dreamTuning.skillLibrary`,
 * else the only library there is. More than one and none chosen is ambiguous.
 */
export function defaultSkillLibrary(
  libraries: readonly SkillLibraryConfig[],
  chosen: string | undefined,
): { library: SkillLibraryConfig } | { problem: string } {
  if (chosen) {
    const library = libraries.find((item) => item.name === chosen);
    return library ? { library } : { problem: `配置的 skill 库 ${chosen} 不存在` };
  }
  if (libraries.length === 0) return { problem: '没有配置 skill 库（/skills lib add）' };
  if (libraries.length > 1) return { problem: '配置了多个 skill 库，需要在 preferences.dreamTuning.skillLibrary 里指定一个' };
  return { library: libraries[0]! };
}

function batchId(now: number): string {
  const iso = new Date(now).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${randomBytes(2).toString('hex')}`;
}

export { sessionKey };
