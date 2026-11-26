import {
  MODEL_COMMAND_USAGE,
  ModelPinStore,
  OWNER_ONLY_PINS,
  parseModelCommand,
} from '../agent/model-pin';
import { protectedWorkspacePaths, startWorktreeCleanup } from '../git/worktree-cleanup';
import type {
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
} from '@larksuite/channel';
import { createLarkChannel, normalize } from '@larksuite/channel';
import { mkdirSync } from 'node:fs';
import { type RunContext, writeRunContext } from './run-context';
import { entryTrackerFor } from './entry-tracker';
import { dirname, join } from 'node:path';
import { agentAccountName, startAgentWindowStagger } from '../agent/account';
import { agentCapability } from '../agent/capability';
import {
  modelLabel,
  normalizeModelSelection,
  resolveEffortArg,
  resolveModelArg,
  resolvedModelLabel,
} from '../agent/models';
import {
  promptSection,
  type BridgePromptChatContext,
} from '../agent/prompt';
import type { AgentAdapter, AgentEvent } from '../agent/types';
import { handleCardAction } from './card-actions';
import { CallbackAuth, operatorForAction } from '../card/callback-auth';
import { CallbackNonceStore } from '../card/callback-store';
import { CodeSnippetStore } from '../card/code-snippets';
import { fitCardToBudget } from '../card/card-budget';
import { detectLocale, runStrings, type Locale } from '../card/i18n';
import { withoutOffLocaleProgress } from '../card/progress-language';
import { renderCard, renderTopicOpenerCard } from '../card/run-renderer';
import type { RunCardRenderOptions } from '../card/run-renderer';
import {
  backgroundLeft,
  finalAnswerState,
  finalizeIfRunning,
  initialState,
  reduce,
  stripControlMarkers,
  type Block,
  type RunLimit,
  type RunState,
  type Terminal,
} from '../card/run-state';
import { renderText } from '../card/text-renderer';
import { tryHandleCommand, type Controls } from '../commands';
import { parseNotifyTarget, type AppConfig, type MessageReplyMode } from '../config/schema';
import {
  effortPrefForChat,
  getAgentStopGraceMs,
  getCotMessages,
  getCronMaxConcurrentJobs,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getLongRunNoticeMs,
  isOwnerNotifyChat,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  getSmartSession,
  getFinalCardPreference,
  getTextReplyFinalOnly,
  getWorktreeCleanupIdleDays,
  resolveBotOverload,
} from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { tmpdir } from 'node:os';
import { AutoEffortStore, resolveAutoEffort } from '../agent/auto-effort';
import { claudeAccountPool } from '../agent/claude/accounts';
import { autoEffortByline, startAutoEffort, type AutoEffortPick, type AutoEffortPlan } from './auto-effort-flow';
import { overloadCard } from '../card/templates';
import { botOwnersOf, BotOverloadGuard, isBotOnlyBatch, isOverloadExempt } from './bot-overload';
import { fireAndForget } from '../core/fire-and-forget';
import { notifyCorruptStateFiles } from './state-file-notice';
import { scopeKey } from './scope';
import {
  answerTextOf,
  awaitRenderAwareStream,
  CARD_HEARTBEAT_MS,
  createLazyProgressStream,
  deliverAnswerOutsideCard,
  deliverCodeNatively,
  finalReplyState,
  opensProgressEagerly,
  pointerState,
  recallIfEmptyStreamedReply,
  requireMessageReceipt,
  rescueCardReply,
  runActivity,
  scheduleWorkingReactionCleanup,
  sendCotDegradedNotice,
  sendFinalReply,
  shouldOpenProgressStream,
} from './reply-delivery';
import {
  buildPrompt,
  humanRequesters,
  replyQuoteTargetForMessage,
  senderIdsOf,
  senderTypeOf,
  toPromptContextMessage,
} from './prompt-build';
import { log, redactDiagnosticText, reportMetric, withTrace } from '../core/logger';
import { MediaCache, type LocalAttachment } from '../media/cache';
import {
  toPolicyAttachment,
} from '../media/attachment';
import { canRunAdminCommand, canUseDm, canUseGroup, isCreator, requireMentionForChat, runNeedsApproval } from '../policy/access';
import {
  grantedToolsFor,
  guestAccessInstruction,
  guestRunGuard,
  isOwnerBatch,
  publicDmLimits,
  restrictedChatGuard,
  restrictedChatInstruction,
  restrictedChatWorkspace,
} from '../policy/owner-guard';
import { paths } from '../config/paths';
import { MeetingManager } from '../meeting/manager';
import type { VcRequestClient } from '../meeting/api';
import { attachMeetingAgent, summarizeEndedMeeting } from '../meeting/orchestrator';
import type { ScopeContext } from '../policy/run-policy';
import { createOwnerRefreshController } from '../policy/owner';
import {
  RunExecutor,
  type BackgroundTurn,
  type BackgroundTurnHandler,
  type RunApprovalGates,
} from '../runtime/run-executor';
import { probeAgentSession } from '../agent/session-probe';
import type { SessionCatalog } from '../session/catalog';
import {
  newSessionRequest,
  rotationNotice,
  SMART_SESSION_INSTRUCTION,
} from '../session/smart-session';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { ActiveRuns } from '../runtime/active-runs';
import { INTERRUPT_RESUME_DELAY_MS, MAX_INTERRUPT_RESUMES, isKilledExit, stripLedgerLines } from './task-ledger';
import type { RunRecord } from '../runtime/run-registry';
import {
  AutoResumer,
  MAX_AUTO_RESUMES,
  formatMoment,
  resumePromptFor,
  resumeAtFor,
  type PendingResume,
} from './auto-resume';
import { KickoffInbox, kickoffScope, type Kickoff } from './kickoff-inbox';
import { CardPatchHealth, instrumentCardPatches } from './card-patch-health';
import { processAgentStream } from './agent-stream';
import { createRunsMonitor } from './runs-monitor';
import { ChatModeCache, type ChatMode } from './chat-mode-cache';
import { handleCommentMention } from './comments';
import { recordRunSessionEvent, startRunFlow } from './run-flow';
import { reportInterruptedRuns } from './interrupted-notice';
import { RunRegistry } from '../runtime/run-registry';
import { buildKnowledgeContext, knowledgeStub, listedNoteNames, nativeSkillOption } from '../knowledge/inject';
import { NoteExposure } from '../knowledge/exposure';
import { findRelevantNotes } from '../knowledge/relevance';
import { writeKnowledgeSnapshot } from '../knowledge/snapshot';
import { getKnowledgeSyncIntervalMinutes, KnowledgeAutoSync } from '../knowledge/auto-sync';
import { getSkillSyncIntervalMinutes, SkillLibraries } from '../knowledge/libraries';
import { syncKnowledge } from '../knowledge/sync';
import { KnowledgeStore } from '../knowledge/store';
import { Scheduler } from '../scheduler/scheduler';
import { DreamService } from '../dream/service';
import { JobStore } from '../scheduler/store';
import { commandSessionCatalogIdentity } from './session-catalog-identity';
import { startKeepalive } from './keepalive';
import { PendingQueue } from './pending-queue';
import { PendingStore, type PendingRecord } from './pending-store';
import { PendingRotationStore } from '../session/rotation-store';
import { formatUsageLine, UsageLedger } from '../runtime/usage-ledger';
import { ApprovalBroker, type GateContext } from '../runtime/approvals';
import { ApprovalSocketServer } from '../runtime/approval-socket';
import { AuditLog } from '../runtime/audit-log';
import { createApprovalNotifier } from './approval-notifier';
import { ProcessPool } from '../runtime/process-pool';
import { fetchQuotedContext, type QuotedContext } from './quote';
import { ChatContextCursorStore, fetchChatContext, planChatContext } from './chat-context';
import { lookupMessageThreadId } from './thread-id';
import {
  isSpawnedTopic,
  markSpawnedTopic,
  matchTopicPrefix,
  autoTopicEnabled,
  autoTopicPrefix,
  type TopicPrefix,
  openTopicUnder,
  topicOpenedText,
  topicRunText,
} from './topic-prefix';
import { claimQuotedForTopic, claimedTopicFor, FORWARD_NOTE_HOLD_MS, holdsForNote } from './topic-claims';
import { adoptCardStream, holdTopicOpener, releaseTopicOpener, takeTopicOpener, topicOpenedNoticeCard } from './topic-opener';
import {
  addDoneReaction,
  addSupplementReaction,
  addWorkingReaction,
  QueuedReactions,
} from './reaction';
import {
  otherSupplementInstruction,
  SUPPLEMENT_INSTRUCTION,
  supplementPreview,
  supplementRole,
  supplementSignal,
  topicFollowupFolds,
} from './supplement';
import { applyRecall, RecalledMessages, settleEarlyRecalls } from './recall';
import { registerChannelEvents } from './channel-events';
import { attachEventHooks, resolveEventHooks } from '../events/hooks';
import {
  type EditEvent,
  EditedMessages,
  editInstruction,
  editPreview,
  editSupplementInstruction,
  isEdited,
  markEdited,
  runForMessage,
} from './edit';
import { mediaPlaceholders } from './media-placeholders';
import { OWNER_BRIEF_INSTRUCTION, planOwnerNotice, stripBriefMarker } from '../card/owner-notify';
import { FINAL_CARD_TITLE_INSTRUCTION } from '../card/title-marker';
import { planLongRunNotice, sendLongRunNotice } from './long-run-notice';
import {
  BackgroundOrigins,
  backgroundTasksInstruction,
  messagePreview,
  settleBackgroundOrigins,
  type BackgroundOrigin,
  type ResultLocation,
} from './background-origins';
import { fetchKnownChats } from './lark-info';
import type { AppPaths } from '../config/app-paths';
import {
  consumeCotEvents,
  CotClient,
  CotPublisher,
  finalAnswerOnlyState,
} from './cot';

const DEBOUNCE_MS = 600;

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

const SUPPRESSED_ENDPOINT_API_ERRORS = [
  {
    code: 99991672,
    urlPart: '/open-apis/wiki/v2/spaces/get_node',
  },
];

function codeFromObj(m: unknown): number | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const top = (m as { code?: unknown }).code;
  if (typeof top === 'number') return top;
  const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof nested === 'number' ? nested : undefined;
}

function urlFromObj(m: unknown): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const configUrl = (m as { config?: { url?: unknown } })?.config?.url;
  if (typeof configUrl === 'string') return configUrl;
  const requestPath = (m as { request?: { path?: unknown } })?.request?.path;
  return typeof requestPath === 'string' ? requestPath : undefined;
}

function isSuppressedSdkMessage(msg: unknown): boolean {
  if (Array.isArray(msg)) return msg.some(isSuppressedSdkMessage);
  const code = codeFromObj(msg);
  if (code === undefined) return false;
  if (SUPPRESSED_API_ERROR_CODES.has(code)) return true;
  const url = urlFromObj(msg);
  return SUPPRESSED_ENDPOINT_API_ERRORS.some(
    (rule) => code === rule.code && url?.includes(rule.urlPart),
  );
}

export function shouldSuppressSdkErrorLog(args: unknown[]): boolean {
  return args.some(isSuppressedSdkMessage);
}

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  return {
    error: (...args: unknown[]) => {
      if (shouldSuppressSdkErrorLog(args)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

/** How long shutdown will wait on interruption notices before giving up. */
const SHUTDOWN_NOTICE_BUDGET_MS = 5_000;

/**
 * Await `task`, but never for longer than `ms`. Failures and timeouts are
 * logged, not thrown — every caller is on a teardown path where the work is
 * a courtesy, not a requirement.
 */
async function withDeadline(task: Promise<void>, ms: number, step: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([task.then(() => 'done' as const), deadline]);
    if (outcome === 'timeout') log.warn(step, 'deadline-exceeded', { ms });
  } catch (err) {
    log.warn(step, 'failed', { err: String(err) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

export interface StartChannelDeps {
  cfg: AppConfig;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  controls: Controls;
  appPaths?: Pick<
    AppPaths,
    | 'secretsFile'
    | 'keystoreSaltFile'
    | 'mediaDir'
    | 'runsFile'
    | 'knowledgeDir'
    | 'jobsFile'
    | 'pendingFile'
    | 'usageFile'
    | 'auditFile'
    | 'profileDir'
  > &
    Partial<
      Pick<AppPaths, 'rotationsFile' | 'contextCursorsFile' | 'skillLibrariesDir' | 'userLockDir' | 'autoResumeFile' | 'kickoffDir'>
    >;
}

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, sessions, sessionCatalog, workspaces, controls } = deps;
  const activeRuns = new ActiveRuns();
  // Durable twin of `activeRuns`: survives this process so the next one can
  // see which runs never finished. Absent only in tests that omit appPaths.
  const runs = deps.appPaths?.runsFile ? new RunRegistry(deps.appPaths.runsFile) : undefined;
  await runs?.load();
  // Durable twin of the pending queue. Whatever the previous process left is
  // taken now, before any new message can overwrite a scope's entry, and is
  // re-queued or reported once the channel is up.
  const pendingStore = deps.appPaths?.pendingFile ? new PendingStore(deps.appPaths.pendingFile) : undefined;
  await pendingStore?.load();
  const leftoverPending = pendingStore?.takeAll() ?? [];
  // Who consumed how much of the owner's agent quota (/usage, card byline).
  const usageLedger = deps.appPaths?.usageFile ? new UsageLedger(deps.appPaths.usageFile) : undefined;
  await usageLedger?.load();
  controls.usage = usageLedger;
  // Cross-session memory + skills. Absent only in tests that omit appPaths,
  // where every run simply gets no knowledge block.
  const knowledge = deps.appPaths?.knowledgeDir
    ? new KnowledgeStore(deps.appPaths.knowledgeDir)
    : undefined;
  // How often each note was listed to the agent: the index shows the least shown in turn.
  const noteExposure = knowledge && deps.appPaths?.knowledgeDir
    ? new NoteExposure(join(dirname(deps.appPaths.knowledgeDir), 'note-exposure.json'))
    : undefined;
  if (knowledge) {
    controls.knowledge = knowledge;
    if (noteExposure) {
      await noteExposure.load();
      knowledge.setNoteExposure({ shown: () => noteExposure.asOf(Date.now()), record: (names) => noteExposure.record(names) });
    }
    // Create the skeleton up front so `/skills` has a directory to point at and
    // `/knowledge bind` has something to commit.
    await knowledge.ensure().catch((err: unknown) =>
      log.warn('knowledge', 'ensure-failed', { err: String(err) }),
    );
  }
  // Shared skill libraries (`/skills lib`): read-only git mirrors merged into
  // the skill index behind the profile's own skills, pulled on start-up and
  // then periodically.
  const skillLibraries = deps.appPaths?.skillLibrariesDir
    ? new SkillLibraries({
        dir: deps.appPaths.skillLibrariesDir,
        libraries: () => controls.profileConfig.skills?.libraries ?? [],
      })
    : undefined;
  if (skillLibraries) {
    controls.skillLibraries = skillLibraries;
    knowledge?.addSkillSource(skillLibraries);
    skillLibraries.startAutoSync(() => getSkillSyncIntervalMinutes(controls.profileConfig.skills));
  }
  // Scheduled jobs (`/cron`). Absent only in tests that omit appPaths — the
  // bridge then simply has no scheduler, and `/cron` says so.
  const jobs = deps.appPaths?.jobsFile ? new JobStore(deps.appPaths.jobsFile) : undefined;
  await jobs?.load();
  // Tasks the plan quota stopped, resumed once it resets. `fire` is bound
  // below, once the pending queue it feeds exists.
  let fireAutoResume: (resume: PendingResume) => Promise<void> = async () => {};
  const autoResumer = new AutoResumer({
    ...(deps.appPaths?.autoResumeFile ? { file: deps.appPaths.autoResumeFile } : {}),
    fire: (resume) => fireAutoResume(resume),
  });
  await autoResumer.load();
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));
  // Who had the bot do what (/audit), and approvals for runs non-admins drive.
  const auditLog = deps.appPaths?.auditFile ? new AuditLog(deps.appPaths.auditFile) : undefined;
  await auditLog?.load().catch((err: unknown) => log.warn('audit', 'load-failed', { err: String(err) }));
  controls.audit = auditLog;
  let channelRef: LarkChannel | undefined;
  const approvalBroker: ApprovalBroker = new ApprovalBroker({
    notifier: createApprovalNotifier({
      channel: () => {
        if (!channelRef) throw new Error('channel not ready');
        return channelRef;
      },
      controls,
      timeoutMinutes: () => approvalBroker.timeoutMinutes,
    }),
    ...(auditLog ? { audit: auditLog } : {}),
    allowlist: () => controls.profileConfig.approvals,
  });
  controls.approvals = approvalBroker;
  // Claude's approval hook calls back over this socket. Without it, gated
  // Claude runs are read-only rather than unguarded.
  const approvalSocket = deps.appPaths?.profileDir
    ? await ApprovalSocketServer.listen(approvalBroker, deps.appPaths.profileDir, controls.profile).catch((err: unknown) => {
        log.warn('approvals', 'socket-listen-failed', { err: String(err) });
        return undefined;
      })
    : undefined;
  const approvalGates: RunApprovalGates = {
    open: (ctx) => {
      const gate = approvalBroker.openGate(ctx);
      return {
        token: gate.token,
        approvals: {
          ...(approvalSocket
            ? { hookCommand: approvalSocket.hookCommand(gate.token), hookTimeoutSec: approvalBroker.timeoutMinutes * 60 + 30 }
            : {}),
          decide: gate.decide,
        },
      };
    },
    update: (token, ctx) => approvalBroker.updateGate(token, ctx),
    close: (token) => approvalBroker.closeGate(token),
  };
  const executor = new RunExecutor({
    agent,
    pool,
    activeRuns,
    approvals: approvalGates,
    ...(usageLedger ? { usage: usageLedger } : {}),
    ...(auditLog ? { audit: auditLog } : {}),
  });

  // Resolve the App Secret to plaintext. The config field can be a literal
  // string, a "${VAR}" template, or a {source, id} SecretRef referencing
  // the encrypted keystore / env / file / exec provider. Re-resolved on
  // every startChannel so /account change picks up new secrets.
  const appSecret = await resolveAppSecret(cfg, deps.appPaths);
  const callbackNonceStore = deps.appPaths?.mediaDir
    ? new CallbackNonceStore(join(dirname(deps.appPaths.mediaDir), 'callback-nonces.json'))
    : undefined;
  await callbackNonceStore?.load();
  const callbackAuth = callbackNonceStore
    ? new CallbackAuth({
        keys: [{ version: 1, secret: appSecret }],
        nonceStore: callbackNonceStore,
      })
    : undefined;
  const activePolicyFingerprints = new Map<string, string>();
  // 会话智能压缩: scopes whose last answer asked to close the conversation
  // (`[[NEW_SESSION]]`); applied when the next message arrives. On disk, so a
  // restart in between still closes it.
  const pendingRotations = new PendingRotationStore(deps.appPaths?.rotationsFile);
  await pendingRotations.load();
  controls.pendingRotations = pendingRotations;
  // Messages whose run answered while background tasks still ran (see BackgroundOrigins).
  const backgroundOrigins = new BackgroundOrigins();
  // 自动分级: each scope's rung on the effort ladder, on disk across restarts.
  const autoEfforts = new AutoEffortStore(
    deps.appPaths?.profileDir ? join(deps.appPaths.profileDir, 'auto-effort.json') : undefined,
  );
  await autoEfforts.load();
  // 指定模型: `/model sonnet …` pins a topic's model, on disk across restarts.
  const modelPins = new ModelPinStore(
    deps.appPaths?.profileDir ? join(deps.appPaths.profileDir, 'model-pins.json') : undefined,
  );
  await modelPins.load();
  controls.modelPins = modelPins;
  // 复制代码: the copy buttons on cards from before answers with code went out
  // as posts carry a key into this store; kept so those buttons still work.
  const codeSnippets = deps.appPaths?.mediaDir
    ? new CodeSnippetStore(join(dirname(deps.appPaths.mediaDir), 'code-snippets.json'))
    : undefined;
  if (codeSnippets) {
    await codeSnippets.load();
    controls.codeSnippets = codeSnippets;
  }
  // 群聊 / 话题上下文: per scope, the newest message a run was given — where
  // the next run's catch-up of what the group said in between starts.
  const contextCursors = new ChatContextCursorStore(deps.appPaths?.contextCursorsFile);
  await contextCursors.load();
  // Per-scope record of the model used on the last run, so a `/config` model
  // switch can inject a one-time "model changed" note into the next (resumed)
  // prompt. In-memory only: on restart the first run re-seeds silently.
  const lastRunModelByScope = new Map<string, string>();
  const cotClient = new CotClient({
    tenant: cfg.accounts.app.tenant,
    appId: cfg.accounts.app.id,
    appSecret,
  });
  // A reply thread in a group or p2p chat is normal use, not a problem: info
  // only (it was a once-per-chat warn, which only grew with restarts).
  const logThreadModeOverride: LogThreadModeOverride = ({ chatId, resolvedMode, threadId }) => {
    log.info('chat', 'mode-overridden-by-thread', { chatId, cachedMode: resolvedMode, threadId });
  };

  const opts: LarkChannelOptions = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain:
      cfg.accounts.app.tenant === 'lark'
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn',
    source: 'lark-channel-bridge',
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    // The SDK caches chat rosters; task observers only read persisted names.
    resolveSenderNames: true,
    outbound: {
      streamThrottleMs: 400,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // Per-request REST timeout — without a cap a slow API can hang the
    // event-handling thread.
    httpTimeoutMs: 30_000,
    // Route WS + REST through HTTPS_PROXY / HTTP_PROXY when set (no-op otherwise).
    respectProxyEnv: true,
  };

  const channel = createLarkChannel(opts);
  channelRef = channel;
  // 撤回消息: recently recalled ids, for messages caught between queue and run.
  const recalled = new RecalledMessages();
  const media = new MediaCache(channel, deps.appPaths?.mediaDir);

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  // 过载保护 (`preferences.botOverload`): reads the agent account's quota for bot-only batches in the listed groups.
  const botOverload = new BotOverloadGuard({
    profileConfig: () => controls.profileConfig,
    scratchDir: join(deps.appPaths?.profileDir ?? tmpdir(), 'quota-scratch'),
    ...(deps.appPaths?.profileDir ? { profileDir: deps.appPaths.profileDir } : {}),
  });
  // 稍等 on messages queued behind a running run; off again once they run.
  const queuedReactions = new QueuedReactions(channel);
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, queued) => {
    void queuedReactions.release(queued.map((m) => m.messageId));
    // A recall can land after intake but before the queue had the message.
    const batch = queued.filter((m) => !recalled.has(m.messageId));
    if (batch.length < queued.length) {
      log.info('recall', 'dropped-at-flush', { scope, dropped: queued.length - batch.length });
    }
    const firstMsg = batch[0];
    if (!firstMsg) return;
    pending.block(scope);
    void withTrace({ chatId: firstMsg.chatId }, async () => {
      log.info('flush', 'start', {
        scope,
        batchSize: batch.length,
        chatId: firstMsg.chatId,
        threadId: firstMsg.threadId,
        msgId: firstMsg.messageId,
      });
      try {
        const resolvedMode = await chatModeCache.resolve(channel, firstMsg.chatId);
        // Feishu/Lark converted topic groups may still resolve as `group` from
        // the chat info API/cache, while message events already carry threadId.
        // Treat threadId as authoritative for IM messages so scope and replies
        // stay isolated per topic.
        const mode = firstMsg.threadId ? 'topic' : resolvedMode;
        // A private chat's threads (auto topics) can't make it a topic group:
        // keep its cached mode instead of resolving it again on every message.
        if (firstMsg.threadId && resolvedMode !== 'topic' && resolvedMode !== 'p2p') {
          chatModeCache.invalidate(firstMsg.chatId);
          logThreadModeOverride({
            chatId: firstMsg.chatId,
            resolvedMode,
            threadId: firstMsg.threadId,
          });
        }
        await runAgentBatch({
          channel,
          executor,
          sessions,
          sessionCatalog,
          workspaces,
          media,
          batch,
          controls,
          cotClient,
          callbackAuth,
          activePolicyFingerprints,
          lastRunModelByScope,
          pendingRotations,
          backgroundOrigins,
          contextCursors,
          scope,
          mode,
          runs,
          autoResumer,
          botOverload,
          activeRuns,
          recalled,
          autoEfforts,
          ...(knowledge ? { knowledge } : {}),
          ...(deps.appPaths?.profileDir
            ? {
                knowledgeSnapshotDir: join(deps.appPaths.profileDir, 'knowledge-snapshots'),
                profileDir: deps.appPaths.profileDir,
              }
            : {}),
        });
      } catch (err) {
        log.fail('flush', err);
        // Unexpected: the batch never reached the agent. Say so instead of staying silent.
        await notifyBatchFailed(channel, batch.at(-1) ?? firstMsg, err).catch((notifyErr: unknown) =>
          log.fail('flush', notifyErr, { step: 'notify-failed' }),
        );
      } finally {
        // A topic opener card no run took over (another reply mode, a rejected batch…) turns back into the notice.
        await releaseTopicOpener(channel, scope);
        pending.unblock(scope);
        log.info('flush', 'end');
      }
    });
  }, (scope, messages) => pendingStore?.set(scope, messages));

  // The console's tasks panel reads live runs / queue depth and issues the
  // same interrupt the IM /stop command uses. Late-bound like `meeting`
  // because all three sources live only inside this channel instance.
  controls.runsMonitor = createRunsMonitor({ activeRuns, pending, ...(runs ? { runs } : {}) });

  fireAutoResume = async (resume) => {
    // Runs on the starter's behalf, so their access is re-checked now: a
    // resume must not outlive the permission that started the task.
    const access =
      resume.chatType === 'p2p'
        ? canUseDm(controls.profileConfig, controls, resume.senderId)
        : canUseGroup(controls.profileConfig, controls, resume.chatId, resume.senderId);
    if (!access.ok) {
      log.warn('auto-resume', 'access-denied', { scope: resume.scope, reason: access.reason });
      return;
    }
    if (resume.cardMessageId && resume.card) {
      await channel
        .updateCard(resume.cardMessageId, withResumedNote(resume.card, Date.now(), resume.locale))
        .catch((err) => log.warn('auto-resume', 'card-note-failed', { err: String(err) }));
    }
    pending.push(resume.scope, autoResumeMessage(resume));
  };

  // Opening tasks left by skills (a new topic's brief): started on the
  // writer's behalf, with their access checked again now, as if they had
  // written the prompt in that conversation.
  const kickoffs = deps.appPaths?.kickoffDir
    ? new KickoffInbox({
        dir: deps.appPaths.kickoffDir,
        fire: async (kickoff) => {
          const access =
            kickoff.chatType === 'p2p'
              ? canUseDm(controls.profileConfig, controls, kickoff.senderId)
              : canUseGroup(controls.profileConfig, controls, kickoff.chatId, kickoff.senderId);
          if (!access.ok) {
            log.warn('kickoff', 'access-denied', { chatId: kickoff.chatId, reason: access.reason });
            return;
          }
          pending.push(kickoffScope(kickoff), kickoffMessage(kickoff));
        },
      })
    : undefined;

  const edits = new EditedMessages();
  const intakeDeps = {
    channel,
    agent,
    sessions,
    sessionCatalog,
    workspaces,
    activeRuns,
    pending,
    media,
    controls,
    chatModeCache,
    logThreadModeOverride,
    executor,
    pool,
    autoResumer,
    recalled,
    queuedReactions,
  };
  registerChannelEvents(channel, {
    message: (msg) => intakeMessage({ ...intakeDeps, msg }),
    cardAction: (evt) =>
      handleCardAction({
        channel,
        evt,
        sessions,
        sessionCatalog,
        workspaces,
        activeRuns,
        agent,
        processPool: pool,
        runExecutor: executor,
        controls,
        pending,
        chatModeCache,
        callbackAuth,
        autoResumer,
        callbackPolicyFingerprintForScope: (scope) => activePolicyFingerprints.get(scope),
      }),
    comment: (evt) =>
      handleCommentMention({
        channel,
        evt,
        agent,
        sessions,
        sessionCatalog,
        workspaces,
        activeRuns,
        executor,
        controls,
      }),
    recall: (evt) => {
      const outcome = applyRecall(evt.messageId, { pending, activeRuns, recalled });
      return {
        action: outcome.action,
        msgId: evt.messageId,
        chatId: evt.chatId,
        recallType: evt.recallType,
        ...(outcome.action === 'none' ? {} : { scope: outcome.scope }),
        ...(outcome.action === 'voided' ? { injected: outcome.injected } : {}),
      };
    },
    edit: (evt) => intakeEdit({ ...intakeDeps, evt, edits }),
  });

  // 事件钩子: console-subscribed events (meeting starts, …) handed to local
  // commands, riding this connection for the same reason as recall/edit.
  attachEventHooks(channel, resolveEventHooks(controls.profileConfig.preferences.eventHooks));

  // In-meeting agent. Created before connect() so the `vc.bot.*` handlers are
  // installed on the event dispatcher before any push can arrive; sessions are
  // only created later (on /meeting join or an invite), so the late-bound
  // botOpenId getter is resolved by then.
  const meetingConfig = () => controls.profileConfig.meeting;
  let meetingManager: MeetingManager | undefined;
  if (meetingConfig().enabled) {
    meetingManager = new MeetingManager({
      client: channel.rawClient as unknown as VcRequestClient,
      config: meetingConfig,
      botOpenId: () => channel.botIdentity?.openId,
      channel,
      // Meeting over: optionally summarize to IM (config-gated inside).
      onEnded: (session) =>
        void summarizeEndedMeeting({
          session,
          channel,
          controls,
          executor,
          activeRuns,
          sessions,
          ...(sessionCatalog ? { sessionCatalog } : {}),
          workspaces,
        }).catch((err) => log.warn('meeting', 'summary-failed', { err: String(err) })),
      onSession: (session) =>
        attachMeetingAgent({
          session,
          channel,
          controls,
          executor,
          activeRuns,
          sessions,
          ...(sessionCatalog ? { sessionCatalog } : {}),
          workspaces,
        }),
    });
    meetingManager.attachPush();
    controls.meeting = meetingManager;
  }

  await channel.connect();

  // Runs owned by a daemon that is gone — SIGKILL, crash, power loss. Their
  // cards are frozen mid-stream with nobody left to finish them, so tell the
  // chat instead. Fire-and-forget: a slow Feishu call must not delay startup.
  if (runs) {
    const orphans = runs.takeOrphans();
    if (orphans.length > 0) {
      void resumeInterruptedRecords(autoResumer, orphans, 'restart')
        .then((resumed) => reportInterruptedRuns(channel, orphans, 'restart', Date.now(), resumed))
        .catch((err: unknown) =>
          log.warn('interrupted-notice', 'sweep-failed', { err: String(err) }),
        );
    }
  }
  // Messages that were waiting behind a run when the previous process went
  // away: recent ones are simply processed now, old ones are reported rather
  // than acted on long after the fact.
  for (const record of leftoverPending) {
    if (Date.now() - record.queuedAt <= PENDING_REQUEUE_WINDOW_MS) {
      log.info('pending', 'requeued', { scope: record.scope, count: record.messages.length });
      for (const msg of record.messages) pending.push(record.scope, msg);
    } else {
      log.info('pending', 'expired', { scope: record.scope, count: record.messages.length });
      void sendExpiredPendingNotice(channel, record);
    }
  }
  // Scheduler starts only after the WS is up: a job that fires before the
  // channel can deliver would produce an answer with nowhere to go.
  let scheduler: Scheduler | undefined;
  if (jobs) {
    scheduler = new Scheduler({
      store: jobs,
      channel,
      executor,
      sessions,
      ...(sessionCatalog ? { sessionCatalog } : {}),
      workspaces,
      controls,
      maxConcurrentJobs: getCronMaxConcurrentJobs(controls.cfg),
    });
    scheduler.start();
    controls.scheduler = scheduler;
  }
  // Same reason as the scheduler: only resume once the channel can deliver.
  autoResumer.start();
  controls.autoResumer = autoResumer;
  kickoffs?.start();

  // 课堂精练: runs when an admin asks (`/practice run`, Web console) or, with
  // 自动整理 on, when its gates pass — never while the profile has anything
  // else to do. Notes the conversations the catalog records while the switch
  // is on, so a later run can still read the ones a newer conversation replaced.
  let dream: DreamService | undefined;
  if (knowledge && deps.appPaths?.profileDir) {
    const notDream = (scope: string) => !scope.startsWith('dream:');
    dream = new DreamService({
      profile: controls.profile,
      stateFile: join(deps.appPaths.profileDir, 'dream-state.json'),
      workDir: join(deps.appPaths.profileDir, 'dream'),
      profileDir: deps.appPaths.profileDir,
      ...(deps.appPaths.userLockDir ? { lockDir: deps.appPaths.userLockDir } : {}),
      knowledge,
      ...(sessionCatalog ? { sessionCatalog } : {}),
      executor,
      appConfig: () => controls.cfg,
      profileConfig: () => controls.profileConfig,
      isAdmin: (senderId) => canRunAdminCommand(controls.profileConfig, controls, senderId).ok,
      isScopeBusy: (scopeId) => activeRuns.get(scopeId) !== undefined || activeRuns.isLingering(scopeId),
      isProfileBusy: () =>
        activeRuns.scopes().some(notDream) ||
        activeRuns.lingeringScopes().some(notDream) ||
        pending.totalDepth() > 0,
      // 课堂精练 gives way only when a user task would wait for a slot, not whenever anything runs.
      isCapacityTight: () => {
        const slots = pool.snapshot();
        return slots.waiting > 0 || slots.active >= slots.cap;
      },
      // publish: push — what was just pushed takes effect now, not at the next periodic sync.
      afterPublish: async (repo) => {
        if (repo === 'knowledge') {
          const synced = await syncKnowledge(knowledge);
          if ('error' in synced) log.warn('dream', 'knowledge-refresh-failed', { error: synced.error });
          return;
        }
        if (repo.startsWith('skills:')) await skillLibraries?.sync(repo.slice('skills:'.length));
      },
      notify: async (target, markdown) => {
        const { chatId, replyTo } = parseNotifyTarget(target);
        await channel.send(chatId, { markdown }, replyTo ? { replyTo, replyInThread: true } : undefined);
      },
    });
    await dream.init().catch((err: unknown) => log.fail('dream', err, { step: 'init' }));
    controls.dream = dream;
  }

  const ownerRefresh = createOwnerRefreshController({
    controls,
    source: channel,
    appId: cfg.accounts.app.id,
  });
  await ownerRefresh.start();
  notifyCorruptStateFiles(channel, controls.botOwnerId, [sessions.takeLoadProblem(), workspaces.takeLoadProblem()]);
  const knownChatsRefresh = startKnownChatsRefreshTimer(channel, controls);

  const identity = channel.botIdentity;
  // Late-bind the bot's own IM identity into the agent adapter so the system
  // prompt can state "this open_id is you" with the real value. Covers both
  // initial start and credential-swap reconnects (both go through here).
  if (identity?.openId) {
    const ownerOpenId = controls.botOwnerId;
    const ownerName = ownerOpenId
      ? resolveBotOverload(controls.cfg)?.botOwners.find((entry) => entry.owner === ownerOpenId && entry.ownerName)?.ownerName
      : undefined;
    agent.setBotIdentity?.({
      openId: identity.openId,
      ...(identity.name ? { name: identity.name } : {}),
      ...(ownerOpenId ? { ownerOpenId } : {}),
      ...(ownerName ? { ownerName } : {}),
    });
  }
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  // App-level keepalive: 15s probe + wake-up detection + HTTP reachability.
  // Defense-in-depth — the SDK's pingTimeout watchdog handles half-dead WS,
  // this catches anything that the SDK misses (silent state stuck, etc.).
  const probeDomain =
    cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart(),
  });

  const worktreeCleanup = deps.appPaths?.profileDir ? startWorktreeCleanup({
    store: workspaces,
    idleDays: () => getWorktreeCleanupIdleDays(controls.cfg),
    protectedPaths: async () => {
      if (activeRuns.snapshot().length > 0 || activeRuns.hasAnyKeptProcess()) {
        throw new Error('profile has active or kept processes');
      }
      return [...await protectedWorkspacePaths(dirname(dirname(deps.appPaths!.profileDir))), ...(controls.profileConfig.workspaces.default ? [controls.profileConfig.workspaces.default] : [])];
    },
  }) : undefined;

  // Claude accounts: keep their 5-hour windows evenly staggered.
  const windowStagger = deps.appPaths?.profileDir
    ? startAgentWindowStagger(controls.profileConfig, deps.appPaths.profileDir)
    : undefined;

  // Knowledge repo auto-sync (`/knowledge bind`): a no-op until the directory
  // is bound to a remote; first round shortly after start-up, then every
  // `knowledge.syncIntervalMinutes`. Repeated failures reach the owner's DM.
  const knowledgeAutoSync = knowledge
    ? new KnowledgeAutoSync({
        store: knowledge,
        intervalMinutes: () => getKnowledgeSyncIntervalMinutes(controls.profileConfig.knowledge),
        owner: () => controls.botOwnerId,
        send: (to, markdown) => channel.send(to, { markdown }),
      })
    : undefined;
  if (knowledgeAutoSync) {
    controls.knowledgeAutoSync = knowledgeAutoSync;
    knowledgeAutoSync.start();
  }

  return {
    channel,
    disconnect: async () => {
      activeRuns.pauseNewRuns('bridge-disconnect');
      await worktreeCleanup?.stop();
      await windowStagger?.stop();
      // Side by side: each gives its in-flight git a few seconds at most.
      await Promise.all([skillLibraries?.stop(), knowledgeAutoSync?.stop()]);
      controls.skillLibraries = undefined;
      controls.knowledgeAutoSync = undefined;
      ownerRefresh.stop();
      knownChatsRefresh.stop();
      keepalive.stop();
      // Stop meeting timers but stay in the meetings: /reconnect tears the
      // channel down and rebuilds it, and auto-leaving every meeting on a
      // reconnect would be surprising.
      meetingManager?.dispose();
      scheduler?.stop();
      autoResumer.stop();
      controls.autoResumer = undefined;
      kickoffs?.stop();
      controls.scheduler = undefined;
      await dream?.dispose().catch((err: unknown) => log.fail('dream', err, { step: 'dispose' }));
      controls.dream = undefined;
      controls.meeting = undefined;
      controls.runsMonitor = undefined;
      controls.usage = undefined;
      controls.approvals = undefined;
      controls.audit = undefined;
      await approvalSocket?.close().catch(log.swallow('bridge', 'approval-socket-close-failed'));
      // Keep the durable copy: the next process (or the rebuilt channel after
      // /reconnect) picks the queued messages up again.
      pending.stop();
      // Nothing still waiting for a decision may slip through after this.
      approvalBroker.cancelAll('bridge 正在重启或断开');
      // Background work dies with this daemon; say so while the channel is up.
      await executor.stopLingering().catch((err: unknown) => {
        log.fail('disconnect', err, { step: 'stopLingering' });
      });
      // Stop the agents first, then report — the notice goes out over this
      // channel, so it has to happen before `channel.disconnect()`. Doing it
      // after stopAll (rather than before) avoids racing a run that was about
      // to deliver its real answer.
      await activeRuns.stopAll().catch((err: unknown) => {
        log.fail('disconnect', err, { step: 'stopAll' });
      });
      if (runs) {
        // Bounded: launchd is already counting down to SIGKILL, and a hung
        // Feishu call must not be what stops us from exiting cleanly.
        const own = runs.takeOwn();
        const resumed = await resumeInterruptedRecords(autoResumer, own, 'shutdown').catch(
          (err: unknown) => {
            log.fail('auto-resume', err, { step: 'shutdown' });
            return new Set<string>();
          },
        );
        await withDeadline(
          reportInterruptedRuns(channel, own, 'shutdown', Date.now(), resumed),
          SHUTDOWN_NOTICE_BUDGET_MS,
          'interrupted-notice',
        );
        await runs.flush();
      }
      // Every store with a write chain. The position is the `flush-<n>` step
      // in the log: append new stores at the end so existing numbers keep
      // their meaning.
      const stores: ReadonlyArray<{ flush(): Promise<unknown> } | undefined> = [
        sessions,
        sessionCatalog,
        callbackNonceStore,
        workspaces,
        jobs,
        pendingStore,
        pendingRotations,
        contextCursors,
        usageLedger,
        auditLog,
        modelPins,
        autoEfforts,
        codeSnippets,
        noteExposure,
        autoResumer,
      ];
      const [disconnectResult, ...flushResults] = await Promise.allSettled([
        channel.disconnect(),
        ...stores.map((s) => s?.flush()),
      ]);
      for (const [idx, result] of flushResults.entries()) {
        if (result.status === 'rejected') {
          log.fail('disconnect', result.reason, { step: `flush-${idx}` });
        }
      }
      if (disconnectResult.status === 'rejected') {
        throw disconnectResult.reason;
      }
    },
  };
}

function startKnownChatsRefreshTimer(
  channel: LarkChannel,
  controls: Controls,
): { stop(): void } {
  const intervalMs = 30 * 60 * 1000;
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel);
    if (chats.length > 0) {
      controls.knownChats = chats;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function sendNonAllowedGroupHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '当前群尚未加入响应列表，所以 bot 不会处理消息。\n' +
    'Bot owner/管理员可在本群发 /invite group 加入白名单。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

/** A batch failed before reaching the agent: tell the sender, so the message is not silently lost. */
async function notifyBatchFailed(channel: LarkChannel, msg: NormalizedMessage, err: unknown): Promise<void> {
  const reason = redactDiagnosticText(err instanceof Error ? err.message : String(err)).slice(0, 200);
  const text = `⚠️ 这条消息处理时出错，没有交给 agent（${reason}）。请重新发送一次；反复出现请告诉 bot 主人。`;
  try {
    await channel.send(msg.chatId, { text }, { replyTo: msg.messageId });
  } catch {
    await channel.send(msg.chatId, { text });
  }
}

/**
 * The SDK (@larksuite/channel >= 0.4.1) normalizes a merge_forward whose
 * sub-messages it could not fetch — after its own retries — to this exact
 * sentinel, rather than the empty `<forwarded_messages/>` it emits for a
 * genuinely empty forward. Distinguishing the two is the whole point of that
 * fix: pre-0.4.1 a transient Feishu 5xx/timeout on `im.v1.message.get` was
 * silently indistinguishable from empty, so the agent saw an empty forward and
 * replied "转发内容是空的，请重新转发一次".
 */
const FORWARD_FETCH_FAILED_CONTENT = '<forwarded_messages status="fetch_failed"/>';

/** True when a message is a merge_forward the SDK failed to fetch (see above). */
function isForwardFetchFailed(msg: NormalizedMessage): boolean {
  return (
    msg.rawContentType === 'merge_forward' &&
    msg.content.trim() === FORWARD_FETCH_FAILED_CONTENT
  );
}

async function sendForwardFetchFailedHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '这条合并转发的内容没能从飞书拉取到（上游超时/网络抖动，已自动重试仍失败），' +
    '所以我没收到里面的消息。麻烦稍后重新转发一次。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

interface IntakeDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  media: MediaCache;
  msg: NormalizedMessage;
  controls: Controls;
  chatModeCache: ChatModeCache;
  logThreadModeOverride: LogThreadModeOverride;
  executor: RunExecutor;
  pool: ProcessPool;
  autoResumer?: AutoResumer;
  recalled?: RecalledMessages;
  queuedReactions?: QueuedReactions;
}

type LogThreadModeOverride = (input: {
  chatId: string;
  resolvedMode: ChatMode;
  threadId: string;
}) => void;

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    sessionCatalog,
    workspaces,
    activeRuns,
    pending,
    media,
    msg,
    controls,
    chatModeCache,
    logThreadModeOverride,
    executor,
    pool,
    autoResumer,
  } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const resolvedMode = await chatModeCache.resolve(channel, msg.chatId);
  // Feishu delivers a sizable fraction of topic-group message events without a
  // `thread_id` (notably the message that opens a new topic). We route topic
  // replies (`replyInThread`) and isolate per-topic session scope off it, so a
  // missing one makes the reply escape into a brand-new topic AND collapses the
  // scope to the chat level. When getChatMode says this is a topic group but
  // the event dropped `thread_id`, backfill it from the raw message — the same
  // recovery the card-click path uses.
  let threadId = msg.threadId;
  if (!threadId && resolvedMode === 'topic') {
    threadId = await lookupMessageThreadId(channel, msg.messageId);
    if (threadId) {
      log.info('intake', 'thread-id-backfilled', {
        chatId: msg.chatId,
        msgId: msg.messageId,
        threadId,
      });
    }
  }
  // Carry the (possibly backfilled) threadId on the message so the batched
  // flush — which reads `firstMsg.threadId` for reply routing and topic scope —
  // sees it.
  let emsg: NormalizedMessage = threadId === msg.threadId ? msg : { ...msg, threadId };
  // Some groups are converted into topic groups after creation. In that state
  // getChatMode can lag behind the message event shape, so threadId is the
  // stronger signal for topic-scoped sessions and reply routing.
  const chatMode = threadId ? 'topic' : resolvedMode;
  if (threadId && resolvedMode !== 'topic') {
    chatModeCache.invalidate(msg.chatId);
    logThreadModeOverride({
      chatId: msg.chatId,
      resolvedMode,
      threadId,
    });
  }
  const scope = chatMode === 'topic' && threadId
    ? scopeKey(msg.chatId, threadId)
    : msg.chatId;
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    resolvedMode,
    threadId,
    msgId: msg.messageId,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });
  if (deps.recalled?.has(msg.messageId)) {
    log.info('intake', 'skip-recalled', { scope, msgId: msg.messageId });
    return;
  }

  const accessDecision =
    msg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, msg.senderId)
      : canUseGroup(controls.profileConfig, controls, msg.chatId, msg.senderId);
  if (!accessDecision.ok) {
    log.info('intake', 'skip-not-allowed-user', {
      scope,
      sender: msg.senderId.slice(-6),
      reason: accessDecision.reason,
    });
    if (msg.chatType !== 'p2p' && accessDecision.reason === 'denied-chat' && msg.mentionedBot) {
      void sendNonAllowedGroupHint(channel, msg.chatId, msg.messageId).catch((err) =>
        log.warn('intake', 'non-allowed-hint-failed', { err: String(err) }),
      );
    }
    return;
  }

  // Group-mention policy. p2p is always unrestricted; in groups (regular and
  // topic) we drop messages that don't @bot when the user has opted into the
  // quiet-by-default behavior. A per-chat override (set from /config's group
  // picker) takes priority over the global setting, so one group can respond
  // to everything while others stay @-only (or vice versa). Slash commands are
  // NOT exempt — the user chose strict mode so the group stays uniformly quiet
  // unless mentioned. @全员 is already filtered by SDK
  // (`respondToMentionAll: false`), so any event reaching here is either
  // targeted or undirected chatter.
  if (
    msg.chatType !== 'p2p' &&
    requireMentionForChat(controls.profileConfig, controls.cfg, msg.chatId) &&
    !msg.mentionedBot
  ) {
    log.info('intake', 'skip-no-mention', { scope, chatType: msg.chatType });
    return;
  }

  // A merge_forward whose sub-messages the SDK could not fetch (transient
  // upstream failure, already retried inside @larksuite/channel) arrives as the
  // fetch_failed sentinel. Feeding it to the agent would read as an empty
  // forward, so surface a recoverable hint and skip the run — the user can
  // resend once the upstream recovers.
  if (isForwardFetchFailed(emsg)) {
    log.warn('intake', 'forward-fetch-failed', {
      scope,
      msgId: emsg.messageId,
      chatType: emsg.chatType,
    });
    await sendForwardFetchFailedHint(channel, emsg.chatId, emsg.messageId).catch((err) =>
      log.warn('intake', 'forward-fetch-failed-hint-failed', { err: String(err) }),
    );
    return;
  }

  const handled = await tryHandleCommand({
    channel,
    msg: emsg,
    scope,
    chatMode,
    sessions,
    workspaces,
    agent,
    activeRuns,
    sessionCatalog,
    sessionCatalogIdentity: await commandSessionCatalogIdentity({
      msg: emsg,
      scope,
      mode: chatMode,
      workspaces,
      controls,
      access: accessDecision,
    }),
    runExecutor: executor,
    processPool: pool,
    controls,
    ...(autoResumer ? { autoResumer } : {}),
  });
  if (handled) {
    const dropped = pending.cancel(scope);
    // Dropped, not run: their 稍等 would otherwise stay on for good.
    void deps.queuedReactions?.release(dropped.map((m) => m.messageId));
    log.info('intake', 'command', { scope, droppedPending: dropped.length });
    return;
  }

  // 指定模型: `/model sonnet 帮我…` pins the topic's model — opening a topic
  // first when it comes outside one. Bare `/model`, `/model auto` and a pin
  // with no task are answered here and go no further.
  let modelRouted: { msg: NormalizedMessage; scope: string } | undefined;
  const modelCmd = controls.modelPins ? parseModelCommand(emsg.content ?? '') : undefined;
  if (modelCmd && controls.modelPins) {
    const out = await intakeModelCommand(channel, controls, controls.modelPins, emsg, scope, chatMode, modelCmd);
    if (!out) return;
    if ('routed' in out) modelRouted = out.routed;
    else emsg = out.msg;
  }

  // User tasks come first: an automatic 课堂精练 still drafting stops here.
  deps.controls.dream?.preempt('有新的用户消息');

  // 前缀开话题: `/xhigh 帮我…` outside a topic runs in a topic of its own,
  // opened under the message itself — not in this conversation, and not as a
  // supplement to a run going on in it.
  const stays = resolvedMode === 'topic' || Boolean(deps.recalled?.has(emsg.messageId));
  const fromPerson = !stays && !emsg.threadId && senderTypeOf(emsg) !== 'bot';
  // 转发 + 备注: the note claims the forward it quotes, so the two share the
  // note's topic instead of opening one each.
  const claim = fromPerson ? claimQuotedForTopic(emsg) : undefined;
  let routed: { msg: NormalizedMessage; scope: string } | undefined;
  try {
    routed = modelRouted ?? (stays ? undefined : await routeTopicPrefix(channel, controls, emsg, scope));
    // 自动开话题: any other message from a person gets a topic too — unless it
    // follows up on a run going on right here, which it joins instead.
    if (
      !routed &&
      fromPerson &&
      autoTopicEnabled(controls.profileConfig.preferences.autoTopic, emsg.chatId)
    ) {
      if (
        await tryInjectSupplement({
          channel,
          activeRuns,
          media,
          controls,
          msg: emsg,
          scope,
          mode: chatMode,
          ...(deps.recalled ? { recalled: deps.recalled } : {}),
        })
      ) {
        return;
      }
      routed =
        (await joinClaimedTopic(emsg, scope)) ??
        (await openTopicFor(channel, emsg, scope, autoTopicPrefix(emsg.content ?? '')));
    }
    const threadId = routed?.msg.threadId;
    claim?.settle(routed && threadId ? { threadId, scope: routed.scope } : undefined);
  } finally {
    claim?.settle(undefined);
  }
  const runMsg = routed?.msg ?? emsg;
  const runScope = routed?.scope ?? scope;
  const runMode: ChatMode = routed ? 'topic' : chatMode;

  if (
    await tryInjectSupplement({
      channel,
      activeRuns,
      media,
      controls,
      msg: runMsg,
      scope: runScope,
      mode: runMode,
      ...(deps.recalled ? { recalled: deps.recalled } : {}),
    })
  ) {
    return;
  }

  // Recalled while intake was still resolving it.
  if (deps.recalled?.has(runMsg.messageId)) {
    log.info('intake', 'skip-recalled', { scope: runScope, msgId: runMsg.messageId });
    await releaseTopicOpener(channel, runScope);
    return;
  }
  const size = pending.push(runScope, runMsg);
  // Behind a run going on right here: say it was received, it is not lost.
  const behindRun = Boolean(activeRuns.get(runScope));
  if (behindRun) deps.queuedReactions?.mark(runMsg.messageId);
  log.info('intake', 'queued', {
    scope: runScope,
    queueSize: size,
    debounceMs: DEBOUNCE_MS,
    ...(behindRun ? { behindRun } : {}),
  });
}

/**
 * A message opening with `/new-topic` or a rung prefix, outside any topic: open a topic under
 * it and hand back the message as it runs there. Undefined when the message
 * stays where it is — no prefix, the feature is off, or Feishu would not open
 * the topic.
 */
async function routeTopicPrefix(
  channel: LarkChannel,
  controls: Controls,
  msg: NormalizedMessage,
  scope: string,
): Promise<{ msg: NormalizedMessage; scope: string } | undefined> {
  if (msg.threadId) return undefined;
  const prefs = controls.profileConfig.preferences;
  if (prefs.topicPrefix === false) return undefined;
  const ladder = resolveAutoEffort(prefs.autoEffort, controls.profileConfig.agentKind)?.ladder ?? [];
  const prefix = matchTopicPrefix(
    msg.content ?? '',
    ladder.map((r) => r.label),
    { attachments: msg.resources.length, quoted: Boolean(msg.replyToMessageId) },
  );
  if (!prefix) return undefined;
  return openTopicFor(channel, msg, scope, prefix);
}

/** The reply card's Effort line on a run whose topic is pinned with `/model`. */
function pinnedByline<T extends string>(effort: T | undefined, pinned: boolean): T | string | undefined {
  return pinned ? `${effort ?? 'default'}（指定模型）` : effort;
}

/**
 * `/model …` (see model-pin.ts). Undefined: answered, nothing to run. `msg`:
 * run it in this topic, prefix taken off. `routed`: a topic was opened for it.
 */
async function intakeModelCommand(
  channel: LarkChannel,
  controls: Controls,
  pins: ModelPinStore,
  msg: NormalizedMessage,
  scope: string,
  chatMode: ChatMode,
  cmd: NonNullable<ReturnType<typeof parseModelCommand>>,
): Promise<{ msg: NormalizedMessage } | { routed: { msg: NormalizedMessage; scope: string } } | undefined> {
  const inTopic = chatMode === 'topic' && Boolean(msg.threadId);
  const say = async (markdown: string): Promise<void> => {
    try {
      await channel.send(msg.chatId, { markdown }, { replyTo: msg.messageId, ...(inTopic ? { replyInThread: true as const } : {}) });
    } catch (err) {
      log.warn('model-pin', 'reply-failed', { scope, err: String(err) });
    }
  };
  const label = (model: string): string => modelLabel(controls.profileConfig.agentKind, model);
  if (cmd.kind === 'show') {
    const pin = pins.get(scope);
    await say(
      pin
        ? `本话题固定用 **${label(pin.model)}**。\`/model auto\` 恢复自动分级。`
        : `本话题没有指定模型，按自动分级选模型。\n\n${MODEL_COMMAND_USAGE}`,
    );
    return undefined;
  }
  if (cmd.kind === 'clear') {
    const had = pins.delete(scope);
    if (had) log.info('model-pin', 'cleared', { scope });
    await say(had ? '已取消指定模型，本话题恢复自动分级。' : '本话题本来就没有指定模型，按自动分级运行。');
    return undefined;
  }
  if (cmd.kind === 'invalid') {
    await say(`不认识的模型「${cmd.name}」。${MODEL_COMMAND_USAGE}`);
    return undefined;
  }
  if (OWNER_ONLY_PINS.has(cmd.model) && (senderTypeOf(msg) === 'bot' || !isCreator(controls, msg.senderId))) {
    await say(`${label(cmd.model)} 只限 bot 主人指定。`);
    return undefined;
  }
  const hasTask = Boolean(cmd.rest) || msg.resources.length > 0 || Boolean(msg.replyToMessageId);
  if (inTopic) {
    pins.set(scope, cmd.model, msg.senderId);
    log.info('model-pin', 'set', { scope, model: cmd.model, msgId: msg.messageId });
    if (!hasTask) {
      await say(`本话题改用 **${label(cmd.model)}**，之后的消息都用这个模型。`);
      return undefined;
    }
    const moved: NormalizedMessage = { ...msg, content: cmd.rest || '请处理我引用的消息或发来的附件。' };
    if (isEdited(msg)) markEdited(moved);
    return { msg: moved };
  }
  if (!hasTask) {
    await say(`话题外请把问题跟在后面：\`/model ${cmd.model} 问题\`，我会单独开一个话题处理。`);
    return undefined;
  }
  const routed = await openTopicFor(channel, msg, scope, { label: cmd.model, kind: 'model', rest: cmd.rest });
  if (!routed) {
    await say('没能开出话题，请稍后再发一次。');
    return undefined;
  }
  pins.set(routed.scope, cmd.model, msg.senderId);
  log.info('model-pin', 'set', { scope: routed.scope, model: cmd.model, msgId: msg.messageId });
  return { routed };
}

/**
 * The topic a message from the same sender quoting `msg` is opening — the
 * note of a 转发 + 备注 pair — with `msg` moved into it; undefined when none
 * claims it. A merge_forward waits briefly for its note to come in.
 */
async function joinClaimedTopic(
  msg: NormalizedMessage,
  scope: string,
): Promise<{ msg: NormalizedMessage; scope: string } | undefined> {
  const topic = await claimedTopicFor(msg, holdsForNote(msg) ? FORWARD_NOTE_HOLD_MS : 0);
  if (!topic) return undefined;
  const moved: NormalizedMessage = { ...msg, threadId: topic.threadId };
  if (isEdited(msg)) markEdited(moved);
  log.info('topic-prefix', 'joined-claimed', { from: scope, scope: topic.scope, msgId: msg.messageId });
  return { msg: moved, scope: topic.scope };
}

/** Open a topic under `msg` and hand back the message as it runs there; undefined when Feishu gives no topic back. */
async function openTopicFor(
  channel: LarkChannel,
  msg: NormalizedMessage,
  scope: string,
  prefix: TopicPrefix,
): Promise<{ msg: NormalizedMessage; scope: string } | undefined> {
  const title = channel.botIdentity?.name ?? 'Occam';
  const fallbackText = topicOpenedText(prefix);
  const opened = await openTopicUnder(channel, msg, {
    card: renderTopicOpenerCard(title, detectLocale([msg.content ?? ''])),
  });
  if (!opened) return undefined;
  const { threadId, openerId } = opened;
  const topicScope = threadId ? scopeKey(msg.chatId, threadId) : undefined;
  // The opener card is the topic's progress card to be; until a run takes it, it is held for the topic.
  holdTopicOpener(topicScope ?? `opener:${openerId}`, { messageId: openerId, title, fallbackText });
  if (!threadId || !topicScope) {
    await releaseTopicOpener(channel, `opener:${openerId}`);
    return undefined;
  }
  const moved = markSpawnedTopic({ ...msg, threadId, content: topicRunText(msg.content ?? '', prefix) });
  if (isEdited(msg)) markEdited(moved);
  log.info('topic-prefix', 'opened', { from: scope, scope: topicScope, msgId: msg.messageId, label: prefix.label });
  return { msg: moved, scope: topicScope };
}

/**
 * An edited message: swapped for its new content while it is still queued,
 * folded into the run it started while that run is going, and otherwise taken
 * in like a new message — which is how an @ added in the edit reaches the bot,
 * and how an edit to a message already answered comes back as an update.
 */
async function intakeEdit(
  deps: Omit<IntakeDeps, 'msg'> & { evt: EditEvent; edits: EditedMessages },
): Promise<void> {
  const { evt, edits, ...intake } = deps;
  const { channel, activeRuns, pending, media, controls, recalled } = intake;
  // Bots edit their own replies all the time; only people's edits count.
  if (evt.senderType !== 'user') return;
  if (!evt.event) {
    log.warn('edit', 'no-sender', { chatId: evt.chatId, msgId: evt.messageId });
    return;
  }
  if (!edits.firstSeen(evt)) {
    log.info('edit', 'duplicate', { msgId: evt.messageId, updateTime: evt.updateTime });
    return;
  }
  const botIdentity = channel.botIdentity;
  if (!botIdentity || recalled?.has(evt.messageId)) return;
  const msg = markEdited(
    await normalize(evt.event, { botIdentity, stripBotMentions: true, includeRaw: true }),
  );
  log.info('edit', 'received', {
    chatId: msg.chatId,
    msgId: msg.messageId,
    updateTime: evt.updateTime,
    mentionedBot: msg.mentionedBot,
  });

  const queuedIn = pending.replace(msg.messageId, msg);
  if (queuedIn) {
    log.info('edit', 'requeued', { scope: queuedIn, msgId: msg.messageId });
    return;
  }

  const running = runForMessage(activeRuns, msg.messageId);
  const inject = running?.handle.run.inject?.bind(running.handle.run);
  if (running && inject) {
    const { scope, handle } = running;
    const attachments = await media.resolve(
      msg.resources.map((r) => ({ messageId: msg.messageId, resource: r })),
      controls.profileConfig.attachments,
    );
    const prompt = buildPrompt(
      [msg],
      attachments,
      [],
      undefined,
      botIdentity,
      [editSupplementInstruction(msg.messageId)],
      undefined,
      isOwnerBatch(controls, [msg], (m) => senderTypeOf(m) === 'bot'),
    );
    // The run may have wrapped up (or the message been recalled) meanwhile.
    const injected =
      !recalled?.has(msg.messageId) &&
      activeRuns.get(scope) === handle &&
      inject(prompt, editPreview(msg.content));
    if (injected) {
      log.info('edit', 'injected', { scope, msgId: msg.messageId });
      void addSupplementReaction(channel, msg.messageId);
      return;
    }
    log.info('edit', 'fallback-queue', { scope, msgId: msg.messageId });
  }

  await intakeMessage({ ...intake, msg });
}

/**
 * Fold a follow-up into the run already going on this scope instead of
 * queueing it as a new question — only on an explicit signal (quote-reply to
 * the run, a 补充/追加/+ prefix, or posting in the same topic unless
 * `preferences.topicFollowup` is `'queue'`) and only from
 * any human — the initiator and the owner add with the run's identity, anyone
 * else's supplement is marked as theirs and may not borrow it (see
 * supplementRole). Bots, and a run that can no longer take input, keep the
 * queue-for-next-run behavior.
 */
async function tryInjectSupplement(deps: {
  channel: LarkChannel;
  activeRuns: ActiveRuns;
  media: MediaCache;
  controls: Controls;
  msg: NormalizedMessage;
  scope: string;
  mode: ChatMode;
  recalled?: RecalledMessages;
}): Promise<boolean> {
  const { channel, activeRuns, media, controls, msg, scope, mode } = deps;
  const handle = activeRuns.get(scope);
  const target = handle?.supplement;
  if (!handle || !target || !handle.run.inject) return false;
  // The scope is per topic, so an active run here is this topic's run.
  const inTopic = mode === 'topic' && Boolean(msg.threadId);
  const signal = supplementSignal(
    msg.content,
    replyQuoteTargetForMessage(msg, mode),
    target,
    inTopic && topicFollowupFolds(controls.profileConfig.preferences.topicFollowup),
  );
  if (!signal) return false;
  const role = supplementRole(
    target,
    msg.senderId,
    isCreator(controls, msg.senderId),
    senderTypeOf(msg) === 'user',
  );
  if (!role) {
    log.info('supplement', 'skip-not-human', { scope, sender: msg.senderId.slice(-6) });
    return false;
  }
  const fromOther = role === 'other';
  const attachments = await media.resolve(
    msg.resources.map((r) => ({ messageId: msg.messageId, resource: r })),
    controls.profileConfig.attachments,
  );
  const prompt = buildPrompt(
    [msg],
    attachments,
    [],
    undefined,
    channel.botIdentity,
    fromOther
      ? [SUPPLEMENT_INSTRUCTION, otherSupplementInstruction(msg.senderName)]
      : [SUPPLEMENT_INSTRUCTION],
    undefined,
    isOwnerBatch(controls, [msg], (m) => senderTypeOf(m) === 'bot'),
  );
  // The run may have wrapped up (or the message been recalled) while
  // attachments were downloading.
  const injected =
    !deps.recalled?.has(msg.messageId) &&
    activeRuns.get(scope) === handle &&
    handle.run.inject(
      prompt,
      supplementPreview(
        msg.content,
        attachments.length,
        fromOther ? (msg.senderName ?? '其他成员') : undefined,
      ),
    );
  if (!injected) {
    log.info('supplement', 'fallback-queue', { scope, msgId: msg.messageId, signal });
    return false;
  }
  // Quoting the supplement later should reach this run too.
  target.originIds.add(msg.messageId);
  log.info('supplement', 'injected', {
    scope,
    msgId: msg.messageId,
    signal,
    role,
    attachments: attachments.length,
  });
  void addSupplementReaction(channel, msg.messageId);
  return true;
}

interface RunBatchDeps {
  channel: LarkChannel;
  autoResumer?: AutoResumer;
  executor: RunExecutor;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  media: MediaCache;
  batch: NormalizedMessage[];
  controls: Controls;
  cotClient: CotClient;
  callbackAuth?: CallbackAuth;
  activePolicyFingerprints: Map<string, string>;
  lastRunModelByScope: Map<string, string>;
  pendingRotations: PendingRotationStore;
  backgroundOrigins: BackgroundOrigins;
  contextCursors: ChatContextCursorStore;
  scope: string;
  mode: ChatMode;
  runs?: RunRegistry;
  knowledge?: KnowledgeStore;
  /** Where knowledge snapshots go (see writeKnowledgeSnapshot); unset: stubs carry no file. */
  knowledgeSnapshotDir?: string;
  botOverload?: BotOverloadGuard;
  activeRuns?: ActiveRuns;
  recalled?: RecalledMessages;
  /** 自动分级 state; unset: runs keep the profile's model and effort. */
  autoEfforts?: AutoEffortStore;
  /** For the rating call's scratch directory and account. */
  profileDir?: string;
}

/**
 * What `runAgentBatch` learns while its run goes on and reads again later:
 * written by one part of it (the level pick, the session events, the reply
 * delivery, a background turn) and read by another (the byline, the
 * `finally` wrap-up). One object, so those parts can be functions of their own.
 */
interface BatchRunState {
  /** 自动分级's pick, once startRunFlow asked for the level. */
  autoPicked?: AutoEffortPick;
  /**
   * Assigned once the reply surface is set up. A background turn only
   * arrives after this run's own reply, so it is always ready by then.
   */
  deliverBackgroundTurn?: BackgroundTurnHandler;
  /** The conversation this run lands in — what an `[[NEW_SESSION]]` at its end closes. */
  conversationHandle?: string;
  /**
   * The answer as the agent wrote it, before the prefs filter: a trailing
   * `[[NEW_SESSION…]]` is read from it once the run is over.
   */
  lastRawState?: RunState;
  /** A background turn already reported the work over (it can beat this run's own wrap-up). */
  backgroundSettled: boolean;
  /**
   * The owner was already @-mentioned for this run (结果提醒主人): a background
   * turn that beats the wrap-up must not leave the `finally` block a second @.
   */
  ownerNotified?: boolean;
  /**
   * Captured from whichever reply branch actually runs, so the `finally`
   * block can decide whether to mark the triggering message "answered"
   * without needing to know which reply mode produced the run.
   */
  runTerminal?: Terminal;
  /** Why the run paused, and the card that says so — for the auto-resume. */
  runLimit?: RunLimit;
  runError?: string;
  pausedCard?: { messageId: string; card: object };
  /**
   * Whether the answer went out as a message of its own (which pushes), as
   * opposed to landing in the progress card that was created at the start.
   */
  answerIsNewMessage: boolean;
}

/** 过载保护 for a batch. True: the batch stops here (a card may have said why). */
async function stopForBotOverload(
  deps: RunBatchDeps,
  input: { chatId: string; threadId: string | undefined; lastMsg: NormalizedMessage },
): Promise<boolean> {
  const { channel, batch, controls, scope, mode } = deps;
  const { chatId, threadId, lastMsg } = input;
  // 过载保护: other bots' questions wait while the quota is tight; humans never do.
  const overload = resolveBotOverload(controls.cfg);
  if (
    overload &&
    deps.botOverload &&
    mode !== 'p2p' &&
    isBotOnlyBatch(batch, senderTypeOf) &&
    !isOverloadExempt(overload, chatId, batch.flatMap(senderIdsOf))
  ) {
    const decision = await deps.botOverload.decide(overload, chatId);
    if (decision.overload) {
      log.info('overload', decision.card ? 'card' : 'dropped', {
        scope,
        chatId,
        msgId: lastMsg.messageId,
        windows: decision.windows.map((w) => `${w.kind}:${w.usedPercent}%`).join(','),
      });
      if (decision.card) {
        const card = overloadCard({
          owners: botOwnersOf(overload, batch.flatMap(senderIdsOf)),
          windows: decision.windows.map((w) => ({
            ...w,
            ...(w.resetAt !== undefined
              ? { resumeAt: w.resetAt - (w.kind === 'week' ? overload.weekGraceHours : overload.sessionGraceHours) * 3_600_000 }
              : {}),
          })),
          cooldownMinutes: overload.cooldownMinutes,
        });
        await channel
          .send(chatId, { card }, { replyTo: lastMsg.messageId, ...(mode === 'topic' && threadId ? { replyInThread: true } : {}) })
          .catch((err: unknown) => log.fail('overload', err, { step: 'send-card' }));
      }
      return true;
    }
  }
  return false;
}

/** The batch's attachments, and the earlier messages it quotes. */
async function resolveBatchInputs(deps: RunBatchDeps): Promise<{
  attachments: LocalAttachment[];
  batchIds: Set<string>;
  quoteTargets: string[];
  quotes: QuotedContext[];
}> {
  const { channel, media, batch, controls, mode } = deps;
  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  const attachments = await media.resolve(resourceItems, controls.profileConfig.attachments);
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
    for (const attachment of attachments) {
      log.info('attachment', 'decision', {
        decision: attachment.decision,
        kind: attachment.kind,
        hash: attachment.hash,
        size: attachment.size,
        sourceMessageId: attachment.sourceMessageId,
        reason: attachment.rejectionReason,
      });
    }
  }

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch
        .map((m) => replyQuoteTargetForMessage(m, mode))
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }
  return { attachments, batchIds, quoteTargets, quotes };
}

/** 指定模型 / 自动分级 for a batch: the scope's model pin, else the rating plan (if 自动分级 is on). */
function planBatchAutoEffort(
  deps: RunBatchDeps,
  input: { chatId: string; attachments: LocalAttachment[]; quotes: QuotedContext[] },
): { modelPin: ReturnType<NonNullable<Controls['modelPins']>['get']>; autoEffortPlan: AutoEffortPlan | undefined } {
  const { batch, controls, scope, mode } = deps;
  const { chatId, attachments, quotes } = input;
  // 自动分级: rate the message while the rest of the run is prepared; the
  // rung is settled once startRunFlow knows which conversation it resumes.
  const autoEffortSettings = deps.autoEfforts
    ? resolveAutoEffort(controls.profileConfig.preferences.autoEffort, controls.profileConfig.agentKind)
    : undefined;
  const chatEffortCap = effortPrefForChat(controls.profileConfig.preferences, chatId);
  // 指定模型: a topic pinned with `/model` keeps its model; it is not rated.
  const modelPin = controls.modelPins?.get(scope);
  if (modelPin) controls.modelPins?.touch(scope);
  const autoEffortPlan: AutoEffortPlan | undefined =
    autoEffortSettings && deps.autoEfforts && !modelPin
      ? startAutoEffort({
          settings: autoEffortSettings,
          store: deps.autoEfforts,
          scope,
          texts: batch.map((m) => m.content ?? ''),
          attachments: attachments.length,
          ...(quotes[0] ? { quoted: quotes[0].content } : {}),
          chatType: mode === 'p2p' ? 'p2p' : 'group',
          owner: isOwnerBatch(controls, batch, (m) => senderTypeOf(m) === 'bot'),
          ...(chatEffortCap ? { cap: chatEffortCap } : {}),
          classify: {
            cwd: join(deps.profileDir ?? tmpdir(), 'auto-effort-scratch'),
            // The account a run would get now: the rating bills the same one.
            env: () => (deps.profileDir ? (claudeAccountPool(deps.profileDir).pick()?.env ?? {}) : {}),
          },
          windowUsed: (kind) => {
            if (!deps.profileDir) return undefined;
            const pool = claudeAccountPool(deps.profileDir);
            const id = pool.pick()?.id;
            return id ? pool.windowUsed(id, kind) : undefined;
          },
          ...(deps.profileDir ? { bigCommands: () => claudeAccountPool(deps.profileDir!).scheduler.bigCommands } : {}),
        })
      : undefined;
  return { modelPin, autoEffortPlan };
}

/**
 * Everything the agent is told for a batch: the group / topic context around
 * it, the instructions (model switch, guest fence, edits, background work),
 * the knowledge block and the prompt itself — plus the decisions made on the
 * way (owner run, guard, workspace) that submitting the run needs.
 */
async function prepareBatchPrompt(
  deps: RunBatchDeps,
  input: {
    firstMsg: NormalizedMessage;
    chatId: string;
    threadId: string | undefined;
    attachments: LocalAttachment[];
    batchIds: Set<string>;
    quoteTargets: string[];
    quotes: QuotedContext[];
    modelPin: ReturnType<NonNullable<Controls['modelPins']>['get']>;
    autoEffortPlan: AutoEffortPlan | undefined;
  },
) {
  const {
    channel,
    executor,
    sessions,
    workspaces,
    batch,
    controls,
    lastRunModelByScope,
    backgroundOrigins,
    contextCursors,
    scope,
    mode,
    knowledge,
  } = deps;
  const { firstMsg, chatId, threadId, attachments, batchIds, quoteTargets, quotes, modelPin, autoEffortPlan } = input;
  // 群聊 / 话题上下文: Feishu only delivers the group messages that @ the bot,
  // so read back what was said around them — see chat-context.ts for which
  // slice each situation gets.
  const batchNewestMs = Math.max(...batch.map((m) => m.createTime || 0));
  const contextUntilMs = batchNewestMs > 0 ? batchNewestMs : Date.now();
  const contextPlan = planChatContext({
    mode,
    chatId,
    ...(threadId ? { threadId } : {}),
    cursorMs: contextCursors.get(scope),
    hasSession: Boolean(sessions.getRaw(scope)?.sessionId),
    untilMs: contextUntilMs,
    spawned: batch.some(isSpawnedTopic),
  });
  let chatContext: BridgePromptChatContext | undefined;
  if (contextPlan) {
    const fetched = await fetchChatContext(channel, contextPlan, {
      chatId,
      ownAppId: controls.profileConfig.accounts.app.id,
      excludeIds: new Set([...batchIds, ...quoteTargets]),
    });
    if (fetched.messages.length > 0) {
      chatContext = {
        scope: contextPlan.container === 'thread' ? 'topic' : firstMsg.chatType === 'p2p' ? 'p2p' : 'group',
        window: contextPlan.window,
        ...(fetched.truncated ? { truncated: true } : {}),
        messages: fetched.messages.map(toPromptContextMessage),
      };
    }
    log.info('chat-context', 'fetched', {
      scope,
      window: contextPlan.window,
      count: fetched.messages.length,
      truncated: fetched.truncated,
    });
  }

  // Detect a model switch since this scope's last run. When resuming an
  // existing conversation the transcript still claims the old model, so tell
  // the (now-switched) agent its model changed — otherwise it keeps echoing
  // the previously-announced model. Only fires when a prior model was seen
  // for this scope (never on the first run) and the selection actually
  // changed. `requestedModel` (the `--model` value, or undefined for default)
  // is reused below to log requested-vs-actual against the init event.
  const agentKind = controls.profileConfig.agentKind;
  const modelPref = modelPin?.model ?? controls.profileConfig.preferences.model;
  const modelSelection = normalizeModelSelection(agentKind, modelPref);
  const requestedModel = resolveModelArg(agentKind, modelPref);
  const prevModel = lastRunModelByScope.get(scope);
  const modelSwitched = prevModel !== undefined && prevModel !== modelSelection;
  lastRunModelByScope.set(scope, modelSelection);
  const smartSession = getSmartSession(controls.cfg);
  const editedIds = batch.filter(isEdited).map((m) => m.messageId);
  // This batch goes to a process still running background tasks for earlier
  // messages (RunExecutor reuses it): their reports may land in this turn.
  // Without such a process their entries are stale — that work is gone.
  let waitingOrigins: BackgroundOrigin[] = [];
  if (executor.hasLiveProcess(scope)) {
    waitingOrigins = backgroundOrigins.list(scope, new Set(batch.map((m) => m.messageId)));
  } else if (backgroundOrigins.take(scope).length > 0) {
    log.info('run', 'background-origins-dropped', { scope });
  }
  // Changes to the bridge and the agent itself are the owner's alone: other
  // people's runs are told so and fenced off at the tool level.
  const ownerRun = isOwnerBatch(controls, batch, (m) => senderTypeOf(m) === 'bot');
  // A restricted chat fences every run there, the owner's included; with
  // private chats open to everyone, someone else's private chat is fenced too.
  const restrictedChat =
    controls.profileConfig.access.restrictedChats?.[chatId] ??
    (firstMsg.chatType === 'p2p' && !ownerRun
      ? publicDmLimits(controls.profileConfig.access, batch, chatId)
      : undefined);
  // Someone else's run may only touch what the owner opened to others.
  const restrictedCwd = restrictedChat ? restrictedChatWorkspace(restrictedChat) : undefined;
  if (restrictedCwd) mkdirSync(restrictedCwd, { recursive: true });
  const guestWorkspace = restrictedCwd ?? workspaces.cwdFor(scope) ?? controls.profileConfig.workspaces.default;
  const guestGuard = ownerRun
    ? undefined
    : guestRunGuard(controls.profileConfig.access, {
        larkChannelHome: paths.appDir,
        grantedTools: grantedToolsFor(
          controls.profileConfig.access.guestToolGrants,
          batch,
          (m) => senderTypeOf(m) === 'bot',
        ),
        ...(guestWorkspace ? { workspace: guestWorkspace } : {}),
        chatId,
      });
  const runGuard = restrictedChat ? restrictedChatGuard(guestGuard, restrictedChat) : guestGuard;
  // A guest run is told where it may look, so it does not guess its way into refusals.
  const guestAccess = runGuard && guestGuard ? guestAccessInstruction(runGuard) : undefined;
  const instructions = [
    ...(restrictedChat ? [restrictedChatInstruction(restrictedChat)] : []),
    ...(guestAccess ? [guestAccess] : []),
    ...(autoEffortPlan?.forcedLabel
      ? [
          `消息开头的「/${autoEffortPlan.forcedLabel}」是给 bridge 的档位指令，本轮已按这个档位运行；` +
            '它不是请求内容，忽略它，按其余文字处理。',
        ]
      : []),
    ...(modelSwitched
      ? [
          `用户刚把本会话使用的模型切换为「${modelLabel(agentKind, modelPref)}」。` +
            '之前的对话里可能提到别的模型,请以当前模型为准;若被问到你用的是什么模型,据此回答。',
        ]
      : []),
    ...(smartSession ? [SMART_SESSION_INSTRUCTION] : []),
    ...(controls.botOwnerId && isOwnerNotifyChat(controls.cfg, chatId) ? [OWNER_BRIEF_INSTRUCTION] : []),
    // The final card's header bar shows only a title the agent gives (see card/title-marker).
    ...(getMessageReplyMode(controls.cfg) === 'final-card' ? [FINAL_CARD_TITLE_INSTRUCTION] : []),
    ...(editedIds.length > 0 ? [editInstruction(editedIds)] : []),
    ...(waitingOrigins.length > 0
      ? [backgroundTasksInstruction(waitingOrigins, executor.backgroundTasks(scope))]
      : []),
  ];
  const extraInstructions = instructions.length > 0 ? instructions : undefined;

  // Memory and the skill index are read fresh on every run: `/memory add` in
  // the middle of a conversation has to take effect on the next message, not
  // the next restart.
  // Only the owner's own private chat is shown the owner-only knowledge layer.
  const ownerPrivate = firstMsg.chatType === 'p2p' && isOwnerBatch(controls, batch, (m) => senderTypeOf(m) === 'bot');
  const knowledgeContext = knowledge
    ? await buildKnowledgeContext({
        store: knowledge,
        scopeId: scope,
        ownerPrivate,
        // Claude Code already lists its own skills: don't list them twice.
        ...nativeSkillOption(agentKind),
      }).catch((err: unknown) => {
        log.warn('knowledge', 'build-failed', { scope, err: String(err) });
        return undefined;
      })
    : undefined;
  // A resumed conversation that still holds this version of the block gets a
  // stub instead (decided once the run knows which conversation it resumes).
  const knowledgeSnapshot =
    knowledgeContext?.version && deps.knowledgeSnapshotDir
      ? await writeKnowledgeSnapshot(deps.knowledgeSnapshotDir, knowledgeContext)
      : undefined;
  const knowledgeDedupe = knowledgeContext?.version
    ? {
        version: knowledgeContext.version,
        full: promptSection('bridge_knowledge', knowledgeContext),
        stub: promptSection('bridge_knowledge', knowledgeStub(knowledgeContext.version, knowledgeSnapshot)),
        // The notes listed were put in front of the agent: the next days' index shows others first.
        ...(knowledge && knowledgeContext.notes?.length
          ? { onFull: () => knowledge.recordNoteExposure(listedNoteNames(knowledgeContext)) }
          : {}),
      }
    : undefined;
  // Notes matching what is asked now: a section of its own, so the index above keeps its version.
  const relevantNotes = knowledge
    ? await findRelevantNotes({
        store: knowledge,
        scopeId: scope,
        ownerPrivate,
        query: batch.map((m) => m.content).join('\n'),
      }).catch((err: unknown) => {
        log.warn('knowledge', 'relevance-failed', { scope, err: String(err) });
        return undefined;
      })
    : undefined;

  const prompt = buildPrompt(
    batch,
    attachments,
    quotes,
    chatContext,
    channel.botIdentity,
    extraInstructions,
    knowledgeContext,
    ownerRun,
    relevantNotes,
  );
  log.info('prompt', 'built', {
    promptChars: prompt.length,
    quotes: quotes.length,
    chatContext: chatContext?.messages.length ?? 0,
    ...(modelSwitched ? { modelSwitchedTo: modelSelection } : {}),
  });
  return {
    contextUntilMs,
    agentKind,
    modelPref,
    requestedModel,
    smartSession,
    waitingOrigins,
    ownerRun,
    restrictedCwd,
    runGuard,
    knowledgeDedupe,
    prompt,
  };
}

/**
 * Submit a batch's run and set up everything its reply needs: where it
 * replies, the session and run records, the idle watchdog, the reply mode
 * and render options, and the follow-up for background turns.
 * Undefined: the run was refused (the refusal has been sent).
 */
async function submitBatchRun(
  deps: RunBatchDeps,
  input: Pick<
    Parameters<typeof prepareBatchPrompt>[1],
    'firstMsg' | 'chatId' | 'threadId' | 'attachments' | 'quotes' | 'modelPin' | 'autoEffortPlan'
  > &
    Pick<
      Awaited<ReturnType<typeof prepareBatchPrompt>>,
      | 'contextUntilMs'
      | 'agentKind'
      | 'modelPref'
      | 'requestedModel'
      | 'smartSession'
      | 'ownerRun'
      | 'restrictedCwd'
      | 'runGuard'
      | 'knowledgeDedupe'
      | 'prompt'
    > & { lastMsg: NormalizedMessage; run: BatchRunState },
) {
  const {
    channel,
    executor,
    sessions,
    sessionCatalog,
    workspaces,
    batch,
    controls,
    callbackAuth,
    activePolicyFingerprints,
    pendingRotations,
    backgroundOrigins,
    contextCursors,
    scope,
    mode,
    runs,
    autoResumer,
  } = deps;
  const {
    firstMsg,
    lastMsg,
    chatId,
    threadId,
    attachments,
    quotes,
    modelPin,
    autoEffortPlan,
    run,
    contextUntilMs,
    agentKind,
    modelPref,
    requestedModel,
    smartSession,
    ownerRun,
    restrictedCwd,
    runGuard,
    knowledgeDedupe,
    prompt,
  } = input;
  // For topic groups: thread the reply so it lands in the same topic as the
  // user's message. Otherwise the SDK posts at top level and the user's
  // topic discussion breaks visually.
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...(mode === 'topic' && threadId ? { replyInThread: true } : {}),
  };
  log.info('flush', 'reply-target', {
    scope,
    mode,
    chatId,
    threadId,
    replyTo: sendOpts.replyTo,
    replyInThread: sendOpts.replyInThread === true,
  });

  const accessDecision =
    firstMsg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, firstMsg.senderId)
      : canUseGroup(controls.profileConfig, controls, firstMsg.chatId, firstMsg.senderId);
  const scopeContext: ScopeContext = {
    source: 'im',
    chatId,
    actorId: firstMsg.senderId,
    ...(threadId ? { threadId } : {}),
  };
  const capability = agentCapability(controls.profileConfig);
  // Agents that post the answer as its own reply (see AgentDescriptor.finalReply)
  // treat the progress stream as best-effort: its failures are logged, not fatal.
  const separateFinalReply = capability.descriptor.finalReply === 'separate';
  // With approvals on, a batch carrying anyone's words but an admin's is
  // gated: the agent may read freely, but each side-effecting step waits
  // for an admin.
  const requester = batch.find((m) => runNeedsApproval(controls.profileConfig, controls, m.senderId));
  const gate: GateContext | undefined = requester
    ? {
        actor: { id: requester.senderId, ...(requester.senderName ? { name: requester.senderName } : {}) },
        source: 'im',
        scopeId: scope,
        chatId,
        ...(threadId ? { threadId } : {}),
        originMessageId: lastMsg.messageId,
        where:
          mode === 'p2p'
            ? '私聊'
            : (controls.knownChats?.find((c) => c.id === chatId)?.name ?? '群聊'),
        agent: capability.agentId,
      }
    : undefined;
  // 会话智能压缩: an agent-requested close is consumed by this message either
  // way. Never rotate under a process this scope still keeps (its background
  // work would be cut off — and a fresh submit would reuse it anyway) or when
  // the user quotes an earlier message, which points back into the old context.
  const pendingRotation = pendingRotations.take(scope);
  const rotationBlocked = executor.hasLiveProcess(scope) || quotes.length > 0;
  // 长任务完成提醒 measures from here: queueing behind the concurrency cap is
  // waiting the requester does too.
  // Who started this turn and from where, for scripts the agent runs (the
  // device-command ledger): rewritten every batch, so a reused process reads
  // the current sender, not the one it was spawned for.
  const runContext: RunContext = {
    scope,
    chatId,
    mode: mode === 'p2p' ? 'p2p' : mode === 'topic' ? 'topic' : 'group',
    ...(threadId ? { threadId } : {}),
    ...(mode !== 'p2p' && controls.knownChats?.find((c) => c.id === chatId)?.name
      ? { chatName: controls.knownChats.find((c) => c.id === chatId)!.name }
      : {}),
    senders: [...new Map(batch.map((m) => [m.senderId, m])).values()].map((m) => ({
      openId: m.senderId,
      ...(m.senderName ? { name: m.senderName } : {}),
      ...(senderTypeOf(m) ? { type: senderTypeOf(m) } : {}),
    })),
    ownerRun,
    publicDm: mode === 'p2p' && !ownerRun && Boolean(controls.profileConfig.access.publicDm?.enabled),
    messageIds: batch.map((m) => m.messageId),
    updatedAt: new Date().toISOString(),
  };
  const runContextFile = writeRunContext(paths.appDir, runContext);
  // Alice entry: looked up after the turn starts, so it never delays the reply.
  if (runContextFile) entryTrackerFor(controls.profileConfig.access.entryTracking)?.tagTurn(runContext);
  const runSubmittedAt = Date.now();
  const flow = await startRunFlow({
    scopeId: scope,
    scope: scopeContext,
    prompt,
    attachments: attachments.map(toPolicyAttachment),
    access: accessDecision,
    capability,
    profileConfig: controls.profileConfig,
    sessions,
    sessionCatalog,
    workspaces,
    executor,
    now: Date.now(),
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
    ...(runGuard ? { guard: runGuard } : {}),
    ...(restrictedCwd ? { cwd: restrictedCwd } : {}),
    ...(runContextFile ? { runContextFile } : {}),
    ...(smartSession
      ? {
          compactWindowTokens: smartSession.compactWindowTokens,
          ...(rotationBlocked
            ? {}
            : {
                rotation: {
                  settings: smartSession,
                  ...(pendingRotation ? { pending: pendingRotation } : {}),
                  probe: (handle: string, cwd: string) => probeAgentSession(controls.profileConfig, handle, cwd),
                },
              }),
        }
      : {}),
    ...(firstMsg.senderName ? { actorName: firstMsg.senderName } : {}),
    ...(knowledgeDedupe ? { knowledge: knowledgeDedupe } : {}),
    ...(gate ? { gate } : {}),
    ...(modelPin
      ? { pickLevel: async () => ({ model: modelPin.model }) }
      : autoEffortPlan
      ? {
          pickLevel: async (resumeFrom: string | undefined) => {
            run.autoPicked = await autoEffortPlan.pick(resumeFrom, executor.hasLiveProcess(scope));
            return run.autoPicked
              ? {
                  model: run.autoPicked.model,
                  effort: run.autoPicked.effort,
                  ...(run.autoPicked.size ? { sizeHint: run.autoPicked.size } : {}),
                }
              : undefined;
          },
        }
      : {}),
    onBackgroundTurn: (turn) => run.deliverBackgroundTurn?.(turn) ?? Promise.resolve(),
    observability: {
      profile: controls.profile,
      agent: capability.agentId,
      source: 'im',
      stage: 'submit',
    },
  });
  if (!flow.ok) {
    log.info('run-flow', 'rejected', { scope, code: flow.rejectReason.code });
    log.warn('policy', 'denied', {
      scope,
      source: 'im',
      code: flow.rejectReason.code,
    });
    await channel.send(chatId, { markdown: flow.rejectReason.userVisible }, sendOpts);
    return undefined;
  }

  const { execution, cwdRealpath: cwd } = flow;
  // Written before the first token so a hard kill at any point after this
  // leaves a trace the next process can act on.
  const chatName = mode === 'p2p' ? undefined : controls.knownChats?.find(c => c.id === chatId)?.name;
  runs?.start({
    runId: execution.runId,
    scope,
    chatId,
    originMessageId: lastMsg.messageId,
    ...(threadId ? { threadId } : {}),
    promptPreview: mediaPlaceholders(lastMsg.content ?? ''),
    chatType: mode === 'p2p' ? 'p2p' : 'group',
    ...(chatName ? { chatName } : {}),
    actorId: firstMsg.senderId,
    ...(firstMsg.senderName ? { actorName: firstMsg.senderName } : {}),
    startedAt: Date.now(),
    // Only the owner's runs are picked up again unasked (task-ledger.ts).
    ...(ownerRun
      ? {
          resumeAs: {
            senderId: lastMsg.senderId,
            ...(lastMsg.senderName ? { senderName: lastMsg.senderName } : {}),
            chatType: resumeChatType(lastMsg, mode),
            locale: detectLocale(batch.map((m) => m.content)),
          },
        }
      : {}),
  });
  activePolicyFingerprints.set(scope, flow.policy.policyFingerprint);
  // The agent now holds everything up to this batch; the next run catches up
  // from here. p2p scopes never read it back, so they don't keep one.
  if (mode !== 'p2p') contextCursors.advance(scope, contextUntilMs);
  const handle = execution.handle;
  const supplementTarget = {
    originIds: new Set(batch.map((m) => m.messageId)),
    replyIds: new Set<string>(),
    initiators: new Set(batch.map((m) => m.senderId)),
  };
  handle.supplement = supplementTarget;
  if (deps.activeRuns && deps.recalled) {
    // Recalled while this batch was being prepared (context, pool slot).
    for (const outcome of settleEarlyRecalls(scope, handle, { activeRuns: deps.activeRuns, recalled: deps.recalled })) {
      log.info('recall', outcome.action, { scope, early: true });
    }
  }
  handle.onLedger = (ledger) => runs?.annotate(execution.runId, { ledger });
  const eventStream = execution.subscribe();
  if (flow.resumeFrom) {
    log.info('session', 'resume', { sessionId: flow.resumeFrom, cwd });
  } else {
    log.info('session', 'fresh', { cwd });
  }
  if (flow.rotated) {
    log.info('session', 'rotated', {
      scope,
      reason: flow.rotated.reason,
      ...(flow.rotated.idleMinutes !== undefined ? { idleMinutes: flow.rotated.idleMinutes } : {}),
      ...(flow.rotated.contextTokens !== undefined ? { contextTokens: flow.rotated.contextTokens } : {}),
    });
  }
  // The conversation this run lands in — what an `[[NEW_SESSION]]` at its end closes.
  const sessionHandleKey = capability.descriptor.sessionHandle;
  run.conversationHandle = flow.resumeFrom;
  const recordSession = (evt: AgentEvent): void => {
    if (evt.type === 'system' && evt[sessionHandleKey]) run.conversationHandle = evt[sessionHandleKey];
    recordRunSessionEvent({
      scopeId: scope,
      sessions,
      sessionCatalog,
      capability,
      policy: flow.policy,
      event: evt,
    });
    if (evt.type === 'system' && evt.sessionId) {
      log.info('session', 'set', { sessionId: evt.sessionId });
    }
    if (evt.type === 'usage' && cardRenderOptions.meta) {
      cardRenderOptions.meta.usage = usageLineOf([evt]);
    }
    // Ground truth for "which model is actually running": claude reports the
    // model it loaded in its init event. Logging requested-vs-actual reveals
    // whether the --model pin took effect or claude silently fell back (e.g.
    // an id this claude build/account doesn't recognize).
    if (evt.type === 'system' && evt.model) {
      log.info('session', 'model', {
        requested: run.autoPicked?.model ?? requestedModel ?? 'default',
        actual: evt.model,
      });
      // Same ground truth for the reader: the byline shows the concrete model
      // (e.g. Opus 5.5) instead of only the "always latest" alias picked in /config.
      if (cardRenderOptions.meta) {
        cardRenderOptions.meta.model = resolvedModelLabel(agentKind, run.autoPicked?.model ?? modelPref, evt.model);
      }
    }
    if (evt.type === 'system' && evt.threadId) {
      log.info('session', 'set-thread', { threadId: evt.threadId });
    }
  };

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences). 0 / undefined = no watchdog.
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }

  const replyMode = getMessageReplyMode(controls.cfg);
  log.info('flush', 'reply-mode', { mode: replyMode });
  const cotMessages = getCotMessages(controls.cfg);
  const cotEnabled = cotMessages !== 'off';

  // Re-read prefs on every flush so toggling /config mid-stream takes
  // effect immediately. Cheap object lookups, no allocation when on.
  // The thinking panel is process detail too, so it follows `showToolCalls`:
  // someone who turned tool calls off wants the answer, not the reasoning that
  // led to it. Only card mode renders it — `renderText` never did.
  // Marker-only answers ([[NO_REPLY]]) are stripped first, for every pref
  // combination: the run already delivered its result (e.g. a skill-posted card).
  // A task the plan quota stops is resumed by the bridge once the quota resets
  // (see AutoResumer) — unless resuming already failed MAX_AUTO_RESUMES times
  // in a row. The paused card says which of the two will happen.
  const resumedRun = batch.some((m) => m.rawContentType === AUTO_RESUME_CONTENT_TYPE);
  const resumeAttempt = autoResumer?.nextAttempt(scope, resumedRun) ?? 1;
  const canAutoResume = Boolean(autoResumer) && resumeAttempt <= MAX_AUTO_RESUMES;
  const withAutoResume = (state: RunState): RunState =>
    canAutoResume && state.terminal === 'paused' && state.limit
      ? { ...state, limit: { ...state.limit, autoResumeAt: resumeAtFor(state.limit) } }
      : state;
  // The bridge's own words on the reply follow the caller's language, the
  // same rule the agent gets for its answer (see detectLocale).
  const locale = detectLocale(batch.map((m) => m.content));
  const filterForPrefs = (raw: RunState): RunState => {
    run.lastRawState = raw;
    // Group members can't open the owner's ledger path: hide the line there.
    const shown = mode === 'p2p' ? raw : withoutLedgerLines(raw);
    // English progress notes in a Chinese conversation: hidden, see the helper.
    const state = withAutoResume(stripControlMarkers(withoutOffLocaleProgress(shown, locale)));
    if (getShowToolCalls(controls.cfg)) return state;
    return {
      ...state,
      blocks: state.blocks.filter((b) => b.kind !== 'tool'),
      reasoning: { content: '', active: false },
    };
  };
  const cardRenderOptions: RunCardRenderOptions = {
    locale,
    meta: {
      title: channel.botIdentity?.name ?? controls.profile,
      agent: capability.agentId,
      model: modelLabel(agentKind, run.autoPicked?.model ?? modelPref),
      effort: run.autoPicked
        ? autoEffortByline(run.autoPicked)
        : pinnedByline(resolveEffortArg(agentKind, effortPrefForChat(controls.profileConfig.preferences, chatId)), Boolean(modelPin)),
      provider: capability.descriptor.provider,
      ...(flow.rotated ? { notice: rotationNotice(flow.rotated) } : {}),
    },
    ...(callbackAuth
      ? {
          signCallback: (action: string) =>
            callbackAuth.sign({
              runId: execution.runId,
              scope,
              chatId,
              operatorOpenId: operatorForAction(action, firstMsg.senderId),
              action,
              policyFingerprint: flow.policy.policyFingerprint,
              ttlMs: 24 * 60 * 60 * 1000,
            }),
        }
      : {}),
  };
  // The byline only shows on the final card, long after this lookup settles,
  // so resolve the paying account in the background instead of delaying the run.
  fireAndForget(
    agentAccountName(controls.profileConfig).then((sponsor) => {
      if (cardRenderOptions.meta) cardRenderOptions.meta.sponsor = sponsor;
    }),
    'card',
    { step: 'sponsor', scope },
  );

  // This run's message, as a place results can be pointed to.
  const here: ResultLocation = {
    messageId: lastMsg.messageId,
    preview: messagePreview(mediaPlaceholders(lastMsg.content ?? '')),
    sentAt: lastMsg.createTime || runSubmittedAt,
  };
  // Close out the messages waiting on this process's background work, now
  // that it is over (see BackgroundOrigins).
  const settleWaiting = (outcome: 'done' | 'stopped'): Promise<void> => {
    const origins = backgroundOrigins.take(scope);
    if (origins.length === 0) return Promise.resolve();
    return settleBackgroundOrigins({
      channel,
      scope,
      origins,
      outcome,
      where: here,
      // An owner-notify chat already got its @ with the result.
      longRunNoticeMs: ownerNotifyTarget(controls, chatId) ? undefined : getLongRunNoticeMs(controls.cfg),
    });
  };
  // Turns the agent runs on its own after this reply (a background task it
  // started reported back) go out as a follow-up reply to the same message.
  run.deliverBackgroundTurn = async (turn) => {
    const state = backgroundTurnState(turn, filterForPrefs, {
      finalAnswerOnly: !separateFinalReply && answerOnlyReply(replyMode, controls.cfg),
    });
    if (state) {
      // The follow-up's byline reports the background turn's own consumption.
      const usage = turn.kind === 'turn' ? usageLineOf(turn.events) : undefined;
      // Nor does it repeat the run's 「本轮从新会话开始」: that was about the run.
      const { notice: _runNotice, ...meta } = cardRenderOptions.meta ?? { title: '' };
      await sendFinalReply({
        channel,
        chatId,
        scope,
        state: separateFinalReply ? finalAnswerOnlyState(state) : state,
        replyMode,
        sendOpts,
        cardRenderOptions: cardRenderOptions.meta
          ? { ...cardRenderOptions, meta: { ...meta, usage } }
          : cardRenderOptions,
        finalCard: getFinalCardPreference(controls.cfg),
      });
    }
    // 会话智能压缩: the turn that ends the background work may close the
    // conversation — the run's own answer could not while work was pending.
    if (smartSession && turn.kind === 'turn' && turn.background === 0) {
      const turnAnswer = answerTextOf(finalizeIfRunning(turn.events.reduce(reduce, initialState)));
      const request = newSessionRequest(stripBriefMarker(turnAnswer ?? ''));
      if (request) {
        pendingRotations.set(scope, { ...request, ...(run.conversationHandle ? { handle: run.conversationHandle } : {}) });
        log.info('session', 'rotation-requested', { scope, hasSummary: Boolean(request.summary), via: 'background-turn' });
      }
    }
    if (turn.kind === 'turn' && turn.background > 0) return;
    // The work is over: this message's follow-up holds the result; any other
    // message still waiting on it is pointed here.
    run.backgroundSettled = true;
    // 结果提醒主人: the result only now exists, so the owner's @ goes out here.
    const ownerNotifyId = ownerNotifyTarget(controls, chatId);
    if (ownerNotifyId && turn.kind === 'turn' && !run.ownerNotified) {
      run.ownerNotified = true;
      const notice = planOwnerNotice({
        ownerId: ownerNotifyId,
        terminal: 'done',
        answerText: answerTextOf(finalizeIfRunning(turn.events.reduce(reduce, initialState))),
        requesters: humanRequesters(deps.batch),
      });
      if (notice) await sendLongRunNotice(channel, chatId, notice, sendOpts, scope);
    }
    await settleWaiting(turn.kind === 'stopped' ? 'stopped' : 'done');
  };
  return {
    sendOpts,
    separateFinalReply,
    runSubmittedAt,
    execution,
    handle,
    supplementTarget,
    eventStream,
    recordSession,
    idleTimeoutMs,
    replyMode,
    cotMessages,
    cotEnabled,
    resumeAttempt,
    canAutoResume,
    locale,
    filterForPrefs,
    cardRenderOptions,
    here,
    settleWaiting,
  };
}

/**
 * Stream a submitted run's events and deliver its reply in the configured
 * reply mode (CoT bubble, progress card, streamed markdown or plain text),
 * recording how the run ended on `run`.
 */
async function deliverRunReply(
  deps: RunBatchDeps,
  input: { chatId: string; lastMsg: NormalizedMessage; run: BatchRunState } & Pick<
    NonNullable<Awaited<ReturnType<typeof submitBatchRun>>>,
    | 'execution'
    | 'handle'
    | 'eventStream'
    | 'idleTimeoutMs'
    | 'recordSession'
    | 'sendOpts'
    | 'replyMode'
    | 'cotMessages'
    | 'cotEnabled'
    | 'separateFinalReply'
    | 'supplementTarget'
    | 'locale'
    | 'filterForPrefs'
    | 'cardRenderOptions'
  >,
): Promise<void> {
  const { channel, cotClient, scope } = deps;
  const {
    chatId,
    lastMsg,
    run,
    execution,
    handle,
    eventStream,
    idleTimeoutMs,
    recordSession,
    sendOpts,
    replyMode,
    cotMessages,
    cotEnabled,
    separateFinalReply,
    supplementTarget,
    locale,
    filterForPrefs,
    cardRenderOptions,
  } = input;
  if (cotEnabled) {
    const cotPublisher = new CotPublisher({
      client: cotClient,
      chatId,
      // The CoT bubble follows this origin message's thread. In a topic the
      // triggering message is itself in-topic, so the bubble lands in the
      // topic; message_cot has no thread_id receive type, so origin is the
      // only lever we have (see CotClient.create).
      originMessageId: lastMsg.messageId,
      runId: execution.runId,
      scope,
      inputPreview: lastMsg.content,
    });
    await cotPublisher.start();
    if (!cotPublisher.disabled) {
      const cotDone = consumeCotEvents(execution.subscribe(), cotPublisher, {
        detail: cotMessages,
      });
      const finalState = await processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async () => {},
      );
      await cotDone;
      run.runTerminal = finalState.terminal;
      run.runLimit = finalState.limit;
      run.runError = finalState.errorMsg;
      if (cotPublisher.degradedReason) {
        await sendCotDegradedNotice({
          channel,
          chatId,
          scope,
          sendOpts,
          reason: cotPublisher.degradedReason,
        });
      }
      run.answerIsNewMessage = true;
      // The bubble showed the work, notes between tool calls included; the
      // reply carries the answer the run ends on. Cut before stripping
      // markers so a [[NO_REPLY]] answer stays the answer (see finalAnswerState).
      await sendFinalReply({
        channel,
        chatId,
        scope,
        state: stripControlMarkers(finalAnswerState((run.lastRawState = finalState))),
        replyMode,
        sendOpts,
        cardRenderOptions,
        finalCard: getFinalCardPreference(deps.controls.cfg),
      });
      return;
    }
    log.warn('cot', 'fallback-existing-reply', { reason: 'create-disabled' });
  }

  if (replyMode === 'card') {
    let latestState: RunState = initialState;
    let producerStarted = false;
    let cardCtrl:
      | { update(next: object | ((current: object) => object)): Promise<void>; readonly messageId?: string }
      | undefined;
    let cardMessageId: string | undefined;
    // Whether the last card rendered had to cut the answer to fit.
    let cardTrimmed = false;
    let lastLiveCard: object | undefined;
    const cardHealth = new CardPatchHealth((code) => {
      void channel
        .send(chatId, { markdown: runStrings(locale).cardBroken(String(code ?? '?')) }, sendOpts)
        .catch((err) => log.fail('stream', err, { step: 'card-broken-notice' }));
    });
    // The card as the user should see it now: live clock while running,
    // shrunk to fit Feishu's size limit (see fitCardToBudget).
    const renderLiveCard = (state: RunState): object => {
      const running = state.terminal === 'running';
      const options: RunCardRenderOptions = running
        ? { ...cardRenderOptions, activity: runActivity(handle, state, locale) }
        : cardRenderOptions;
      const fitted = fitCardToBudget(
        filterForPrefs(state),
        (s) => renderCard(s, options),
        undefined,
        locale,
      );
      cardTrimmed = fitted.trimmed;
      lastLiveCard = fitted.card;
      return fitted.card;
    };
    const cardProducer = async (ctrl: NonNullable<typeof cardCtrl> & { readonly messageId: string }): Promise<void> => {
      producerStarted = true;
      if (progress.abandoned()) return;
      cardCtrl = ctrl;
      cardMessageId = ctrl.messageId;
      instrumentCardPatches(ctrl, cardHealth);
      supplementTarget.replyIds.add(ctrl.messageId);
      await ctrl.update(renderLiveCard(latestState));
      await renderDone;
    };
    const progress = createLazyProgressStream(scope, replyMode, () => {
      const initial = renderCard(initialState, cardRenderOptions);
      // A topic opened for this message: its first post is already this card, waiting to be taken over.
      const opener = takeTopicOpener(scope);
      if (opener) {
        log.info('topic-prefix', 'opener-adopted', { scope, msgId: opener.messageId });
        // Left empty, it goes back to the notice rather than being recalled: it opened the topic.
        return adoptCardStream(channel, opener.messageId, initial, cardProducer).then((r) => ({
          ...r,
          emptyCard: topicOpenedNoticeCard(opener),
        }));
      }
      return channel.stream(chatId, { card: { initial, producer: cardProducer } }, sendOpts);
    });
    const renderDone = processAgentStream(
      handle,
      eventStream,
      scope,
      idleTimeoutMs,
      recordSession,
      async (state) => {
        latestState = state;
        if (shouldOpenProgressStream(filterForPrefs(state))) progress.ensureOpen();
        if (cardCtrl) {
          await cardCtrl.update(renderLiveCard(state));
        }
      },
    );
    if (opensProgressEagerly(separateFinalReply)) progress.ensureOpen();
    // Keep the clock ticking while the agent is quiet. Only touches a card
    // that is still running, so it can never overwrite the final one.
    // Set once the stream's failed final update was rescued: that already
    // re-sent the answer, so the card-broken delivery below must not repeat it.
    let rescued = false;
    // The card's last update was rejected for good: point the card at the
    // answer and post the answer as messages. Runs at most once — at the end
    // of the run, or later when the final update outlived the grace window.
    let cardBrokenHandled = false;
    const deliverIfCardBroken = async (): Promise<boolean> => {
      if (cardBrokenHandled || rescued || !cardHealth.lastFailed) return false;
      cardBrokenHandled = true;
      await deliverAnswerOutsideCard({
        channel,
        chatId,
        scope,
        sendOpts,
        reason: 'card-broken',
        state: filterForPrefs(latestState),
        ...(cardMessageId
          ? {
              messageId: cardMessageId,
              pointerCard: renderCard(
                pointerState(latestState, cardHealth.lastErrorCode, locale),
                cardRenderOptions,
              ),
            }
          : {}),
      });
      return true;
    };
    const heartbeat = setInterval(() => {
      if (cardCtrl && latestState.terminal === 'running') {
        fireAndForget(cardCtrl.update(renderLiveCard(latestState)), 'card', { step: 'heartbeat', scope });
      }
    }, CARD_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      await awaitRenderAwareStream({
        mode: replyMode,
        progress,
        renderDone,
        producerStarted: () => producerStarted,
        fallback: async (state) => {
          if (separateFinalReply) return;
          if (renderText(filterForPrefs(state)).trim() === '') return;
          const fitted = fitCardToBudget(
            filterForPrefs(state),
            (s) => renderCard(s, cardRenderOptions),
            undefined,
            locale,
          );
          await channel.send(chatId, { card: fitted.card }, sendOpts);
          if (fitted.trimmed) {
            await deliverAnswerOutsideCard({
              channel,
              chatId,
              scope,
              sendOpts,
              reason: 'too-long',
              state: filterForPrefs(state),
            });
          }
        },
        rescue: separateFinalReply
          ? undefined
          : (state) => {
              rescued = true;
              return rescueCardReply({
                channel,
                chatId,
                scope,
                sendOpts,
                cardRenderOptions,
                streamedMessageId: cardCtrl?.messageId,
                state: filterForPrefs(state),
              });
            },
        lateStreamEnd: separateFinalReply ? undefined : () => deliverIfCardBroken().then(() => {}),
      });
    } catch (err) {
      if (!separateFinalReply) throw err;
      log.fail('stream', err, { mode: replyMode, step: 'progress-stream' });
    } finally {
      clearInterval(heartbeat);
    }
    await recallIfEmptyStreamedReply(channel, progress, filterForPrefs(latestState), scope);
    if (separateFinalReply) {
      run.answerIsNewMessage = true;
      await sendFinalReply({
        channel,
        chatId,
        scope,
        state: finalReplyState(progress, filterForPrefs(latestState)),
        replyMode,
        sendOpts,
        cardRenderOptions,
      });
    } else if (progress.opened() && !progress.abandoned()) {
      // The card is the reply. If it doesn't hold the whole answer — its
      // last update was rejected, or the answer outgrew it — post the
      // answer as ordinary messages so it is never lost.
      if (await deliverIfCardBroken()) {
        // Already posted outside the card.
      } else if (cardTrimmed) {
        await deliverAnswerOutsideCard({
          channel,
          chatId,
          scope,
          sendOpts,
          reason: 'too-long',
          state: filterForPrefs(latestState),
        });
      } else {
        // Code on a card can't be copied: an answer holding some moves to a
        // rich-text message below the card (see deliverCodeNatively). After a
        // rescue the card holds a reduced render, so only the code follows.
        const messageId = rescued ? undefined : cardMessageId;
        const sent = await deliverCodeNatively({
          channel,
          chatId,
          scope,
          sendOpts,
          locale,
          state: filterForPrefs(latestState),
          ...(messageId
            ? { updateCard: (state: RunState) => channel.updateCard(messageId, renderCard(state, cardRenderOptions)) }
            : {}),
        });
        if (sent !== 'none') run.answerIsNewMessage = true;
      }
    }
    run.runTerminal = latestState.terminal;
    run.runLimit = latestState.limit;
    run.runError = latestState.errorMsg;
    if (run.runTerminal === 'paused' && cardMessageId && lastLiveCard) {
      run.pausedCard = { messageId: cardMessageId, card: lastLiveCard };
    }
  } else if (replyMode === 'markdown') {
    let latestState: RunState = initialState;
    let producerStarted = false;
    let markdownCtrl: { setContent(markdown: string): Promise<void> } | undefined;
    const progress = createLazyProgressStream(scope, replyMode, () =>
      channel.stream(
        chatId,
        {
          markdown: async (ctrl) => {
            producerStarted = true;
            if (progress.abandoned()) return;
            markdownCtrl = ctrl;
            supplementTarget.replyIds.add(ctrl.messageId);
            await ctrl.setContent(renderText(filterForPrefs(latestState), locale));
            await renderDone;
          },
        },
        sendOpts,
      ),
    );
    const renderDone = processAgentStream(
      handle,
      eventStream,
      scope,
      idleTimeoutMs,
      recordSession,
      async (state) => {
        latestState = state;
        if (shouldOpenProgressStream(filterForPrefs(state))) progress.ensureOpen();
        if (markdownCtrl) {
          await markdownCtrl.setContent(renderText(filterForPrefs(state), locale));
        }
      },
    );
    if (opensProgressEagerly(separateFinalReply)) progress.ensureOpen();
    try {
      await awaitRenderAwareStream({
        mode: replyMode,
        progress,
        renderDone,
        producerStarted: () => producerStarted,
        fallback: async (state) => {
          if (separateFinalReply) return;
          const body = renderText(filterForPrefs(state), locale);
          if (body.trim()) {
            await channel.send(chatId, { markdown: body }, sendOpts);
          }
        },
        rescue: separateFinalReply
          ? undefined
          : async (state) => {
              const body = renderText(finalAnswerOnlyState(filterForPrefs(state)));
              if (!body.trim()) return;
              const result = await channel.send(chatId, { markdown: body }, sendOpts);
              requireMessageReceipt(result, 'markdown');
              log.info('outbound', 'rescue-sent', { scope, via: 'markdown', messageId: result.messageId });
            },
      });
    } catch (err) {
      if (!separateFinalReply) throw err;
      log.fail('stream', err, { mode: replyMode, step: 'progress-stream' });
    }
    await recallIfEmptyStreamedReply(channel, progress, filterForPrefs(latestState), scope);
    if (separateFinalReply) {
      run.answerIsNewMessage = true;
      await sendFinalReply({
        channel,
        chatId,
        scope,
        state: finalReplyState(progress, filterForPrefs(latestState)),
        replyMode,
        sendOpts,
        cardRenderOptions,
      });
    }
    run.runTerminal = latestState.terminal;
    run.runLimit = latestState.limit;
    run.runError = latestState.errorMsg;
  } else {
    // text / final-card mode: drain the agent stream without sending anything
    // during the run, then post the answer once — as a plain markdown
    // (msg_type=post) message, or as one clean card. No streaming either way.
    const finalState = await processAgentStream(
      handle,
      eventStream,
      scope,
      idleTimeoutMs,
      recordSession,
      async () => {},
    );
    run.answerIsNewMessage = true;
    // Only the answer the run ends on goes out (`final-card`, or text with
    // `textReplyFinalOnly`). The cut comes before filterForPrefs, which drops
    // the tool blocks it is made at and a [[NO_REPLY]] answer (see finalAnswerState).
    const state = separateFinalReply
      ? finalAnswerOnlyState(filterForPrefs(finalState))
      : answerOnlyReply(replyMode, deps.controls.cfg)
        ? filterForPrefs(finalAnswerState(finalState))
        : filterForPrefs(finalState);
    // filterForPrefs records what it was given; the raw state is the whole run.
    run.lastRawState = finalState;
    await sendFinalReply({
      channel,
      chatId,
      scope,
      state,
      replyMode,
      sendOpts,
      cardRenderOptions,
      finalCard: getFinalCardPreference(deps.controls.cfg),
    });
    run.runTerminal = finalState.terminal;
    run.runLimit = finalState.limit;
    run.runError = finalState.errorMsg;
  }
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const { channel, batch, controls } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;

  if (await stopForBotOverload(deps, { chatId, threadId, lastMsg })) return;

  // The "Typing" reaction goes on as soon as the batch is taken: before the
  // inputs, the prompt and the rung are settled (seconds, at times), so the
  // sender sees the message was noticed. COT mode posts its own bubble instead.
  const earlyReaction =
    getCotMessages(controls.cfg) === 'off' ? addWorkingReaction(channel, lastMsg.messageId) : undefined;
  const taken = { firstMsg, lastMsg, chatId, threadId, earlyReaction, handedOver: false };
  try {
    await runTakenBatch(deps, taken);
  } catch (err) {
    if (!taken.handedOver) scheduleWorkingReactionCleanup(channel, lastMsg.messageId, earlyReaction);
    throw err;
  }
}

async function runTakenBatch(
  deps: RunBatchDeps,
  taken: {
    firstMsg: NormalizedMessage;
    lastMsg: NormalizedMessage;
    chatId: string;
    threadId: string | undefined;
    earlyReaction: Promise<string | undefined> | undefined;
    /** Set once the run owns the reaction (it clears it when the run ends). */
    handedOver: boolean;
  },
): Promise<void> {
  const {
    channel,
    batch,
    controls,
    activePolicyFingerprints,
    pendingRotations,
    backgroundOrigins,
    scope,
    mode,
    runs,
    autoResumer,
  } = deps;
  const { firstMsg, lastMsg, chatId, threadId, earlyReaction } = taken;
  const { attachments, batchIds, quoteTargets, quotes } = await resolveBatchInputs(deps);

  const { modelPin, autoEffortPlan } = planBatchAutoEffort(deps, { chatId, attachments, quotes });
  const run: BatchRunState = { backgroundSettled: false, answerIsNewMessage: false };

  const {
    contextUntilMs,
    agentKind,
    modelPref,
    requestedModel,
    smartSession,
    waitingOrigins,
    ownerRun,
    restrictedCwd,
    runGuard,
    knowledgeDedupe,
    prompt,
  } = await prepareBatchPrompt(deps, {
    firstMsg,
    chatId,
    threadId,
    attachments,
    batchIds,
    quoteTargets,
    quotes,
    modelPin,
    autoEffortPlan,
  });

  const started = await submitBatchRun(deps, {
    firstMsg,
    lastMsg,
    chatId,
    threadId,
    attachments,
    quotes,
    modelPin,
    autoEffortPlan,
    run,
    contextUntilMs,
    agentKind,
    modelPref,
    requestedModel,
    smartSession,
    ownerRun,
    restrictedCwd,
    runGuard,
    knowledgeDedupe,
    prompt,
  });
  if (!started) {
    scheduleWorkingReactionCleanup(channel, lastMsg.messageId, earlyReaction);
    return;
  }
  taken.handedOver = true;
  const {
    sendOpts,
    separateFinalReply,
    runSubmittedAt,
    execution,
    handle,
    supplementTarget,
    eventStream,
    recordSession,
    idleTimeoutMs,
    replyMode,
    cotMessages,
    cotEnabled,
    resumeAttempt,
    canAutoResume,
    locale,
    filterForPrefs,
    cardRenderOptions,
    here,
    settleWaiting,
  } = started;

  // Add a "Typing" reaction to the triggering message as an instant ack that
  // the bot noticed it, never letting that outbound API call block agent
  // event draining. Card mode's own footer ("🧠 正在思考…") already gives this
  // feedback *inside* the card, but the reaction is what shows up in the bare
  // chat message list — useful when scrolling back, or for onlookers who
  // haven't opened the card. COT mode posts its own separate bubble, so it
  // stays excluded.
  let reactionPromise = earlyReaction;
  if (cotEnabled && reactionPromise) {
    // COT was switched on while the run was being prepared.
    scheduleWorkingReactionCleanup(channel, lastMsg.messageId, reactionPromise);
    reactionPromise = undefined;
  } else if (!cotEnabled && !reactionPromise) {
    reactionPromise = addWorkingReaction(channel, lastMsg.messageId);
  }

  // Only the progress card can take over a topic's opener card; any other reply leaves it the notice it stands for.
  if (cotEnabled || replyMode !== 'card') await releaseTopicOpener(channel, scope);

  try {
    await deliverRunReply(deps, {
      chatId,
      lastMsg,
      run,
      execution,
      handle,
      eventStream,
      idleTimeoutMs,
      recordSession,
      sendOpts,
      replyMode,
      cotMessages,
      cotEnabled,
      separateFinalReply,
      supplementTarget,
      locale,
      filterForPrefs,
      cardRenderOptions,
    });
  } catch (err) {
    log.fail('stream', err);
  } finally {
    runs?.finish(execution.runId);
    activePolicyFingerprints.delete(scope);
    autoEffortPlan?.finish({
      ...(run.conversationHandle ? { handle: run.conversationHandle } : {}),
      ...(run.runTerminal ? { terminal: run.runTerminal } : {}),
      durationMs: Date.now() - runSubmittedAt,
    });
    scheduleWorkingReactionCleanup(channel, lastMsg.messageId, reactionPromise);
    // Answered, but background tasks the agent started still run: the task
    // isn't over, so 「完成」 (reaction, long-run notice) waits for the
    // background turn that ends them — see deliverBackgroundTurn.
    const background = run.backgroundSettled ? 0 : backgroundLeft(run.lastRawState);
    if (run.runTerminal === 'done' && background > 0) {
      backgroundOrigins.add(scope, {
        messageId: lastMsg.messageId,
        chatId,
        replyInThread: Boolean(sendOpts.replyInThread),
        preview: here.preview,
        sentAt: here.sentAt,
        submittedAt: runSubmittedAt,
        p2p: mode === 'p2p',
        requesters: humanRequesters(batch),
      });
      log.info('run', 'done-deferred', { scope, background });
    } else if (run.runTerminal === 'done' && waitingOrigins.length > 0) {
      // This turn ran in the process earlier messages' background work lived
      // in, and that work is over now — its reports were folded into this
      // turn (or it was stopped here): point those messages at this reply.
      void settleWaiting('done');
    }
    if (run.runTerminal === 'done' && background === 0) void addDoneReaction(channel, lastMsg.messageId);
    if (autoResumer) {
      if (run.runTerminal === 'paused' && run.runLimit && canAutoResume) {
        void autoResumer.schedule({
          scope,
          chatId,
          // Same rule as intake's access check: the message's own chat type.
          chatType: lastMsg.chatType === 'p2p' ? 'p2p' : mode === 'topic' ? 'topic' : 'group',
          ...(threadId ? { threadId } : {}),
          senderId: lastMsg.senderId,
          ...(lastMsg.senderName ? { senderName: lastMsg.senderName } : {}),
          originMessageId: lastMsg.messageId,
          ...(run.pausedCard ? { cardMessageId: run.pausedCard.messageId, card: run.pausedCard.card } : {}),
          resumeAt: resumeAtFor(run.runLimit),
          ...(run.runLimit.limitType ? { limitType: run.runLimit.limitType } : {}),
          locale,
          attempt: resumeAttempt,
          createdAt: Date.now(),
        });
      } else if (run.runTerminal === 'paused') {
        log.warn('auto-resume', 'gave-up', { scope, attempts: resumeAttempt - 1 });
      } else if (run.runTerminal === 'done') {
        // A run that got through means the quota is back and someone is
        // steering this chat again; resuming on top of that would repeat work.
        void autoResumer.cancel(scope, 'run-completed');
      }
      // Killed from outside (or cut by a shutdown) halfway through a task that
      // keeps a ledger: pick it up again from the ledger, the owner's only.
      const killed = run.runTerminal === 'error' && isKilledExit(run.runError);
      const shutdown = run.runTerminal === 'interrupted' && handle.stopCause === 'shutdown';
      if (ownerRun && handle.ledger && (killed || shutdown)) {
        if (resumeAttempt > MAX_INTERRUPT_RESUMES) {
          log.warn('auto-resume', 'interrupt-gave-up', { scope, attempts: resumeAttempt - 1 });
        } else {
          const resumeAt = Date.now() + INTERRUPT_RESUME_DELAY_MS;
          const reason = killed ? 'killed' : 'shutdown';
          void autoResumer.schedule({
            scope,
            chatId,
            chatType: resumeChatType(lastMsg, mode),
            ...(threadId ? { threadId } : {}),
            senderId: lastMsg.senderId,
            ...(lastMsg.senderName ? { senderName: lastMsg.senderName } : {}),
            originMessageId: lastMsg.messageId,
            resumeAt,
            locale,
            kind: 'interrupted',
            ledger: handle.ledger,
            reason,
            attempt: resumeAttempt,
            createdAt: Date.now(),
          });
          if (killed) {
            const t = runStrings(locale);
            void channel
              .send(chatId, { markdown: t.interruptedWillResume(t.interruptReasons[reason], formatMoment(resumeAt)) }, sendOpts)
              .catch((err) => log.fail('auto-resume', err, { step: 'interrupt-notice' }));
          }
        }
      }
    }
    // 结果提醒主人: in the chats the owner reads results in, every finished
    // run @-mentions the owner with a one-line brief (instead of the long-run
    // notice). Work still running in the background reports when it ends.
    const ownerNotifyId = ownerNotifyTarget(controls, chatId);
    if (ownerNotifyId && !run.ownerNotified && !(run.runTerminal === 'done' && background > 0)) {
      run.ownerNotified = true;
      const notice = planOwnerNotice({
        ownerId: ownerNotifyId,
        terminal: run.runTerminal,
        answerText: answerTextOf(run.lastRawState),
        ...(run.runError ? { error: run.runError } : {}),
        requesters: humanRequesters(batch),
      });
      if (notice) void sendLongRunNotice(channel, chatId, notice, sendOpts, scope);
    }
    const longRunNotice = ownerNotifyId || (run.runTerminal === 'done' && background > 0) ? undefined : planLongRunNotice({
      thresholdMs: getLongRunNoticeMs(controls.cfg),
      elapsedMs: Date.now() - runSubmittedAt,
      terminal: run.runTerminal,
      p2p: mode === 'p2p',
      answerIsNewMessage: run.answerIsNewMessage,
      requesters: humanRequesters(batch),
    });
    if (longRunNotice) void sendLongRunNotice(channel, chatId, longRunNotice, sendOpts, scope);
    if (smartSession && run.runTerminal === 'done') {
      const request = newSessionRequest(stripBriefMarker(answerTextOf(run.lastRawState) ?? ''));
      if (request && background > 0) {
        // Work still running isn't a finished task: closing the conversation
        // now would cut it off from its own results.
        log.info('session', 'rotation-request-ignored', { scope, background });
      } else if (request) {
        pendingRotations.set(scope, { ...request, ...(run.conversationHandle ? { handle: run.conversationHandle } : {}) });
        log.info('session', 'rotation-requested', { scope, hasSummary: Boolean(request.summary) });
      }
    }
  }
}

/** The owner to @ at the end of runs in `chatId`, when it is an owner-notify chat (see `ownerNotifyChats`). */
function ownerNotifyTarget(controls: Controls, chatId: string): string | undefined {
  const ownerId = controls.botOwnerId;
  return ownerId && isOwnerNotifyChat(controls.cfg, chatId) ? ownerId : undefined;
}

/** Chat type for access checks on resume — the same rule intake applies. */
function resumeChatType(msg: NormalizedMessage, mode: ChatMode): 'p2p' | 'group' | 'topic' {
  return msg.chatType === 'p2p' ? 'p2p' : mode === 'topic' ? 'topic' : 'group';
}

/**
 * A resume for a run record left behind by a shutdown or crash, when it was
 * the owner's and announced a task ledger; otherwise nothing to resume.
 */
function interruptedResumeFor(
  rec: RunRecord,
  reason: 'restart' | 'shutdown',
  now: number = Date.now(),
): PendingResume | undefined {
  if (!rec.ledger || !rec.resumeAs) return undefined;
  return {
    scope: rec.scope,
    chatId: rec.chatId,
    chatType: rec.resumeAs.chatType,
    ...(rec.threadId ? { threadId: rec.threadId } : {}),
    senderId: rec.resumeAs.senderId,
    ...(rec.resumeAs.senderName ? { senderName: rec.resumeAs.senderName } : {}),
    originMessageId: rec.originMessageId,
    resumeAt: now + INTERRUPT_RESUME_DELAY_MS,
    ...(rec.resumeAs.locale ? { locale: rec.resumeAs.locale } : {}),
    kind: 'interrupted',
    ledger: rec.ledger,
    reason,
    attempt: 1,
    createdAt: now,
  };
}

/** Schedule resumes for the records that qualify; the rest just get the notice. */
async function resumeInterruptedRecords(
  autoResumer: AutoResumer,
  records: RunRecord[],
  reason: 'restart' | 'shutdown',
): Promise<Set<string>> {
  const resumed = new Set<string>();
  for (const rec of records) {
    const resume = interruptedResumeFor(rec, reason);
    if (!resume) continue;
    await autoResumer.schedule(resume);
    resumed.add(rec.runId);
  }
  return resumed;
}

/** The message an auto-resume feeds into the scope, as if the starter sent it. */
function autoResumeMessage(resume: PendingResume): NormalizedMessage {
  return {
    // Reply to the message the paused task answered, so the new card sits
    // under the same question.
    messageId: resume.originMessageId,
    chatId: resume.chatId,
    chatType: resume.chatType === 'p2p' ? 'p2p' : 'group',
    ...(resume.threadId ? { threadId: resume.threadId } : {}),
    senderId: resume.senderId,
    ...(resume.senderName ? { senderName: resume.senderName } : {}),
    content: resumePromptFor(resume),
    rawContentType: AUTO_RESUME_CONTENT_TYPE,
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
  } as NormalizedMessage;
}

const AUTO_RESUME_CONTENT_TYPE = 'auto_resume';

/** The message a kickoff stands in for: its sender writing the prompt there. */
function kickoffMessage(kickoff: Kickoff): NormalizedMessage {
  return {
    messageId: kickoff.originMessageId,
    chatId: kickoff.chatId,
    chatType: kickoff.chatType,
    ...(kickoff.threadId ? { threadId: kickoff.threadId } : {}),
    senderId: kickoff.senderId,
    ...(kickoff.senderName ? { senderName: kickoff.senderName } : {}),
    content: kickoff.prompt,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
  } as NormalizedMessage;
}

/** The paused card, with a line saying the task went on in a new card. */
function withResumedNote(card: object, at: number, locale: Locale | undefined): object {
  const c = card as { body?: { elements?: object[] } };
  const elements = [...(c.body?.elements ?? [])];
  const note = { tag: 'markdown', content: runStrings(locale).resumedNote(formatMoment(at)) };
  // Above the byline (`hr` + grey agent line) when there is one.
  const hr = elements.findIndex((e) => (e as { tag?: string }).tag === 'hr');
  if (hr === -1) elements.push(note);
  else elements.splice(hr, 0, note);
  return { ...c, body: { ...c.body, elements } };
}

const BACKGROUND_TURN_PREFIX = '（后台任务有了新进展）\n\n';

/**
 * Replies posted once at the end that carry only the answer the run ends on:
 * `final-card` always, `text` unless `textReplyFinalOnly` is off.
 */
function answerOnlyReply(replyMode: MessageReplyMode, cfg: AppConfig): boolean {
  return replyMode === 'final-card' || (replyMode === 'text' && getTextReplyFinalOnly(cfg));
}

/**
 * The reply state for a background turn, or undefined when it has nothing to
 * show (only tool calls, or a `[[NO_REPLY]]` answer). A stop notice is always
 * shown so a silently vanished task never looks like it is still running.
 * `finalAnswerOnly` (text mode's `textReplyFinalOnly`) keeps just the answer
 * the turn ends on, as for the run's own reply.
 */
export function backgroundTurnState(
  turn: BackgroundTurn,
  filterForPrefs: (state: RunState) => RunState,
  opts: { finalAnswerOnly?: boolean } = {},
): RunState | undefined {
  if (turn.kind === 'stopped') {
    const notice =
      turn.reason === 'shutdown'
        ? 'bridge 重启，还在运行的后台任务已停止。会话上下文没丢，需要的话回一句「继续」重新发起。'
        : turn.reason === 'replaced'
          ? '下一条消息要换一个进程处理（模型、档位或附件不同），还在运行的后台任务已停止。会话上下文没丢，需要的话回一句「继续」重新发起。'
          : `后台任务运行超过 ${Math.round(turn.afterMs / 60_000)} 分钟仍未结束，已停止。需要的话请重新发起。`;
    const start = turn.account ? reduce(initialState, { type: 'account', label: turn.account }) : initialState;
    return reduce(reduce(start, { type: 'text', delta: notice }), {
      type: 'done',
      terminationReason: 'normal',
    });
  }
  const own = finalizeIfRunning(turn.events.reduce(reduce, initialState));
  const answer = opts.finalAnswerOnly ? finalAnswerState(own) : own;
  // A turn that only says background work goes on (a heartbeat) has nothing to tell.
  if (!renderText(filterForPrefs({ ...answer, background: 0 })).trim()) return undefined;
  if (opts.finalAnswerOnly) {
    const prefix: Block = { kind: 'text', content: BACKGROUND_TURN_PREFIX, streaming: false };
    return filterForPrefs({ ...answer, blocks: [prefix, ...answer.blocks], background: turn.background });
  }
  const withPrefix = turn.events.reduce(
    reduce,
    reduce(initialState, { type: 'text', delta: BACKGROUND_TURN_PREFIX }),
  );
  return filterForPrefs({ ...finalizeIfRunning(withPrefix), background: turn.background });
}

/** Queued messages older than this at boot are reported instead of processed. */
const PENDING_REQUEUE_WINDOW_MS = 10 * 60 * 1000;

async function sendExpiredPendingNotice(channel: LarkChannel, record: PendingRecord): Promise<void> {
  const last = record.messages[record.messages.length - 1];
  const first = record.messages[0];
  if (!last || !first) return;
  const preview = mediaPlaceholders(first.content).replace(/\s+/g, ' ').trim().slice(0, 40);
  const text =
    `bridge 重启前，这里有 ${record.messages.length} 条消息还在排队、没来得及处理` +
    `${preview ? `（最早一条：「${preview}」）` : ''}。` +
    '已经过去超过 10 分钟，没有自动补处理，需要的话请重新发送。';
  try {
    await channel.send(last.chatId, { text }, {
      replyTo: last.messageId,
      ...(last.threadId ? { replyInThread: true } : {}),
    });
  } catch (err) {
    log.warn('pending', 'expired-notice-failed', { scope: record.scope, err: String(err) });
  }
}

/** Byline usage for a set of events (one turn), or undefined when none was reported. */
function usageLineOf(events: readonly AgentEvent[]): string | undefined {
  const usages = events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
  if (usages.length === 0) return undefined;
  return formatUsageLine({
    inputTokens: usages.reduce((n, u) => n + (u.inputTokens ?? 0), 0),
    outputTokens: usages.reduce((n, u) => n + (u.outputTokens ?? 0), 0),
    costUsd: usages.reduce((n, u) => n + (u.costUsd ?? 0), 0),
  });
}

/** The run's text without `📒 任务台账：…` lines (see {@link stripLedgerLines}). */
function withoutLedgerLines(state: RunState): RunState {
  let changed = false;
  const blocks = state.blocks.map((b) => {
    if (b.kind !== 'text') return b;
    const content = stripLedgerLines(b.content);
    if (content === b.content) return b;
    changed = true;
    return { ...b, content };
  });
  const finalText = state.finalText !== undefined ? stripLedgerLines(state.finalText) : undefined;
  if (finalText !== state.finalText) changed = true;
  return changed ? { ...state, blocks, finalText } : state;
}
