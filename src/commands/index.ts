import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { agentAccountsReport, agentAccountsTable, switchAgentAccount } from '../agent/account';
import { agentCapability } from '../agent/capability';
import { agentDescriptor, type AgentKind } from '../agent/registry';
import {
  emptyTotals,
  formatTokens,
  type UsageLedger,
  type UsageReportRow,
  type UsageTotals,
} from '../runtime/usage-ledger';
import type { ApprovalBroker } from '../runtime/approvals';
import { toolLabel } from '../card/approval-cards';
import type { AuditLog } from '../runtime/audit-log';
import { DEFAULT_MODEL, normalizeModelSelection, supportedEfforts, supportedModels } from '../agent/models';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { RunsMonitor } from '../bot/runs-monitor';
import {
  DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MINUTES,
  getKnowledgeSyncIntervalMinutes,
  type KnowledgeAutoSync,
} from '../knowledge/auto-sync';
import {
  buildLibraryConfig,
  getSkillSyncIntervalMinutes,
  maskUrlCredentials,
  shadowedSkills,
  type SkillLibraries,
} from '../knowledge/libraries';
import type { KnowledgeStore, MemoryScope } from '../knowledge/store';
import {
  bindKnowledgeRemote,
  knowledgeRemoteUrl,
  knowledgeRepoStatus,
  syncKnowledge,
  unbindKnowledgeRemote,
} from '../knowledge/sync';
import {
  accountCurrentCard,
  accountFailureCard,
  accountFormCard,
  accountSuccessCard,
} from '../card/account-cards';
import {
  configCancelledCard,
  configFailedCard,
  configFormCard,
  configSavedCard,
  groupMsgScopeGrantCard,
  groupMsgScopeGrantedCard,
} from '../card/config-card';
import { GROUP_MSG_SCOPE, hasGroupMsgScope } from '../bot/app-scope';
import { requestScopeGrantLink } from '../bot/wizard';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import {
  coffeeCard,
  cronCard,
  diffCard,
  helpCard,
  knowledgeCard,
  type KnowledgeStatusView,
  memoryCard,
  pullRequestCard,
  resumeCard,
  skillLibrariesCard,
  skillsCard,
  statusCard,
  taskStatusCard,
  usageCard,
  type StatusInfo,
  worktreeCard,
  workspacesCard,
} from '../card/templates';
import {
  describeDiffTarget,
  parseDiffTarget,
  previewPatch,
  readDiffPatch,
  readDiffStat,
} from '../git/diff';
import { isGitError } from '../git/exec';
import { checksLabel, parsePrArg, readPullRequest, reviewLabel } from '../git/pr';
import { describeRepoStatus, isDirty, readRepoStatus, type GitRepoStatus } from '../git/status';
import { addWorktree, listWorktrees, matchWorktree, removeWorktree } from '../git/worktree';
import type { Scheduler } from '../scheduler/scheduler';
import {
  CRON_USAGE,
  jobStatusLine,
  jobTitleMd,
  lastRunLine,
  normalizeJobName,
  parseAdd,
  scheduleSummary,
  scheduleSummaryPlain,
  truncate,
} from '../scheduler/command';
import { formatTime, jobScopeId } from '../scheduler/runner';
import type { ScheduledJob } from '../scheduler/types';
import type { AppConfig, AppPreferences, EffortLevel, MessageReplyMode, TenantBrand } from '../config/schema';
import {
  getAgentStopGraceMs,
  getCotMessages,
  getEffort,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getDream,
  getSmartSession,
  getWorktreeCleanupIdleDays,
  getShowToolCalls,
} from '../config/schema';
import type {
  LarkCliIdentityPreset,
  ProfileAccess,
  ProfileConfig,
  ProfileMode,
  SkillLibraryConfig,
} from '../config/profile-schema';
import { effectiveLarkCliIdentity } from '../config/profile-schema';
import { resolveAppPaths } from '../config/app-paths';
import { describeActiveRun } from '../bot/run-status';
import { formatMoment, limitLabel, type AutoResumer } from '../bot/auto-resume';
import { parseClaudeUsage, readClaudeUsage, usageMarkdown } from './usage';
import { accessToClaudePermissionMode } from '../config/permissions';
import {
  canRunAdminCommand,
  canRunCommandInChat,
  canStopRun,
  canUseDm,
  canUseGroup,
  type OwnerRefreshState,
} from '../policy/access';
import { buildEncryptedAccountConfig } from '../config/store';
import * as configOps from '../config/config-ops';
import { log, reportMetric } from '../core/logger';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { formatRelTime, listRecentSessions, type SessionSummary } from '../session/history';
import {
  listCodexThreadHistory,
  type CodexThreadHistoryEntry,
  type ListCodexThreadHistoryOptions,
} from '../session/codex-history';
import type { SessionCatalog, SessionCatalogIdentity } from '../session/catalog';
import { isAlive, readAndPrune, resolveTarget } from '../runtime/registry';
import { readUiSidecar } from '../ui/sidecar';
import type { SessionStore } from '../session/store';
import { resolveWorkingDirectory } from '../policy/workspace';
import { evaluateRunPolicy } from '../policy/run-policy';
import type { ProcessPool } from '../bot/process-pool';
import type { RunExecutor } from '../runtime/run-executor';
import { RunRejected } from '../runtime/errors';
import { validateAppCredentials } from '../utils/feishu-auth';
import type { WorkspaceStore } from '../workspace/store';
import { createBoundChat, defaultChatName } from '../bot/group';
import { fetchKnownChats, type KnownChat } from '../bot/lark-info';
import type { PendingRotationStore } from '../session/rotation-store';
import type { CodeSnippetStore } from '../card/code-snippets';
import { decideRotation } from '../session/smart-session';
import { probeAgentSession } from '../agent/session-probe';
import { describeMeetingError, type MeetingManager } from '../meeting/manager';
import { isMeetingNo } from '../meeting/api';
import { answerInMeeting, meetingScopeId } from '../meeting/orchestrator';
import type { MeetingSession } from '../meeting/session';
import { hasStructuredLarkCliUserAuth } from '../lark-cli/identity-policy';
import { isPlainCoffeeRequest } from './coffee-intent';
import { formatDreamPrs, formatDreamRevert, formatDreamRun, formatDreamStatus } from '../dream/format';
import type { DreamService } from '../dream/service';

export interface Controls {
  profile: string;
  profileConfig: ProfileConfig;
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
  refreshOwner(channel?: LarkChannel): Promise<void>;
  /** Restart the bridge in-process: disconnect WS, kill claude runs, reload
   * config, reconnect with the new credentials. */
  restart(opts?: { wait?: boolean }): Promise<void>;
  /** Stop this whole process gracefully (disconnect + exit). Used by /exit
   * when the user targets the receiving process itself. */
  exit(): Promise<void>;
  /** Path to the config file the bridge was started with. */
  configPath: string;
  /** The current app config (snapshot at startChannel time). */
  cfg: AppConfig;
  /** This process's short id in the registry. Used by /ps to highlight the
   * receiving process and by /exit to detect self-target. */
  processId: string;
  /** Groups the bot currently belongs to, used to render and bulk-manage access. */
  knownChats?: KnownChat[];
  /** In-meeting agent manager; present only while the channel is connected and
   * `meeting.enabled` is on. Late-bound by startChannel. */
  meeting?: MeetingManager;
  /** Live-run view + interrupt for the web console's tasks panel; present only
   * while the channel is connected. Late-bound by startChannel. */
  runsMonitor?: RunsMonitor;
  /** Cross-session memory + skills for this profile, backing `/memory`,
   * `/skills` and `/knowledge`. Late-bound by startChannel. */
  knowledge?: KnowledgeStore;
  /** Shared skill libraries backing `/skills lib`. Late-bound by startChannel. */
  skillLibraries?: SkillLibraries;
  /** Periodic sync of the knowledge repo, shown by `/knowledge`. Late-bound by startChannel. */
  knowledgeAutoSync?: KnowledgeAutoSync;
  /** Scheduled-job engine backing `/cron`; present only while the channel is
   * connected and a profile data dir exists. Late-bound by startChannel. */
  scheduler?: Scheduler;
  /** Late-bound like `scheduler`: quota-paused tasks waiting to resume. */
  autoResumer?: AutoResumer;
  /** Per-person consumption backing `/usage`; present only while the channel
   * is connected and a profile data dir exists. Late-bound by startChannel. */
  usage?: UsageLedger;
  /** Pending approvals for runs non-admins drive (`approval.*` card buttons). Late-bound by startChannel. */
  approvals?: ApprovalBroker;
  /** Who had the bot do what, backing `/audit`. Late-bound by startChannel. */
  audit?: AuditLog;
  /** 会话智能压缩 closes the agent asked for, read by `/status`. Late-bound by startChannel. */
  pendingRotations?: Pick<PendingRotationStore, 'get'>;
  /** Code blocks behind finished cards' 「复制代码」 buttons (see /copycode). */
  codeSnippets?: Pick<CodeSnippetStore, 'get' | 'put'>;
  /** 课堂精练 backing `/practice` and the console's dream panel. Late-bound by startChannel. */
  dream?: DreamService;
}

export interface CommandContext {
  channel: LarkChannel;
  msg: NormalizedMessage;
  /**
   * Session scope string. For p2p / regular group it equals `msg.chatId`;
   * for topic groups it's `${chatId}:${threadId}` (so each topic gets its
   * own session / cwd / active-run). All handlers should read/write
   * session / workspace / activeRuns through this — never through
   * `msg.chatId` directly.
   */
  scope: string;
  /** Resolved chat mode for `msg.chatId`. Used by /status to surface the
   * scope semantic to the user (`topic` shows "话题独立 session"). */
  chatMode: 'p2p' | 'group' | 'topic';
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  sessionCatalogIdentity?: SessionCatalogIdentity;
  workspaces: WorkspaceStore;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  /** Quota-paused tasks waiting to resume; `/stop` cancels, `/status` shows. */
  autoResumer?: AutoResumer;
  codexHistoryProvider?: (
    options: ListCodexThreadHistoryOptions,
  ) => Promise<CodexThreadHistoryEntry[]>;
  claudeHistoryProvider?: (cwd: string, limit: number) => Promise<SessionSummary[]>;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
  /** True when this invocation came from a card button click rather than a
   * text command. Determines whether to update the existing card vs send a
   * new one. */
  fromCardAction?: boolean;
}

type Handler = (args: string, ctx: CommandContext) => Promise<void>;

interface ResumeCandidate {
  scopeId: string;
  agentId: AgentKind;
  cwdRealpath: string;
  policyFingerprint: string;
  sessionId?: string;
  threadId?: string;
  expiresAt: number;
}

const RESUME_CANDIDATE_TTL_MS = 10 * 60 * 1000;
const resumeCandidates = new Map<string, ResumeCandidate>();
const AUDIT_SAFE_COMMAND_REPLY = '命令已处理。';
const RESUME_APPLIED_REPLY = '已完成，请继续发送下一条消息。';

const handlers: Record<string, Handler> = {
  '/new': handleNew,
  '/reset': handleNew,
  '/cd': handleCd,
  '/ws': handleWs,
  '/resume': handleResume,
  '/status': handleStatus,
  '/help': handleHelp,
  '/account': handleAccount,
  '/accounts': handleAccounts,
  '/config': handleConfig,
  '/stop': handleStop,
  '/copycode': handleCopyCode,
  '/timeout': handleTimeout,
  '/ps': handlePs,
  '/exit': handleExit,
  '/doctor': handleDoctor,
  '/reconnect': handleReconnect,
  '/doc': handleDoc,
  '/invite': handleInvite,
  '/remove': handleRemove,
  '/meeting': handleMeeting,
  '/diff': handleDiff,
  '/worktree': handleWorktree,
  '/pr': handlePr,
  '/memory': handleMemory,
  '/skills': handleSkills,
  '/knowledge': handleKnowledge,
  '/cron': handleCron,
  '/coffee': handleCoffee,
  '/usage': handleUsage,
  '/audit': handleAudit,
  '/practice': handleDream,
  // Upstream name, kept so old habits and upstream docs still work.
  '/dream': handleDream,
  // Card buttons of approval prompts (not typed by people; see ApprovalBroker).
  '/approval': handleApproval,
};

/**
 * Commands that can mutate credentials, lifecycle, filesystem reach, or
 * surface sensitive runtime state. Gated by unified access policy; runtime
 * owner is always allowed, while empty admin list means no listed admins.
 */
const ADMIN_COMMANDS = new Set([
  '/account',
  // Shows the owner's subscription quotas and changes which account pays;
  // `access.commandChats` may open it to everyone in chosen chats.
  '/accounts',
  '/config',
  '/ps',
  '/exit',
  '/reconnect',
  '/doctor',
  '/cd',
  '/ws',
  '/invite',
  '/remove',
  // These read repository contents into the chat and create directories on the
  // host, so they sit at the same level as /cd and /ws.
  '/diff',
  '/worktree',
  '/pr',
  // Binding / syncing the knowledge repo moves content between machines and
  // rewrites what every chat in this profile sees.
  '/knowledge',
  // A scheduled job runs the agent unattended with the profile's full
  // permissions, so creating one is at least as sensitive as /cd.
  '/cron',
  // Joining a meeting makes the bot visible to every participant and exposes
  // meeting content to the agent — owner/admin only.
  '/meeting',
  // Shows who had the bot do what across every chat of the profile.
  '/audit',
  // Reads every chat's conversations and opens PRs against shared repositories.
  '/practice',
  '/dream',
]);

function isAdminCommand(cmd: string): boolean {
  return ADMIN_COMMANDS.has(cmd.startsWith('/') ? cmd : `/${cmd}`);
}

/** Owner/admin, or anyone in a chat `access.commandChats` opens the command in. */
function canRunCommand(cmd: string, ctx: CommandContext): boolean {
  return canRunCommandInChat(ctx.controls.profileConfig, ctx.controls, cmd, ctx.msg.chatId, ctx.msg.senderId).ok;
}

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  const trimmed = ctx.msg.content.trim();
  if (!trimmed.startsWith('/')) {
    if (isPlainCoffeeRequest(trimmed, ctx.msg.mentions, ctx.channel.botIdentity?.openId)) {
      await handleCoffee('', ctx);
      return true;
    }
    return false;
  }
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0] ?? '';
  const args = parts.slice(1).join(' ');
  const h = handlers[cmd];
  if (!h) return false;
  if (isAdminCommand(cmd) && !canRunCommand(cmd, ctx)) {
    log.info('command', 'admin-deny', {
      cmd,
      sender: ctx.msg.senderId.slice(-6),
    });
    await reply(ctx, '❌ 此命令仅管理员可用。');
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd });
    reportMetric('command_fail', 1, { step: 'dispatch' });
  }
  return true;
}

/** Invoke a named command handler (e.g. from a card button click). */
export async function runCommandHandler(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const h = handlers[`/${name}`];
  if (!h) return false;
  if (isAdminCommand(name) && !canRunCommand(`/${name}`, ctx)) {
    log.info('command', 'admin-deny', {
      cmd: name,
      sender: ctx.msg.senderId.slice(-6),
      via: 'card',
    });
    // Card actions can't reply naturally (the `msg` is synthesized); the
    // click is silently denied. The button only renders for users who got
    // the original admin card in the first place, so this is an edge case.
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd: name });
    reportMetric('command_fail', 1, { step: 'handler' });
  }
  return true;
}

/**
 * Send a plain markdown reply, swallowing any send error. Used by command
 * handlers where a failed reply shouldn't bubble up and crash the bot —
 * losing the message is better than dying.
 */
/**
 * 「复制代码」 button on a finished card: send that code block alone as a
 * plain-text reply to the card, so long-press / right-click 复制 takes it
 * whole. Cards themselves can't write the clipboard.
 */
async function handleCopyCode(args: string, ctx: CommandContext): Promise<void> {
  const key = args.trim();
  const code = key ? ctx.controls.codeSnippets?.get(key) : undefined;
  if (!code) {
    await reply(ctx, '这段代码已经找不到了（太久以前的卡片），请让我重新发一次。');
    return;
  }
  log.info('command', 'copycode', { key, chars: code.length });
  try {
    await ctx.channel.send(ctx.msg.chatId, { text: code }, commandReplyOptions(ctx));
  } catch (err) {
    log.fail('command', err, { step: 'copycode' });
    await reply(ctx, '代码发送失败，请稍后再点一次。');
  }
}

async function reply(ctx: CommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, commandReplyOptions(ctx));
  } catch (err) {
    log.fail('command', err, { step: 'reply' });
    reportMetric('command_fail', 1, { step: 'reply' });
    if (!isMessageAuditReject(err) || markdown === AUDIT_SAFE_COMMAND_REPLY) return;
    try {
      await ctx.channel.send(
        ctx.msg.chatId,
        { markdown: AUDIT_SAFE_COMMAND_REPLY },
        commandReplyOptions(ctx),
      );
    } catch (fallbackErr) {
      log.fail('command', fallbackErr, { step: 'reply-audit-fallback' });
      reportMetric('command_fail', 1, { step: 'reply-audit-fallback' });
    }
  }
}

function commandReplyOptions(ctx: CommandContext): { replyTo: string; replyInThread?: true } {
  return {
    replyTo: ctx.msg.messageId,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}),
  };
}

function isMessageAuditReject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as Record<string, unknown>;
  if (record.code === 230028) return true;
  const message = String(record.message ?? record.msg ?? '');
  return /not pass the audit/i.test(message);
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

function isAbsoluteOrTilde(p: string): boolean {
  return isAbsolute(p) || p === '~' || p.startsWith('~/');
}

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  // /new chat [name]  — spin up a fresh group chat bound to a fresh session
  if (trimmed === 'chat' || trimmed.startsWith('chat ')) {
    const rawName = trimmed === 'chat' ? '' : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }

  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    ctx.sessionCatalog.archiveActive({
      ...ctx.sessionCatalogIdentity,
      now: Date.now(),
    });
  }
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, wasRunning ? '已中断当前任务并开始新会话。' : '已开始新会话。');
}

async function handleNewChat(rawName: string, ctx: CommandContext): Promise<void> {
  const sourceCwd = effectiveWorkspaceCwd(ctx);
  const name = rawName || defaultChatName(ctx.agent.displayName);

  let created;
  try {
    created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(ctx, `❌ 创建群失败：${msg}\n\n确认 bot 已开启 \`im:chat\` 权限。`);
    return;
  }

  // Inherit cwd from the originating chat so the new group starts in the
  // same workspace; otherwise it'll fall back to $HOME.
  if (sourceCwd) {
    ctx.workspaces.setCwd(created.chatId, sourceCwd);
  }

  // Welcome the user inside the new group with a hint about how to start.
  const welcome = sourceCwd
    ? `🎉 群已建好，cwd 继承自原群：\`${sourceCwd}\`\n\n@我 + 任意消息开始对话。`
    : '🎉 群已建好。\n\n@我 + 任意消息开始对话。';
  try {
    await ctx.channel.send(created.chatId, { markdown: welcome });
  } catch (err) {
    console.warn('[new-chat] welcome message failed:', err);
  }

  await reply(
    ctx,
    `✓ 已创建群 **${created.name}**，去新群里继续。`,
  );
}

async function handleCd(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();
  if (!input) {
    await reply(ctx, '用法：`/cd <绝对路径>` 或 `/cd ~/xxx`');
    return;
  }
  if (!isAbsoluteOrTilde(input)) {
    await reply(ctx, '请使用绝对路径，或 `~/xxx` 表示 home 下的子路径。');
    return;
  }
  const absolute = expandTilde(input);
  const workspace = await resolveWorkingDirectory(absolute);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换 cwd 到 \`${workspace.cwdRealpath}\`\n（session 已重置）`);
}

async function handleWs(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? '';
  const name = parts.slice(1).join(' ').trim();
  switch (sub) {
    case '':
    case 'list':
      return handleWsList(ctx);
    case 'save':
      return handleWsSave(name, ctx);
    case 'use':
      return handleWsUse(name, ctx);
    case 'remove':
    case 'rm':
      return handleWsRemove(name, ctx);
    default:
      await reply(ctx, '用法：`/ws [list|save <name>|use <name>|remove <name>]`');
  }
}

async function handleWsList(ctx: CommandContext): Promise<void> {
  const named = listScopedWorkspaces(ctx);
  const currentCwd = effectiveWorkspaceCwd(ctx);
  const card = workspacesCard(
    currentCwd,
    named,
  );
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function handleWsSave(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws save <name>`');
    return;
  }
  const cwd = effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '当前 chat 未设置 cwd，先用 `/cd` 设置再保存。');
    return;
  }
  ctx.workspaces.saveNamed(scopedWorkspaceName(ctx, name), cwd);
  await reply(ctx, `✓ 工作目录别名已保存：\`${name}\` → ${cwd}`);
}

async function handleWsUse(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws use <name>`');
    return;
  }
  const cwd = getWorkspaceAlias(ctx, name);
  if (!cwd) {
    await reply(ctx, `未找到工作目录别名：\`${name}\``);
    return;
  }
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换到 \`${name}\` (${workspace.cwdRealpath})\n（session 已重置）`);
}

async function handleWsRemove(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws remove <name>`');
    return;
  }
  if (!removeWorkspaceAlias(ctx, name)) {
    await reply(ctx, `未找到工作目录别名：\`${name}\``);
    return;
  }
  await reply(ctx, `✓ 已删除工作目录别名：\`${name}\``);
}

async function handleDoc(args: string, ctx: CommandContext): Promise<void> {
  void args;
  await reply(ctx, '云文档评论现在不需要绑定工作区；在支持的文档评论里 @bot 即可触发回复。');
}

const WORKSPACE_NAME_SEPARATOR = '\u001f';

function scopedWorkspaceName(ctx: CommandContext, name: string): string {
  return [
    ctx.controls.profile,
    ctx.controls.botOwnerId ?? 'owner-unknown',
    ctx.scope,
    name,
  ].join(WORKSPACE_NAME_SEPARATOR);
}

function workspaceAliasKeys(ctx: CommandContext, name: string): string[] {
  return [scopedWorkspaceName(ctx, name), name];
}

function getWorkspaceAlias(ctx: CommandContext, name: string): string | undefined {
  for (const key of workspaceAliasKeys(ctx, name)) {
    const cwd = ctx.workspaces.getNamed(key);
    if (cwd) return cwd;
  }
  return undefined;
}

function removeWorkspaceAlias(ctx: CommandContext, name: string): boolean {
  const scopedKey = scopedWorkspaceName(ctx, name);
  if (ctx.workspaces.removeNamed(scopedKey)) return true;
  return ctx.workspaces.removeNamed(name);
}

function isLegacyWorkspaceAlias(key: string): boolean {
  return key !== '' && !key.includes(WORKSPACE_NAME_SEPARATOR);
}

function listScopedWorkspaces(ctx: CommandContext): Record<string, string> {
  const prefix = scopedWorkspaceName(ctx, '');
  const named = ctx.workspaces.listNamed();
  const scoped: Record<string, string> = {};
  for (const [key, cwd] of Object.entries(named)) {
    if (!key.startsWith(prefix)) continue;
    const displayName = key.slice(prefix.length);
    if (displayName) scoped[displayName] = cwd;
  }
  for (const [key, cwd] of Object.entries(named)) {
    if (isLegacyWorkspaceAlias(key) && scoped[key] === undefined) scoped[key] = cwd;
  }
  return scoped;
}

async function handleResume(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ').trim();

  if (sub === 'use' && rest) {
    return applyResume(rest, ctx);
  }

  // Default: list recent sessions
  const n = Number.parseInt(sub, 10);
  const limit = Number.isFinite(n) && n > 0 && n <= 20 ? n : 5;

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 /cd <path> 选择工作目录，再查看或恢复会话。');
    return;
  }

  if (ctx.chatMode !== 'p2p') {
    await reply(ctx, '群聊中不展示历史会话详情。请私聊 bot 使用 `/resume` 查看和选择历史会话。');
    return;
  }

  await RESUME_LISTS[ctx.controls.profileConfig.agentKind](ctx, cwd, limit, sub);
}

/**
 * `/resume` listing per agent: each reads its own CLI's history and issues
 * resume candidates keyed by that agent's session handle.
 */
const RESUME_LISTS: Record<AgentKind, (ctx: CommandContext, cwd: string, limit: number, sub: string) => Promise<void>> = {
  claude: sendClaudeResumeList,
  codex: sendCodexResumeList,
};

async function sendCodexResumeList(ctx: CommandContext, cwd: string, limit: number): Promise<void> {
  const identity = ctx.sessionCatalogIdentity;
  const entry =
    ctx.sessionCatalog && identity
      ? ctx.sessionCatalog.activeFor(identity)
      : undefined;
  const history = identity ? await listCodexResumeHistory(ctx, cwd, limit) : [];
  if (history.length > 0 && identity) {
    const entries = history.map((thread) => {
      const nonce = issueResumeCandidate(identity, { threadId: thread.threadId });
      return {
        sessionId: nonce,
        preview: thread.name || thread.preview,
        relTime: formatRelTime(thread.updatedAtMs),
        detail: `Codex · ${thread.source}`,
        current: thread.threadId === entry?.threadId,
      };
    });
    const card = resumeCard(cwd, entries);
    await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
    return;
  }
  if (entry?.threadId && identity) {
    const nonce = issueResumeCandidate(identity, { threadId: entry.threadId });
    await reply(
      ctx,
      `当前 Codex thread 可恢复。\n使用 \`/resume use ${nonce}\` 恢复（10 分钟内有效）。`,
    );
    return;
  }
  const card = resumeCard(cwd, []);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function sendClaudeResumeList(ctx: CommandContext, cwd: string, limit: number, sub = ''): Promise<void> {
  // Only this chat's own conversations: every chat shares the workspace, so
  // the unfiltered list would let anyone resume (and read back) someone
  // else's session. The owner can still see everything with `/resume all`.
  const showAll =
    sub === 'all' && canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok;
  const own = scopeSessionIds(ctx);
  const sessions = showAll
    ? await listClaudeResumeHistory(ctx, cwd, RESUME_SCAN_LIMIT).then((all) => all.slice(0, 20))
    : (await listClaudeResumeHistory(ctx, cwd, RESUME_SCAN_LIMIT))
        .filter((s) => own.has(s.sessionId))
        .slice(0, limit);
  const currentSession = ctx.sessions.getRaw(ctx.scope);
  const identity = ctx.sessionCatalogIdentity;
  const entries = sessions.map((s) => ({
    sessionId: identity
      ? issueResumeCandidate(identity, { sessionId: s.sessionId })
      : s.sessionId,
    displayId: s.sessionId,
    preview: s.preview,
    relTime: formatRelTime(s.mtime),
    lineCount: s.lineCount,
    current: s.sessionId === currentSession?.sessionId,
  }));
  const card = resumeCard(cwd, entries);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function applyResume(sessionId: string, ctx: CommandContext): Promise<void> {
  const descriptor = agentDescriptor(ctx.controls.profileConfig.agentKind);
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    const identity = ctx.sessionCatalogIdentity;
    const entry = ctx.sessionCatalog.activeFor(identity);
    const resolved = consumeResumeCandidate(sessionId, identity);
    const handleField = agentDescriptor(identity.agentId).sessionHandle;
    const handle = resolved?.[handleField];
    if (handle) {
      ctx.activeRuns.interrupt(ctx.scope);
      ctx.sessionCatalog.upsertActive({
        scopeId: identity.scopeId,
        agentId: identity.agentId,
        cwdRealpath: identity.cwdRealpath,
        policyFingerprint: identity.policyFingerprint,
        [handleField]: handle,
      });
      if (descriptor.scopeSessionStore) ctx.sessions.set(ctx.scope, handle, identity.cwdRealpath);
      await reply(ctx, RESUME_APPLIED_REPLY);
      return;
    }
    // Without a scope store there is no raw-id path: only a fresh candidate resumes.
    if (!descriptor.scopeSessionStore) {
      await reply(ctx, '当前上下文不可恢复这个会话，请先用 `/resume` 重新生成恢复候选。');
      return;
    }
    const expected = entry?.[handleField];
    if (expected !== sessionId) {
      await reply(ctx, '当前上下文不可恢复这个会话，请重新选择当前工作区和权限策略下的会话。');
      return;
    }
    ctx.activeRuns.interrupt(ctx.scope);
    ctx.sessions.set(ctx.scope, sessionId, identity.cwdRealpath);
    await reply(ctx, RESUME_APPLIED_REPLY);
    return;
  }

  if (!descriptor.scopeSessionStore) {
    await reply(ctx, `当前上下文没有可恢复的 ${descriptor.displayName} 会话，请先在当前工作区完成一次运行。`);
    return;
  }

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 /cd <path> 选择工作目录，再查看或恢复会话。');
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.set(ctx.scope, sessionId, cwd);
  await reply(ctx, RESUME_APPLIED_REPLY);
}

function issueResumeCandidate(
  identity: SessionCatalogIdentity,
  target: { sessionId: string } | { threadId: string },
): string {
  pruneResumeCandidates();
  let nonce = randomUUID().slice(0, 12);
  while (resumeCandidates.has(nonce)) nonce = randomUUID().slice(0, 12);
  resumeCandidates.set(nonce, {
    scopeId: identity.scopeId,
    agentId: identity.agentId,
    cwdRealpath: identity.cwdRealpath,
    policyFingerprint: identity.policyFingerprint,
    ...target,
    expiresAt: Date.now() + RESUME_CANDIDATE_TTL_MS,
  });
  return nonce;
}

function consumeResumeCandidate(
  nonce: string,
  identity: SessionCatalogIdentity,
): ResumeCandidate | undefined {
  pruneResumeCandidates();
  const candidate = resumeCandidates.get(nonce);
  if (!candidate) return undefined;
  resumeCandidates.delete(nonce);
  if (
    candidate.scopeId !== identity.scopeId ||
    candidate.agentId !== identity.agentId ||
    candidate.cwdRealpath !== identity.cwdRealpath ||
    candidate.policyFingerprint !== identity.policyFingerprint ||
    !candidate[agentDescriptor(identity.agentId).sessionHandle]
  ) {
    return undefined;
  }
  return candidate;
}

function pruneResumeCandidates(now = Date.now()): void {
  for (const [nonce, candidate] of resumeCandidates.entries()) {
    if (candidate.expiresAt <= now) resumeCandidates.delete(nonce);
  }
}

/** How far back `/resume` looks before keeping only this chat's sessions. */
const RESUME_SCAN_LIMIT = 200;

/** Claude sessions this chat has used: its current one and any it moved on from. */
function scopeSessionIds(ctx: CommandContext): Set<string> {
  const ids = new Set<string>();
  const current = ctx.sessions.getRaw(ctx.scope)?.sessionId;
  if (current) ids.add(current);
  for (const entry of ctx.sessionCatalog?.entries() ?? []) {
    if (entry.scopeId === ctx.scope && entry.agentId === ctx.controls.profileConfig.agentKind && entry.sessionId) {
      ids.add(entry.sessionId);
    }
  }
  return ids;
}

async function listClaudeResumeHistory(
  ctx: CommandContext,
  cwd: string,
  limit: number,
): Promise<SessionSummary[]> {
  const provider = ctx.claudeHistoryProvider ?? listRecentSessions;
  return provider(cwd, limit);
}

async function listCodexResumeHistory(
  ctx: CommandContext,
  cwd: string,
  limit: number,
): Promise<CodexThreadHistoryEntry[]> {
  const codex = ctx.controls.profileConfig.codex;
  const binary = codex?.binaryPath;
  if (!binary) return [];

  const provider = ctx.codexHistoryProvider ?? listCodexThreadHistory;
  try {
    return await provider({
      binary,
      cwd,
      limit,
      profileStateDir: commandProfilePaths(ctx).profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      ...(codex.inheritCodexHome !== undefined
        ? { inheritCodexHome: codex.inheritCodexHome }
        : {}),
    });
  } catch (err) {
    log.warn('session', 'codex-history-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function effectiveWorkspaceCwd(ctx: CommandContext): string | undefined {
  return ctx.workspaces.cwdFor(ctx.scope) ?? ctx.controls.profileConfig.workspaces.default;
}

function selectedResumeCwd(ctx: CommandContext): string | undefined {
  return effectiveWorkspaceCwd(ctx);
}

function runtimeAccessStatus(
  profileConfig: ProfileConfig,
): { label: string; value: string } {
  if (agentDescriptor(profileConfig.agentKind).accessControl === 'permission-mode') {
    return {
      label: 'permission',
      value: accessToClaudePermissionMode(
        profileConfig.permissions.defaultAccess,
        profileConfig.permissions,
      ),
    };
  }
  return {
    label: 'sandbox',
    value: `${profileConfig.sandbox.defaultMode}/${profileConfig.sandbox.maxMode}`,
  };
}

async function larkCliStatus(ctx: CommandContext): Promise<'app' | 'user-ready' | 'user-missing' | 'check-failed'> {
  const appPaths = commandProfilePaths(ctx);
  try {
    const raw = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps?: Array<{
        appId?: string;
        brand?: string;
        defaultAs?: string;
        strictMode?: string;
        users?: unknown;
      }>;
    };
    const app = raw.apps?.find(
      (candidate) =>
        candidate.appId === ctx.controls.profileConfig.accounts.app.id &&
        candidate.brand === ctx.controls.profileConfig.accounts.app.tenant,
    );
    if (app?.defaultAs === 'auto' && app.strictMode === 'off' && hasStructuredLarkCliUserAuth(app.users)) {
      return 'user-ready';
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'check-failed';
  }
  if (
    ctx.controls.profileConfig.larkCli.identityPreset === 'user-default' &&
    canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    return 'user-missing';
  }
  return 'app';
}

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const cwd = effectiveWorkspaceCwd(ctx);
  const activeHandle = ctx.activeRuns.get(ctx.scope);
  const pendingResume = ctx.autoResumer?.get(ctx.scope);
  // Workspace paths, session ids, git and account state are the owner's
  // business; everyone else only needs to know how their task is doing.
  if (!canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    const card = taskStatusCard({
      ...(activeHandle ? { activeRun: describeActiveRun(activeHandle) } : {}),
      ...(pendingResume
        ? {
            autoResume: `${limitLabel(pendingResume.limitType)}用完暂停，${formatMoment(pendingResume.resumeAt)} 自动继续（发 /stop 取消）`,
          }
        : {}),
    });
    await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
    return;
  }
  const sess = ctx.sessions.getRaw(ctx.scope);
  // Scope-store agents report the scope's session (and whether its cwd went
  // stale); the rest report the catalog entry for the current context.
  const descriptor = agentDescriptor(ctx.controls.profileConfig.agentKind);
  const catalogEntry =
    !descriptor.scopeSessionStore && ctx.sessionCatalog && ctx.sessionCatalogIdentity
      ? ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity)
      : undefined;
  const sessionId = descriptor.scopeSessionStore ? sess?.sessionId : catalogEntry?.[descriptor.sessionHandle];
  const sessionStale = descriptor.scopeSessionStore && Boolean(cwd && sess && sess.cwd !== cwd);
  const card = statusCard({
    profileName: ctx.controls.profile,
    cwd,
    sessionId,
    emptySessionText: descriptor.scopeSessionStore ? undefined : '(未建立)',
    sessionStale,
    ...(sessionId && !sessionStale
      ? await sessionContextStatus(ctx, sessionId, (descriptor.scopeSessionStore ? sess?.cwd : undefined) ?? cwd)
      : {}),
    agentName: ctx.agent.displayName,
    runtimeAccess: runtimeAccessStatus(ctx.controls.profileConfig),
    larkCliStatus: await larkCliStatus(ctx),
    ...(await gitStatusLine(cwd)),
    ...(await knowledgeStatusLine(ctx)),
    activeRun: Boolean(ctx.activeRuns.get(ctx.scope)),
    ...(activeHandle ? { activeRunDetail: describeActiveRun(activeHandle) } : {}),
    ...(pendingResume
      ? {
          autoResume: `${limitLabel(pendingResume.limitType)}用完暂停，${formatMoment(pendingResume.resumeAt)} 自动继续（发 /stop 取消）`,
        }
      : {}),
    backgroundRun: ctx.activeRuns.isLingering(ctx.scope),
    activeScopes: ctx.activeRuns.scopes().filter((scope) => !scope.startsWith('comment:')),
    activeCommentScopes: ctx.activeRuns.scopes().filter((scope) => scope.startsWith('comment:')),
    queue: ctx.processPool?.snapshot(),
    ownerState: formatOwnerState(ctx),
    scope: ctx.scope,
    chatMode: ctx.chatMode,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

/**
 * How big the conversation the next message would resume has grown, and —
 * with 会话智能压缩 on — whether that message will start a fresh one instead.
 * Read from the agent's own transcript; absent when it can't be read.
 */
async function sessionContextStatus(
  ctx: CommandContext,
  handle: string,
  cwd: string | undefined,
): Promise<Pick<StatusInfo, 'context'>> {
  if (!cwd) return {};
  const probe = await probeAgentSession(ctx.controls.profileConfig, handle, cwd);
  if (!probe || (probe.contextTokens === undefined && probe.lastActivityAt === undefined)) return {};
  const now = Date.now();
  const smartSession = getSmartSession(ctx.controls.cfg);
  const pending = ctx.controls.pendingRotations?.get(ctx.scope);
  const verdict =
    smartSession && !ctx.runExecutor?.hasLiveProcess(ctx.scope)
      ? decideRotation({ settings: smartSession, probe, ...(pending ? { pending } : {}), resumeHandle: handle, now })
      : undefined;
  return {
    context: {
      ...(probe.contextTokens !== undefined ? { tokens: probe.contextTokens } : {}),
      ...(probe.lastActivityAt !== undefined
        ? { idleMinutes: Math.max(0, Math.floor((now - probe.lastActivityAt) / 60_000)) }
        : {}),
      ...(verdict ? { rotateReason: verdict.reason } : {}),
    },
  };
}

function formatOwnerState(ctx: CommandContext): string {
  const state = ctx.controls.ownerRefreshState;
  const owner = ctx.controls.botOwnerId ? 'present' : 'missing';
  const refreshed = ctx.controls.ownerRefreshedAt
    ? ` refreshed=${new Date(ctx.controls.ownerRefreshedAt).toISOString()}`
    : '';
  return `${state} owner=${owner}${refreshed}`;
}

async function handleStop(args: string, ctx: CommandContext): Promise<void> {
  const targetScope = args.trim();
  if (targetScope && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '❌ 指定 scope 停止任务仅管理员可用。');
    return;
  }
  const scope = targetScope || ctx.scope;
  if (!targetScope) {
    const running = ctx.activeRuns.get(scope);
    const decision = running
      ? canStopRun(
          ctx.controls.profileConfig,
          ctx.controls,
          ctx.msg.senderId,
          running.supplement?.initiators,
        )
      : undefined;
    if (decision && !decision.ok) {
      log.info('command', 'stop-deny', {
        scope,
        sender: ctx.msg.senderId.slice(-6),
        via: ctx.fromCardAction ? 'card' : 'command',
      });
      await reply(ctx, '❌ 只有任务的发起人、bot 主人、管理员或终止白名单里的人可以终止这个任务。');
      return;
    }
  }
  const stopped = ctx.activeRuns.interruptDetailed(scope);
  const ok = stopped.active || stopped.background;
  if (!targetScope && !ok) {
    // Nothing running, but a quota-paused task may be waiting to resume.
    const waiting = ctx.autoResumer?.get(scope);
    if (waiting) {
      const decision = canStopRun(
        ctx.controls.profileConfig,
        ctx.controls,
        ctx.msg.senderId,
        new Set([waiting.senderId]),
      );
      if (!decision.ok) {
        await reply(ctx, '❌ 只有任务的发起人、bot 主人、管理员或终止白名单里的人可以取消自动续跑。');
        return;
      }
      await ctx.autoResumer?.cancel(scope, 'stop-command');
      await reply(ctx, `已取消自动续跑（原定 ${formatMoment(waiting.resumeAt)}）。需要时发「继续」即可接着做。`);
      return;
    }
  }
  log.info('command', 'stop', {
    scope,
    targeted: Boolean(targetScope),
    interrupted: ok,
    background: stopped.background,
  });
  if (targetScope) {
    await reply(
      ctx,
      ok
        ? `已请求停止 \`${scope}\`。`
        : `未找到正在运行的任务：\`${scope}\`。`,
    );
  }
  // No reply for the current IM scope when a run was in flight: its render
  // loop marks the card as interrupted. Background work has no card to mark.
  else if (stopped.background && !stopped.active) {
    await reply(ctx, '已停止后台任务。');
  }
}

async function handleTimeout(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();
  const parsed = parseTimeoutTarget(trimmed, ctx.scope);
  if (
    parsed.targeted &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    await reply(ctx, '❌ 指定 scope 设置 timeout 仅管理员可用。');
    return;
  }
  const scope = parsed.scope;
  const value = parsed.value;
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 60_000) : 0;
  const formatGlobal = (): string =>
    globalMinutes > 0 ? `${globalMinutes} 分钟` : '未启用';

  // /timeout — show effective value + source
  if (!value) {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(scope);
    const usage =
      '\n\n用法:\n- `/timeout 15` 当前 session 设 15 分钟\n- `/timeout off` 当前 session 关闭探活\n- `/timeout default` 清除 session 覆盖,回退全局\n- `/timeout comment:<scopeHash> 15` 管理员设置 comment scope\n\n_注:`/new` 会清掉当前 session 的覆盖,回到全局_';
    const scopeLabel = parsed.targeted ? ` (${scope})` : '';
    if (scopeMinutes !== undefined) {
      const effective =
        scopeMinutes > 0 ? `${scopeMinutes} 分钟` : '已关闭（当前 session）';
      await reply(ctx, `⏱ 当前 session${scopeLabel} 探活:${effective}\n全局默认:${formatGlobal()}${usage}`);
      return;
    }
    await reply(ctx, `⏱ 当前 session${scopeLabel} 探活:跟随全局(${formatGlobal()})${usage}`);
    return;
  }

  if (value === 'default') {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(scope);
    log.info('command', 'timeout-clear', { scope, cleared, targeted: parsed.targeted });
    await reply(
      ctx,
      cleared
        ? `✅ 已清除 session 覆盖,回退到全局(${formatGlobal()})。`
        : `当前 session 本来就没设过覆盖,跟随全局(${formatGlobal()})。`,
    );
    return;
  }

  if (value === 'off' || value === '0') {
    ctx.sessions.setIdleTimeoutMinutes(scope, 0);
    log.info('command', 'timeout-off', { scope, targeted: parsed.targeted });
    await reply(ctx, '✅ 已关闭当前 session 的探活。');
    return;
  }

  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    await reply(ctx, '❌ 用法:`/timeout <1-120>` / `/timeout off` / `/timeout default`');
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(scope, n);
  log.info('command', 'timeout-set', { scope, minutes: n, targeted: parsed.targeted });
  await reply(ctx, `✅ 当前 session 探活已设为 ${n} 分钟。`);
}

function parseTimeoutTarget(input: string, currentScope: string): {
  scope: string;
  value: string;
  targeted: boolean;
} {
  const parts = input.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (first.startsWith('comment:')) {
    return {
      scope: first,
      value: parts.slice(1).join(' '),
      targeted: true,
    };
  }
  return {
    scope: currentScope,
    value: input,
    targeted: false,
  };
}

async function handlePs(_args: string, ctx: CommandContext): Promise<void> {
  const live = readAndPrune();
  log.info('command', 'ps', { count: live.length });
  if (live.length === 0) {
    await reply(ctx, '当前没有 bot 在运行(理论上不可能,你正在跟其中之一对话…)');
    return;
  }

  const rows: string[] = [
    '| # | ID | Bot | 启动 |',
    '|---|---|---|---|',
  ];
  for (const [idx, e] of live.entries()) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const me = e.id === ctx.controls.processId ? ' ← 当前正在回复' : '';
    const bot = e.botName ? `${e.botName} (\`${e.appId}\`)` : `\`${e.appId}\``;
    rows.push(`| ${idx + 1} | \`${e.id}\`${me} | ${bot} | ${ago} |`);
  }
  const body = [
    `🧭 **当前有 ${live.length} 个 bot 在运行**`,
    '',
    rows.join('\n'),
    '',
    '用 `/exit <id|#>` 关掉某一个;`/exit ' + ctx.controls.processId + '` 关掉正在回复你的这个 bot。',
  ].join('\n');
  await reply(ctx, body);
}

async function handleExit(args: string, ctx: CommandContext): Promise<void> {
  const target = args.trim();
  if (!target) {
    await reply(
      ctx,
      '用法:`/exit <id|#>` —— `id` 是 `/ps` 显示的短 id,`#` 是序号。\n' +
        `当前正在回复你的是 \`${ctx.controls.processId}\`。`,
    );
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, `❌ 没找到匹配的 bot:\`${target}\`。发 \`/ps\` 看可选目标。`);
    return;
  }

  // Targeting ourselves — graceful disconnect + process.exit(0) via controls.
  if (entry.id === ctx.controls.processId) {
    log.info('command', 'exit-self', { id: entry.id });
    await reply(ctx, `👋 即将关闭当前 bot \`${entry.id}\`,再见。`);
    // Detach to give the reply send a chance to complete before we tear
    // down. controls.exit() awaits disconnect then process.exit().
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await ctx.controls.exit().catch(() => {});
    })();
    return;
  }

  // Targeting another process — SIGTERM and report back. We can't easily
  // wait for it to die without blocking the command handler; trust the
  // target's own signal handler to unregister + exit.
  log.info('command', 'exit-other', { id: entry.id, pid: entry.pid });
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    await reply(ctx, `❌ 关掉 bot \`${entry.id}\` 失败:${(err as Error).message}`);
    return;
  }
  // Brief grace before reporting.
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (stillAlive) {
    await reply(
      ctx,
      `📨 已请求关闭 \`${entry.id}\`,但还在收尾。再发 \`/ps\` 复查一下。`,
    );
  } else {
    await reply(ctx, `✓ 已关闭 bot \`${entry.id}\`。`);
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

async function handleReconnect(args: string, ctx: CommandContext): Promise<void> {
  const wait = args.trim().split(/\s+/).filter(Boolean).includes('--wait');
  log.info('command', 'reconnect', { wait });
  await reply(ctx, wait ? '⏳ 将在当前运行结束后重连…' : '⏳ 正在停止当前运行并重连…');
  let resumeNewRuns: (() => void) | undefined;
  try {
    resumeNewRuns = ctx.activeRuns.pauseNewRuns('reconnect-in-progress');
    if (wait) {
      await ctx.activeRuns.waitForAll();
    } else {
      await ctx.activeRuns.stopAll();
    }
    await ctx.controls.restart({ wait });
    log.info('command', 'reconnect-ok');
  } catch (err) {
    log.fail('command', err, { step: 'reconnect' });
    reportMetric('command_fail', 1, { step: 'reconnect' });
    await reply(ctx, `❌ 重连失败:${err instanceof Error ? err.message : String(err)}`);
  } finally {
    resumeNewRuns?.();
  }
}

const DOCTOR_ECHO_PROMPT =
  'Bridge doctor agent echo check. Do not inspect files, do not use history, and reply exactly: OK';
const DOCTOR_RATE_LIMIT_MS = 30_000;
const doctorInFlightProfiles = new Set<string>();
const doctorLastByOperator = new Map<string, number>();

async function handleDoctor(args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'doctor', {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode,
  });

  const rateKey = `${ctx.controls.profile}:${ctx.controls.configPath}:${ctx.msg.senderId}`;
  const now = Date.now();
  const last = doctorLastByOperator.get(rateKey);
  if (last !== undefined && now - last < DOCTOR_RATE_LIMIT_MS) {
    await reply(ctx, 'doctor rate limited: 同一用户 30 秒内只能触发一次。');
    return;
  }

  const requestedCwd = effectiveWorkspaceCwd(ctx);
  if (!requestedCwd) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck:
          '未设置工作目录。先用 `/cd <path>` 或 `/ws use <name>` 选择工作目录后再运行 agent echo check。',
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `${workspace.userVisible} 工作目录不可用时只执行 self-check，不启动 agent。`,
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  if (!ctx.runExecutor) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: 'run executor unavailable',
      }),
    );
    return;
  }

  const profileKey = ctx.controls.profile;
  if (doctorInFlightProfiles.has(profileKey)) {
    await reply(ctx, 'doctor in-flight: 当前 profile 已有诊断运行中。');
    return;
  }
  doctorLastByOperator.set(rateKey, now);

  const capability = agentCapability(ctx.controls.profileConfig);
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: ctx.msg.chatId,
      actorId: ctx.msg.senderId,
      ...(ctx.msg.threadId ? { threadId: ctx.msg.threadId } : {}),
    },
    attachments: [],
    prompt: DOCTOR_ECHO_PROMPT,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId),
    capability,
    profileConfig: ctx.controls.profileConfig,
    now,
    ttlMs: 60_000,
  });
  if (!policy.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: policy.rejectReason.userVisible,
      }),
    );
    return;
  }
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const doctorReport = (echoCheck: string): string =>
    buildDoctorReport(ctx, {
      workspaceCheck: `ok (${workspace.cwdRealpath})`,
      policyCheck:
        runtimeAccess.label === 'sandbox'
          ? `ok sandbox=${policy.sandbox}`
          : `ok ${runtimeAccess.label}=${policy.permissionMode}`,
      echoCheck,
    });

  // In group / topic chats other members would see the result card. Ack
  // in-channel, deliver the actual analysis privately to the operator's
  // open_id (Lark auto-opens the p2p chat with the bot).
  const isP2p = ctx.chatMode === 'p2p';
  if (!isP2p) {
    await reply(ctx, '🔍 已收到诊断请求，分析结果将私信发给你。');
  }

  doctorInFlightProfiles.add(profileKey);
  let execution: Awaited<ReturnType<RunExecutor['submit']>>;
  try {
    execution = await ctx.runExecutor.submit({
      scopeId: `${ctx.scope}:doctor`,
      policy,
      nowait: true,
      stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
      actor: { id: ctx.msg.senderId, ...(ctx.msg.senderName ? { name: ctx.msg.senderName } : {}) },
      observability: {
        profile: ctx.controls.profile,
        agent: capability.agentId,
        source: 'doctor',
        stage: 'agent-probe',
      },
    });
  } catch (err) {
    doctorInFlightProfiles.delete(profileKey);
    if (err instanceof RunRejected && err.code === 'pool-full') {
      await reply(ctx, doctorReport('pool-full'));
      return;
    }
    log.fail('command', err, { step: 'doctor.submit' });
    reportMetric('command_fail', 1, { step: 'doctor.submit' });
    await reply(ctx, doctorReport('failed'));
    return;
  }

  try {
    if (isP2p) {
      // Streaming card path — operator is the only viewer in p2p.
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(withDoctorReport(initialState, doctorReport('pending'))),
            producer: async (ctrl) => {
              let state: RunState = initialState;
              let echoText = '';
              const echoStatus = (): string => formatDoctorEchoStatus(echoText, state);
              const flush = (): Promise<void> =>
                ctrl.update(renderCard(withDoctorReport(state, doctorReport(echoStatus()))));
              for await (const evt of execution.subscribe()) {
                if (execution.handle.interrupted) break;
                // /doctor runs are session-less: skip 'system' so we don't
                // persist a doctor's sessionId over the user's real session.
                if (evt.type === 'system') continue;
                if (evt.type === 'usage') {
                  continue;
                }
                if (evt.type === 'text') echoText += evt.delta;
                if (evt.type === 'final_text') echoText = evt.content;
                state = reduce(state, evt);
                await flush();
                // Don't wait for stdout to close — some claude versions hang
                // briefly post-result, which would leave the for-await stuck.
                if (state.terminal !== 'running') break;
              }
              state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
            },
          },
        },
        { replyTo: ctx.msg.messageId },
      );
    } else {
      // Group / topic: buffer to completion, then DM the final card to the
      // operator. No live streaming — the group should see nothing past the
      // ack reply above.
      let state: RunState = initialState;
      let echoText = '';
      for await (const evt of execution.subscribe()) {
        if (execution.handle.interrupted) break;
        if (evt.type === 'system') continue;
        if (evt.type === 'usage') {
          continue;
        }
        if (evt.type === 'text') echoText += evt.delta;
        if (evt.type === 'final_text') echoText = evt.content;
        state = reduce(state, evt);
        if (state.terminal !== 'running') break;
      }
      state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      // Send a one-shot interactive card by open_id. Lark routes it to the
      // user's p2p chat with the bot (auto-creates it if needed); other
      // group members never see this payload.
      await ctx.channel.send(ctx.msg.senderId, {
        card: renderCard(
          withDoctorReport(state, doctorReport(formatDoctorEchoStatus(echoText, state))),
        ),
      });
    }
  } catch (err) {
    log.fail('command', err, { step: 'doctor' });
    reportMetric('command_fail', 1, { step: 'doctor' });
  } finally {
    doctorInFlightProfiles.delete(profileKey);
  }
}

function buildDoctorReport(
  ctx: CommandContext,
  opts: {
    workspaceCheck?: string;
    policyCheck?: string;
    echoCheck?: string;
  } = {},
): string {
  const queue = ctx.processPool?.snapshot();
  const queueLine = queue
    ? `${queue.active}/${queue.cap} active, ${queue.waiting} waiting`
    : 'unknown';
  const cwd = effectiveWorkspaceCwd(ctx);
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const access =
    ctx.msg.chatType === 'p2p'
      ? canUseDm(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId)
      : canUseGroup(
          ctx.controls.profileConfig,
          ctx.controls,
          ctx.msg.chatId,
          ctx.msg.senderId,
        );
  return [
    'self-check: ok',
    `profile: ${ctx.controls.profile}`,
    `agent: ${ctx.agent.displayName} (${ctx.controls.profileConfig.agentKind})`,
    `workspace: ${cwd ?? '(未设置)'}`,
    `workspace default: ${ctx.controls.profileConfig.workspaces.default ? 'set' : 'missing'}`,
    `${runtimeAccess.label}: ${runtimeAccess.value}`,
    `access: ${access.ok ? 'ok' : 'denied'} (${access.reason})`,
    `owner API: ${formatOwnerState(ctx)}`,
    `queue: ${queueLine}`,
    `run executor: ${ctx.runExecutor ? 'available' : 'unavailable'}`,
    ...(opts.workspaceCheck ? [`workspace check: ${opts.workspaceCheck}`] : []),
    ...(opts.policyCheck ? [`policy check: ${opts.policyCheck}`] : []),
    ...(opts.echoCheck ? [`agent echo check: ${opts.echoCheck}`] : []),
  ].join('\n');
}

function withDoctorReport(state: RunState, report: string): RunState {
  return {
    ...state,
    blocks: [{ kind: 'text', content: report, streaming: false }, ...state.blocks],
  };
}

function formatDoctorEchoStatus(echoText: string, state: RunState): string {
  const trimmed = echoText.trim();
  if (trimmed) return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  if (state.terminal === 'running') return 'pending';
  if (state.terminal === 'done') return 'empty';
  return state.terminal;
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard(ctx.agent.displayName);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

// ─── /usage ───────────────────────────────────────────────────────────────

/**
 * Plan quota, answered by the bridge itself through `claude -p /usage`: no
 * agent run, so it costs no quota and still answers while a run is busy or
 * stuck.
 */
async function handleUsage(args: string, ctx: CommandContext): Promise<void> {
  const key = args.trim().toLowerCase();
  // `/usage` keeps answering the plan quota; a period asks for the
  // per-person consumption ledger instead.
  if (key && key !== 'quota') return handleUsageLedger(key, ctx);
  return handlePlanQuota(ctx);
}

async function handlePlanQuota(ctx: CommandContext): Promise<void> {
  // The plan quota of whoever runs the bridge, not something to show anyone
  // else; their own consumption is open to all (`/usage today`).
  if (!canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '订阅额度仅管理员可看。看自己的用量请发 `/usage today`（或 week / month）。');
    return;
  }
  if (!agentDescriptor(ctx.controls.profileConfig.agentKind).planQuota) {
    await reply(ctx, '`/usage` 目前只支持 Claude profile。');
    return;
  }
  let raw: string;
  try {
    raw = await readClaudeUsage();
  } catch (err) {
    log.fail('command', err, { cmd: '/usage' });
    await reply(ctx, `❌ 读取额度失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const accounts = await agentAccountsReport(ctx.controls.profileConfig, commandProfilePaths(ctx).profileDir);
  const body = usageMarkdown(parseClaudeUsage(raw), raw);
  const card = usageCard(
    accounts ? [`**CLI 登录账户**`, body, '', ...accounts, '_各账户用量取自它最近一次运行的报告。_'].join('\n') : body,
  );
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

// ─── /accounts ────────────────────────────────────────────────────────────

/**
 * The profile's Claude subscription accounts: `/accounts` lists them as a
 * table (usage, resets, switch lines); `/accounts switch [name]` makes one the
 * main account — the best-scoring one with room when no name is given.
 */
async function handleAccounts(args: string, ctx: CommandContext): Promise<void> {
  const [sub = '', ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const profileDir = commandProfilePaths(ctx).profileDir;
  try {
    if (sub === '' || sub === 'list') {
      const table = await agentAccountsTable(ctx.controls.profileConfig, profileDir);
      await reply(ctx, table ?? '`/accounts` 目前只支持 Claude profile。');
      return;
    }
    if (sub === 'switch' || sub === '切换') {
      await reply(ctx, await switchAgentAccount(ctx.controls.profileConfig, profileDir, rest.join(' ')));
      return;
    }
  } catch (err) {
    log.fail('command', err, { cmd: '/accounts', sub });
    await reply(ctx, `❌ ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await reply(ctx, '用法：`/accounts` 查看账户；`/accounts switch` 自动切到得分最高的可用账户；`/accounts switch <名字或 id>` 切到指定账户（它要在切换线以下，否则不切）；`/accounts switch <名字或 id> <百分比>` 同时把它的切换线临时调到该值，到该窗口重置或自动切走后恢复原线。');
}

// ─── /coffee ──────────────────────────────────────────────────────────────

const USAGE_PERIODS: Record<string, { days: number; label: string }> = {
  today: { days: 1, label: '今天' },
  week: { days: 7, label: '近 7 天' },
  month: { days: 30, label: '近 30 天' },
};

/**
 * `/usage today|week|month`: whose runs consumed how much of the owner's
 * agent quota. Everyone sees their own numbers; only an admin in a private
 * chat sees everyone's, so one chat never learns another person's usage.
 */
async function handleUsageLedger(args: string, ctx: CommandContext): Promise<void> {
  const ledger = ctx.controls.usage;
  if (!ledger) {
    await reply(ctx, '当前 profile 没有开启用量统计。');
    return;
  }
  const key = args.trim().toLowerCase();
  if (key && !USAGE_PERIODS[key]) {
    await reply(ctx, '用法：`/usage` 看订阅额度；`/usage today|week|month` 看各人用量。');
    return;
  }
  const periods = key ? [USAGE_PERIODS[key]!] : [USAGE_PERIODS.today!, USAGE_PERIODS.week!];
  const everyone =
    ctx.chatMode === 'p2p' &&
    canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok;
  const sections = periods.map((period) => {
    const rows = ledger.report({ days: period.days, ...(everyone ? {} : { actorId: ctx.msg.senderId }) });
    return formatUsageSection(period.label, rows, { everyone, selfId: ctx.msg.senderId });
  });
  const notes = [
    '_费用是按 API 价格估算的；订阅账号不实际扣费，只用来比较各人占用额度的多少。Codex 不报费用，只看 token。_',
    ...(ctx.chatMode !== 'p2p' && !everyone ? ['_只显示你自己的用量；管理员私聊发 `/usage` 可看所有人。_'] : []),
  ];
  await reply(ctx, [...sections, ...notes].join('\n\n'));
}

function formatUsageSection(
  label: string,
  rows: UsageReportRow[],
  opts: { everyone: boolean; selfId: string },
): string {
  if (rows.length === 0) return `**${label}**\n暂无用量记录。`;
  const total = rows.reduce((acc, row) => {
    acc.turns += row.total.turns;
    acc.inputTokens += row.total.inputTokens;
    acc.cachedInputTokens += row.total.cachedInputTokens;
    acc.outputTokens += row.total.outputTokens;
    acc.costUsd += row.total.costUsd;
    return acc;
  }, emptyTotals());
  if (!opts.everyone) return `**${label}**\n你：${formatUsageTotals(total)}`;
  const shown = rows.slice(0, 10).map((row, i) => {
    const who = row.actorId === opts.selfId ? '你' : (row.actorName ?? `…${row.actorId.slice(-6)}`);
    return `${i + 1}. ${who}：${formatUsageTotals(row.total)}`;
  });
  const more = rows.length > 10 ? [`…另有 ${rows.length - 10} 人`] : [];
  return [`**${label}**（${rows.length} 人）`, `合计：${formatUsageTotals(total)}`, ...shown, ...more].join('\n');
}

function formatUsageTotals(t: UsageTotals): string {
  const cached = t.cachedInputTokens > 0 ? `（缓存 ${formatTokens(t.cachedInputTokens)}）` : '';
  const cost = t.costUsd > 0 ? ` · 估算 $${t.costUsd.toFixed(2)}` : '';
  return `${t.turns} 轮 · 输入 ${formatTokens(t.inputTokens)}${cached} · 输出 ${formatTokens(t.outputTokens)}${cost}`;
}

/**
 * `approval.allow|allowturn|deny <id>` from an approval card. Allowing needs
 * an admin; the requester may cancel (deny) their own pending step. A click
 * that changes something gets no reply — the cards themselves update.
 */
async function handleApproval(args: string, ctx: CommandContext): Promise<void> {
  const [verb, id] = args.trim().split(/\s+/);
  const action = verb === 'allow' ? 'allow' : verb === 'allowturn' ? 'allow-turn' : verb === 'deny' ? 'deny' : undefined;
  const broker = ctx.controls.approvals;
  if (!broker || !action || !id) return;
  const isAdmin = canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok;
  const result = broker.decide(id, ctx.msg.senderId, action, isAdmin);
  log.info('command', 'approval', { action, result, operator: ctx.msg.senderId.slice(-6) });
  if (result === 'forbidden') {
    await reply(ctx, action === 'deny' ? '只有发起人或管理员可以取消这一步。' : '只有管理员可以允许这一步。');
  } else if (result === 'not-found') {
    await reply(ctx, '这条审批已经处理过或已过期。');
  }
}

const AUDIT_EVENT_LABELS: Record<string, string> = {
  allowed: '已允许',
  'auto-allowed': '本轮已允许',
  'config-allowed': '免审批清单',
  denied: '已拒绝',
  timeout: '超时拒绝',
  cancelled: '已取消',
};

/**
 * `/practice` — 课堂精练. Admin-only and DM-only: a run reads every chat's
 * conversations, and its drafts and diffs can carry any of them. The chat only
 * ever sees counts and PR links; `diff` is the one view of draft content.
 */
async function handleDream(args: string, ctx: CommandContext): Promise<void> {
  if (ctx.chatMode !== 'p2p') {
    await reply(ctx, '课堂精练涉及所有会话的内容，请私聊 bot 发送 `/practice`。');
    return;
  }
  const dream = ctx.controls.dream;
  if (!dream) {
    await reply(ctx, '当前 bridge 没有启用课堂精练（缺少 profile 数据目录或知识库）。');
    return;
  }
  const [sub = '', ...rest] = args.trim().split(/\s+/);
  switch (sub) {
    case '':
    case 'status':
      await reply(ctx, formatDreamStatus(await dream.status()));
      return;
    case 'run': {
      const actor = { id: ctx.msg.senderId, ...(ctx.msg.senderName ? { name: ctx.msg.senderName } : {}) };
      const started = await dream.start(actor, (run) => {
        void reply(ctx, formatDreamRun(run));
      });
      await reply(
        ctx,
        'error' in started
          ? `❌ ${started.error}`
          : `📚 已开始整理，批次 \`${started.run.id}\`。${getDream(ctx.controls.cfg)?.external.length ? '先做课前学习，再' : ''}读取已结束的会话、生成草稿并${getDream(ctx.controls.cfg)?.publish === 'push' ? '直接提交推送（写更新日志）' : '开 Draft PR'}，完成后在这里回复结果；\`/practice cancel\` 可以取消。`,
      );
      return;
    }
    case 'cancel':
      await reply(ctx, dream.cancel() ? '⏹ 已请求取消，当前步骤结束后停止；游标不会移动。' : '现在没有在进行的整理。');
      return;
    case 'prs':
      await reply(ctx, formatDreamPrs(await dream.pullRequests()));
      return;
    case 'revert': {
      if (!rest[0]) {
        await reply(ctx, '用法：`/practice revert <批次>`，批次号见 `/practice prs`。');
        return;
      }
      const result = await dream.revert(rest[0]);
      await reply(ctx, 'error' in result ? `❌ ${result.error}` : formatDreamRevert(result));
      return;
    }
    case 'diary': {
      const result = dream.diary(rest[0]);
      await reply(ctx, 'error' in result ? result.error : `**🌙 梦境日记**\n\n${result.diary.replace(/^## /, '### ')}`);
      return;
    }
    case 'diff': {
      const result = await dream.diff(rest[0]);
      if ('error' in result) {
        await reply(ctx, result.error);
        return;
      }
      const fence = '```';
      const body = result.parts
        .map((part) => `**${part.label}**\n${fence}diff\n${clipDiff(part.diff, 6000).replaceAll(fence, "'''")}\n${fence}`)
        .join('\n\n');
      await reply(ctx, `**📚 批次 \`${result.id}\` 的差异**\n\n${body}`);
      return;
    }
    default:
      await reply(
        ctx,
        [
          '**📚 课堂精练**',
          '',
          '`/practice` — 状态：开关、目标仓库、上次结果、待审核 PR 数',
          '`/practice run` — 立即整理：先学配置的外部库（课前学习），再读取已结束的会话，生成记忆 / 笔记 / skill 草稿并发布',
          '`/practice cancel` — 取消正在进行的整理',
          '`/practice prs` — 整理开出的 PR 及审核状态',
          '`/practice diff [批次]` — 查看某个批次的差异（默认最近一次）',
          '`/practice diary [批次]` — 梦境日记：这一轮读了什么、归纳出什么主题、写进 / 整合 / 归档了什么、多少没采纳（默认最近一次）',
          '`/practice revert <批次>` — 撤销一个已合并的批次（开一个撤销用的 Draft PR）',
          '',
          '默认以 Draft PR 发布、审核合并后才生效；配置文件里 `dreamTuning.publish: "push"` 改为直接提交推送并写 CHANGELOG.md。「课堂精练」「自动整理」两个开关在 `/config` 里。',
          '自动整理默认不按天跑：新内容攒够、距上次够久、上一批 PR 审完、在允许时段且没有别的任务时才跑；设了 `dreamTuning.dailyAt` 就每天定时跑。用户消息一来就让路。',
        ].join('\n'),
      );
  }
}

function clipDiff(diff: string, max: number): string {
  return diff.length > max ? `${diff.slice(0, max)}\n… (已截断，完整内容见 PR)` : diff;
}

/**
 * `/audit [N]`: the latest side-effecting steps (commands, file writes,
 * external tools) and approval decisions, newest first. Private chat only —
 * it spans every chat of the profile.
 */
async function handleAudit(args: string, ctx: CommandContext): Promise<void> {
  if (ctx.chatMode !== 'p2p') {
    await reply(ctx, '审计记录涉及所有会话，请私聊 bot 发送 `/audit` 查看。');
    return;
  }
  const audit = ctx.controls.audit;
  if (!audit) {
    await reply(ctx, '当前 profile 没有开启审计记录。');
    return;
  }
  const n = Number.parseInt(args.trim(), 10);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 20;
  const entries = (await audit.query({ limit: limit * 3 }))
    .filter((e) => e.kind === 'tool' || (e.event && e.event in AUDIT_EVENT_LABELS))
    .slice(0, limit);
  if (entries.length === 0) {
    await reply(ctx, '还没有审计记录。');
    return;
  }
  const chats = new Map((ctx.controls.knownChats ?? []).map((c) => [c.id, c.name]));
  const lines = entries.map((e) => {
    const d = new Date(e.at);
    const pad = (x: number): string => String(x).padStart(2, '0');
    const when = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const who = e.actorId === ctx.msg.senderId ? '你' : (e.actorName ?? `…${e.actorId.slice(-6)}`);
    const where = e.chatId ? (chats.get(e.chatId) ?? '会话') : e.source;
    const what = `${toolLabel(e.tool)} \`${e.summary.replace(/`/g, "'").slice(0, 80)}\``;
    const outcome =
      e.kind === 'approval'
        ? ` · ${AUDIT_EVENT_LABELS[e.event!]}`
        : e.gated
          ? ' · 非管理员会话'
          : '';
    return `- ${when} ${who}（${where}）${what}${outcome}`;
  });
  await reply(ctx, [`**最近 ${entries.length} 条操作记录**`, ...lines].join('\n'));
}

async function handleCoffee(_args: string, ctx: CommandContext): Promise<void> {
  await ctx.channel.send(ctx.msg.chatId, { card: coffeeCard() }, commandReplyOptions(ctx));
}

// ─── git: /diff, /worktree, /pr ───────────────────────────────────────────

/**
 * Git summary for the `/status` card. Silent when the cwd is not a repository
 * (or git is missing) — `/status` must stay useful for non-code workspaces.
 */
async function gitStatusLine(cwd: string | undefined): Promise<{ git?: string }> {
  if (!cwd) return {};
  const status = await readRepoStatus(cwd).catch(() => undefined);
  return status ? { git: describeRepoStatus(status) } : {};
}

/** Resolve the repo the current session points at, or reply why we cannot. */
async function requireRepo(
  ctx: CommandContext,
): Promise<{ cwd: string; status: GitRepoStatus } | undefined> {
  const cwd = effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '当前会话没有工作目录，先用 `/cd <路径>` 指一个。');
    return undefined;
  }
  const status = await readRepoStatus(cwd).catch(() => undefined);
  if (!status) {
    await reply(ctx, `\`${cwd}\` 不是 git 仓库（或本机没有装 git）。`);
    return undefined;
  }
  return { cwd, status };
}

async function handleDiff(args: string, ctx: CommandContext): Promise<void> {
  const repo = await requireRepo(ctx);
  if (!repo) return;

  const target = parseDiffTarget(args);
  if (isGitError(target)) {
    await reply(ctx, `❌ ${target.error}`);
    return;
  }

  const summary = await readDiffStat(repo.cwd, target);
  if (isGitError(summary)) {
    await reply(ctx, `❌ ${summary.error}`);
    return;
  }

  const patch = await readDiffPatch(repo.cwd, target);
  const patchText = isGitError(patch) ? '' : patch.patch;
  const preview = previewPatch(patchText);
  // Anything that did not fit inline goes out as a real .patch file — reading a
  // long diff as chat text is hopeless, and the file can be opened elsewhere.
  const attach = preview.omittedLines > 0 && patchText.length > 0;

  await ctx.channel.send(
    ctx.msg.chatId,
    {
      card: diffCard({
        scope: describeDiffTarget(target),
        files: summary.files,
        added: summary.added,
        removed: summary.removed,
        untracked: summary.untracked,
        preview: preview.text,
        omittedLines: preview.omittedLines,
        attached: attach,
      }),
    },
    commandReplyOptions(ctx),
  );

  if (!attach) return;
  const name = `${basename(repo.status.root)}-${target.kind === 'ref' ? target.ref.replace(/[^\w.-]+/g, '-') : target.kind}.patch`;
  await ctx.channel
    .send(
      ctx.msg.chatId,
      { file: { source: Buffer.from(patchText, 'utf8'), fileName: name } },
      commandReplyOptions(ctx),
    )
    .catch(async (err: unknown) => {
      log.warn('git', 'patch-upload-failed', { err: String(err) });
      await reply(ctx, '完整 patch 发送失败，可以在本地用 `git diff` 查看。');
    });
}

async function handleWorktree(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();
  const [sub = '', ...rest] = trimmed.split(/\s+/);
  switch (sub) {
    case '':
    case 'list':
      return worktreeList(ctx);
    case 'add':
      return worktreeAdd(rest[0] ?? '', rest[1], ctx);
    case 'use':
      return worktreeUse(rest.join(' '), ctx);
    case 'remove':
    case 'rm':
      return worktreeRemove(rest.filter((token) => token !== '--force').join(' '), rest.includes('--force'), ctx);
    default:
      await reply(
        ctx,
        [
          '**worktree**',
          '',
          '`/worktree` — 列出当前仓库的 worktree',
          '`/worktree add <分支> [起点]` — 新建 worktree 并把本会话切过去',
          '`/worktree use <分支|路径>` — 切到已有的 worktree',
          '`/worktree remove <分支|路径> [--force]` — 删除',
        ].join('\n'),
      );
  }
}

async function worktreeList(ctx: CommandContext): Promise<void> {
  const repo = await requireRepo(ctx);
  if (!repo) return;
  const entries = await listWorktrees(repo.cwd);
  if (isGitError(entries)) {
    await reply(ctx, `❌ ${entries.error}`);
    return;
  }
  await ctx.channel.send(
    ctx.msg.chatId,
    {
      card: worktreeCard(
        entries.map((entry) => ({
          path: entry.path,
          ...(entry.branch ? { branch: entry.branch } : {}),
          ...(entry.head ? { head: entry.head } : {}),
          main: entry.main,
          current: entry.path === repo.status.root,
        })),
      ),
    },
    commandReplyOptions(ctx),
  );
}

async function worktreeAdd(branch: string, base: string | undefined, ctx: CommandContext): Promise<void> {
  if (!branch) {
    await reply(ctx, '用法：`/worktree add <分支> [起点]`');
    return;
  }
  const repo = await requireRepo(ctx);
  if (!repo) return;

  const created = await addWorktree({
    cwd: repo.cwd,
    repoRoot: repo.status.root,
    branch,
    ...(base ? { base } : {}),
  });
  if (isGitError(created)) {
    await reply(ctx, `❌ 新建 worktree 失败：${created.error}`);
    return;
  }

  ctx.workspaces.trackWorktree({
    repoRoot: repo.status.root,
    path: created.path,
    branch: created.branch,
    ownedBranch: !created.existingBranch,
  });

  // Creating a worktree for a task and then working in the old directory is
  // never what anyone means, so the session moves with it — same as `/cd`.
  const resolved = await resolveWorkingDirectory(created.path);
  if (!resolved.ok) {
    await reply(ctx, `worktree 已创建在 \`${created.path}\`，但切换失败：${resolved.userVisible}`);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, resolved.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  log.info('git', 'worktree-added', { scope: ctx.scope, branch: created.branch });
  await reply(
    ctx,
    [
      `🌿 已创建 worktree 并切过去：`,
      `- 分支：\`${created.branch}\`${created.existingBranch ? '（已存在的分支）' : '（新建分支）'}`,
      `- 路径：\`${resolved.cwdRealpath}\``,
      '',
      '会话已重置，接下来的对话都在这个 worktree 里。',
    ].join('\n'),
  );
}

async function worktreeUse(needle: string, ctx: CommandContext): Promise<void> {
  if (!needle) {
    await reply(ctx, '用法：`/worktree use <分支|路径>`');
    return;
  }
  const repo = await requireRepo(ctx);
  if (!repo) return;
  const entries = await listWorktrees(repo.cwd);
  if (isGitError(entries)) {
    await reply(ctx, `❌ ${entries.error}`);
    return;
  }
  const match = matchWorktree(entries, needle);
  if (!match) {
    await reply(ctx, `没找到叫 \`${needle}\` 的 worktree，用 \`/worktree\` 看看列表。`);
    return;
  }
  const resolved = await resolveWorkingDirectory(match.path);
  if (!resolved.ok) {
    await reply(ctx, resolved.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, resolved.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切到 \`${resolved.cwdRealpath}\`（分支 \`${match.branch ?? '游离'}\`），会话已重置。`);
}

async function worktreeRemove(needle: string, force: boolean, ctx: CommandContext): Promise<void> {
  if (!needle) {
    await reply(ctx, '用法：`/worktree remove <分支|路径> [--force]`');
    return;
  }
  const repo = await requireRepo(ctx);
  if (!repo) return;
  const entries = await listWorktrees(repo.cwd);
  if (isGitError(entries)) {
    await reply(ctx, `❌ ${entries.error}`);
    return;
  }
  const match = matchWorktree(entries, needle);
  if (!match) {
    await reply(ctx, `没找到叫 \`${needle}\` 的 worktree。`);
    return;
  }
  if (match.main) {
    await reply(ctx, '这是主 checkout，不能删。');
    return;
  }
  // Removing the tree the session is standing in would leave every later run
  // pointing at a path that no longer exists.
  if (match.path === repo.status.root) {
    await reply(ctx, '当前会话正在这个 worktree 里，先 `/worktree use <别的>` 或 `/cd` 出去再删。');
    return;
  }
  const removed = await removeWorktree(repo.cwd, match.path, { force });
  if (isGitError(removed)) {
    await reply(ctx, `❌ 删除失败：${removed.error}${force ? '' : '\n有未提交改动时可以加 `--force`。'}`);
    return;
  }
  ctx.workspaces.forgetWorktree(match.path);
  log.info('git', 'worktree-removed', { scope: ctx.scope, path: match.path });
  await reply(ctx, `🗑 已删除 worktree \`${match.path}\`。`);
}

async function handlePr(args: string, ctx: CommandContext): Promise<void> {
  const repo = await requireRepo(ctx);
  if (!repo) return;
  const lookup = parsePrArg(args);
  if (isGitError(lookup)) {
    await reply(ctx, `❌ ${lookup.error}`);
    return;
  }
  const pr = await readPullRequest(repo.cwd, lookup);
  if (isGitError(pr)) {
    await reply(ctx, `❌ ${pr.error}`);
    return;
  }
  await ctx.channel.send(
    ctx.msg.chatId,
    {
      card: pullRequestCard({
        ...pr,
        checksLabel: checksLabel(pr.checks),
        failingChecks: pr.checks.failing,
        reviewLabel: reviewLabel(pr.reviewDecision),
      }),
    },
    commandReplyOptions(ctx),
  );
}

// ─── knowledge: /memory, /skills, /knowledge ──────────────────────────────

function requireKnowledge(ctx: CommandContext): KnowledgeStore | undefined {
  return ctx.controls.knowledge;
}

/** Knowledge summary for the `/status` card; silent when the store is absent. */
async function knowledgeStatusLine(ctx: CommandContext): Promise<{ knowledge?: string }> {
  const store = ctx.controls.knowledge;
  if (!store) return {};
  try {
    const [chat, profile, skills, repo] = await Promise.all([
      store.listMemories({ kind: 'chat', scopeId: ctx.scope }),
      store.listMemories({ kind: 'profile' }),
      store.listSkills(),
      knowledgeRepoStatus(store),
    ]);
    if (chat.length + profile.length + skills.length === 0 && !repo) return {};
    const sync = repo?.upstream
      ? `同步 ↑${repo.upstream.ahead} ↓${repo.upstream.behind}`
      : repo
        ? '未绑定远端'
        : '未启用同步';
    return {
      knowledge: `记忆 ${chat.length}(本会话)/${profile.length}(全局) · skills ${skills.length} · ${sync}`,
    };
  } catch (err) {
    log.warn('knowledge', 'status-line-failed', { err: String(err) });
    return {};
  }
}

async function handleMemory(args: string, ctx: CommandContext): Promise<void> {
  const store = requireKnowledge(ctx);
  if (!store) {
    await reply(ctx, '当前 bridge 没有启用知识库（缺少 profile 数据目录）。');
    return;
  }
  const trimmed = args.trim();
  const [sub = '', ...rest] = trimmed.split(/\s+/);
  const restText = trimmed.slice(sub.length).trim();

  switch (sub) {
    case '':
    case 'list':
      return memoryList(ctx, store);
    case 'add':
      return memoryAdd(restText, ctx, store);
    case 'forget':
    case 'rm':
      return memoryForget(rest[0] ?? '', ctx, store);
    case 'clear':
      return memoryClear(restText, ctx, store);
    default:
      await reply(
        ctx,
        [
          '**记忆**',
          '',
          '`/memory` — 看当前生效的记忆',
          '`/memory add <内容>` — 记到本会话',
          '`/memory add --global <内容>` — 记到全局（管理员）',
          '`/memory forget <id>` — 删一条',
          '`/memory clear [--global]` — 清空一个范围',
        ].join('\n'),
      );
  }
}

async function memoryList(ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  const [chat, profile] = await Promise.all([
    store.listMemories({ kind: 'chat', scopeId: ctx.scope }),
    store.listMemories({ kind: 'profile' }),
  ]);
  await ctx.channel.send(
    ctx.msg.chatId,
    { card: memoryCard({ chat, profile, dir: store.dir }) },
    commandReplyOptions(ctx),
  );
}

async function memoryAdd(args: string, ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  const global = /^--global\b/.test(args);
  const text = global ? args.replace(/^--global\b/, '').trim() : args.trim();
  if (!text) {
    await reply(ctx, '用法：`/memory add <要记住的内容>`（加 `--global` 记到全局）');
    return;
  }
  // Global memory reaches every chat this profile serves, so it is an admin
  // action; a note about the current conversation is not.
  if (global && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '❌ 全局记忆仅管理员可写，去掉 `--global` 可以记到本会话。');
    return;
  }

  const scope: MemoryScope = global ? { kind: 'profile' } : { kind: 'chat', scopeId: ctx.scope };
  const entry = await store.addMemory(scope, text);
  log.info('knowledge', 'memory-added', { scope: global ? 'profile' : ctx.scope, id: entry.id });
  await reply(
    ctx,
    `🧠 已记住（${global ? '全局' : '本会话'}）：${entry.text}\n\n\`/memory forget ${entry.id}\` 可以撤销。`,
  );
}

async function memoryForget(id: string, ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  if (!id) {
    await reply(ctx, '用法：`/memory forget <id>`（id 在 `/memory` 列表里）');
    return;
  }
  if (await store.removeMemory({ kind: 'chat', scopeId: ctx.scope }, id)) {
    await reply(ctx, `🗑 已删除本会话记忆 \`${id}\`。`);
    return;
  }
  // Falling through to profile scope only for admins keeps a group member from
  // deleting a global rule by guessing an id.
  if (canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    if (await store.removeMemory({ kind: 'profile' }, id)) {
      await reply(ctx, `🗑 已删除全局记忆 \`${id}\`。`);
      return;
    }
  }
  await reply(ctx, `没找到 \`${id}\`。`);
}

async function memoryClear(args: string, ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  const global = /^--global\b/.test(args.trim());
  if (global && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '❌ 全局记忆仅管理员可改。');
    return;
  }
  const scope: MemoryScope = global ? { kind: 'profile' } : { kind: 'chat', scopeId: ctx.scope };
  const removed = await store.clearMemories(scope);
  await reply(ctx, removed === 0 ? '本来就没有记忆。' : `🗑 已清空 ${removed} 条${global ? '全局' : '本会话'}记忆。`);
}

async function handleSkills(args: string, ctx: CommandContext): Promise<void> {
  const store = requireKnowledge(ctx);
  if (!store) {
    await reply(ctx, '当前 bridge 没有启用知识库（缺少 profile 数据目录）。');
    return;
  }
  const trimmed = args.trim();
  const [sub = '', ...rest] = trimmed.split(/\s+/);

  if (sub === 'lib' || sub === 'libs') {
    return handleSkillLibraries(trimmed.slice(sub.length).trim(), ctx, store);
  }

  if (sub === 'show' || sub === 'cat') {
    const name = rest.join(' ').trim();
    const skill = name ? await store.readSkill(name) : undefined;
    if (!skill) {
      await reply(ctx, `没找到 skill \`${name || '(未指定)'}\`，用 \`/skills\` 看看列表。`);
      return;
    }
    const body = skill.body.length > 3000 ? `${skill.body.slice(0, 3000)}\n\n…（截断，完整内容见 ${skill.summary.path}）` : skill.body;
    await reply(ctx, body);
    return;
  }

  const skills = await store.listSkills();
  await ctx.channel.send(
    ctx.msg.chatId,
    {
      card: skillsCard(
        skills.map(({ name, description, source }) => ({ name, description, ...(source ? { source } : {}) })),
        store.skillsDir,
      ),
    },
    commandReplyOptions(ctx),
  );
}

// ─── /skills lib: shared skill libraries ──────────────────────────────────

const SKILL_LIB_HELP = [
  '**Skill 库**（管理员）',
  '',
  '`/skills lib` — 已配置的库、同步状态、各自载入的 skill',
  '`/skills lib add <git 地址> [名字] [--ref 分支/标签/提交] [--path 子目录] [--only a,b] [--exclude a,b]` — 加一个库并立即拉取',
  '`/skills lib sync [名字]` — 立即同步（不写名字就是全部）',
  '`/skills lib rm <名字>` — 移除，本地镜像一起删掉',
  '',
  '库是 git 仓库的只读镜像：skill 放在 `skills/<名字>/SKILL.md`（没有 `skills/` 就在仓库根目录找），同名时本 profile 自己的 skill 优先、先加的库优先。私有仓库用本机已配好的 SSH key 访问，不要把 token 写进地址。',
].join('\n');

async function handleSkillLibraries(args: string, ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  // A library feeds instructions straight into every run of this profile and
  // makes the host fetch from an arbitrary URL — same level as /knowledge.
  if (!canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '❌ skill 库仅管理员可管理；`/skills` 可以查看已载入的 skill。');
    return;
  }
  const libraries = ctx.controls.skillLibraries;
  if (!libraries) {
    await reply(ctx, '当前 bridge 没有启用 skill 库（缺少 profile 数据目录）。');
    return;
  }
  const [sub = '', ...rest] = args.split(/\s+/).filter(Boolean);
  switch (sub) {
    case '':
    case 'list':
    case 'status':
      return skillLibraryList(ctx, store, libraries);
    case 'add':
      return skillLibraryAdd(rest, ctx, store, libraries);
    case 'sync':
    case 'pull':
      return skillLibrarySync(rest[0], ctx, libraries);
    case 'rm':
    case 'remove':
      return skillLibraryRemove(rest[0] ?? '', ctx, libraries);
    default:
      await reply(ctx, SKILL_LIB_HELP);
  }
}

function configuredLibraries(ctx: CommandContext): SkillLibraryConfig[] {
  return ctx.controls.profileConfig.skills?.libraries ?? [];
}

async function skillLibraryList(
  ctx: CommandContext,
  store: KnowledgeStore,
  libraries: SkillLibraries,
): Promise<void> {
  const [statuses, merged] = await Promise.all([libraries.status(), store.listSkills()]);
  const now = Date.now();
  await ctx.channel.send(
    ctx.msg.chatId,
    {
      card: skillLibrariesCard(
        statuses.map((status) => ({
          name: status.config.name,
          url: maskUrlCredentials(status.config.url),
          ...(status.config.ref ? { ref: status.config.ref } : {}),
          ...(status.config.path ? { path: status.config.path } : {}),
          ...(status.config.include ? { include: status.config.include } : {}),
          ...(status.config.exclude ? { exclude: status.config.exclude } : {}),
          present: status.present,
          ...(status.commit ? { commit: status.commit } : {}),
          ...(status.commitAt ? { commitAgo: formatAgo(now - status.commitAt) } : {}),
          ...(status.lastSyncAt ? { lastSyncAgo: formatAgo(now - status.lastSyncAt) } : {}),
          ...(status.lastError ? { lastError: status.lastError } : {}),
          skills: status.skills.map((skill) => skill.name),
          shadowed: shadowedSkills(status, merged),
        })),
        getSkillSyncIntervalMinutes(ctx.controls.profileConfig.skills),
      ),
    },
    commandReplyOptions(ctx),
  );
}

type ParsedLibraryAdd = { library: SkillLibraryConfig } | { error: string };

/** `<url> [name] [--ref x] [--path x] [--only a,b] [--exclude a,b] [--name x]`. */
function parseLibraryAdd(tokens: string[], taken: Set<string>): ParsedLibraryAdd {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const flag = /^--(ref|path|only|include|exclude|name)(?:=(.*))?$/.exec(token);
    if (flag) {
      const value = flag[2] ?? tokens[i + 1];
      if (flag[2] === undefined) i += 1;
      if (!value) return { error: `\`--${flag[1]}\` 后面缺少值。` };
      flags[flag[1] === 'include' ? 'only' : flag[1]!] = value;
      continue;
    }
    if (token.startsWith('--')) return { error: `不认识的参数 \`${token}\`。` };
    positional.push(token);
  }
  const url = positional[0] ?? '';
  if (!url) return { error: '用法：`/skills lib add <git 地址> [名字]`' };
  const list = (value: string | undefined) => value?.split(',');
  return buildLibraryConfig(
    {
      url,
      name: flags.name ?? positional[1],
      ref: flags.ref,
      path: flags.path,
      include: list(flags.only),
      exclude: list(flags.exclude),
    },
    taken,
  );
}

async function skillLibraryAdd(
  tokens: string[],
  ctx: CommandContext,
  store: KnowledgeStore,
  libraries: SkillLibraries,
): Promise<void> {
  const parsed = parseLibraryAdd(tokens, new Set(configuredLibraries(ctx).map((library) => library.name)));
  if (!('library' in parsed)) {
    await reply(ctx, `❌ ${parsed.error}\n\n${SKILL_LIB_HELP}`);
    return;
  }
  const library = parsed.library;

  // Fetch first and only then save: a library that cannot be pulled never
  // lands in the configuration.
  const result = await libraries.syncLibrary(library);
  if (!result.ok) {
    await reply(ctx, `❌ 拉取 \`${library.name}\` 失败：${result.error ?? '未知错误'}`);
    return;
  }
  try {
    await configOps.saveSkillsConfig(ctx.controls, (skills) => ({
      ...skills,
      libraries: [...skills.libraries.filter((item) => item.name !== library.name), library],
    }));
  } catch (err) {
    await libraries.remove(library.name).catch(() => undefined);
    await reply(ctx, `❌ 保存配置失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  log.info('skills', 'library-added', { library: library.name, by: ctx.msg.senderId });

  const [statuses, merged] = await Promise.all([libraries.status(), store.listSkills()]);
  const status = statuses.find((item) => item.config.name === library.name);
  const found = status?.skills.length ?? 0;
  const shadowed = status ? shadowedSkills(status, merged) : [];
  const interval = getSkillSyncIntervalMinutes(ctx.controls.profileConfig.skills);
  const lines = [
    `📚 已添加 skill 库 \`${library.name}\`（\`${result.commit ?? '?'}\`），载入 ${found - shadowed.length} 个 skill。`,
  ];
  if (found === 0) {
    lines.push('⚠️ 没找到 `SKILL.md`：skill 要放在 `<目录>/<名字>/SKILL.md`，不在 `skills/` 下就用 `--path` 指定目录。');
  }
  if (shadowed.length > 0) {
    lines.push(`同名已存在、未载入：${shadowed.map((name) => `\`${name}\``).join('、')}`);
  }
  lines.push(
    '',
    `下一条消息起生效。${interval > 0 ? `每 ${interval} 分钟自动同步，` : ''}\`/skills lib sync ${library.name}\` 立即同步。`,
  );
  await reply(ctx, lines.join('\n'));
}

async function skillLibrarySync(name: string | undefined, ctx: CommandContext, libraries: SkillLibraries): Promise<void> {
  const configured = configuredLibraries(ctx);
  if (configured.length === 0) {
    await reply(ctx, '还没有配置 skill 库，用 `/skills lib add <git 地址>` 添加。');
    return;
  }
  if (name && !configured.some((library) => library.name === name)) {
    await reply(ctx, `没有叫 \`${name}\` 的库。现有：${configured.map((library) => `\`${library.name}\``).join('、')}`);
    return;
  }
  const results = await libraries.sync(name);
  const lines = results.map((result) =>
    result.ok
      ? `✓ \`${result.name}\`：${result.changed ? '已更新到' : '已是最新'} \`${result.commit ?? '?'}\``
      : `❌ \`${result.name}\`：${result.error ?? '同步失败'}`,
  );
  await reply(ctx, `🔄 skill 库同步完成\n${lines.join('\n')}`);
}

async function skillLibraryRemove(name: string, ctx: CommandContext, libraries: SkillLibraries): Promise<void> {
  const configured = configuredLibraries(ctx);
  if (!name) {
    await reply(ctx, '用法：`/skills lib rm <名字>`');
    return;
  }
  if (!configured.some((library) => library.name === name)) {
    await reply(
      ctx,
      configured.length === 0
        ? '还没有配置 skill 库。'
        : `没有叫 \`${name}\` 的库。现有：${configured.map((library) => `\`${library.name}\``).join('、')}`,
    );
    return;
  }
  try {
    await configOps.saveSkillsConfig(ctx.controls, (skills) => ({
      ...skills,
      libraries: skills.libraries.filter((library) => library.name !== name),
    }));
  } catch (err) {
    await reply(ctx, `❌ 保存配置失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await libraries.remove(name);
  log.info('skills', 'library-removed', { library: name, by: ctx.msg.senderId });
  await reply(ctx, `🗑 已移除 skill 库 \`${name}\`，本地镜像一起删掉了。`);
}

async function handleKnowledge(args: string, ctx: CommandContext): Promise<void> {
  const store = requireKnowledge(ctx);
  if (!store) {
    await reply(ctx, '当前 bridge 没有启用知识库（缺少 profile 数据目录）。');
    return;
  }
  const trimmed = args.trim();
  const [sub = '', ...rest] = trimmed.split(/\s+/);

  switch (sub) {
    case '':
    case 'status':
      return knowledgeStatus(ctx, store);
    case 'bind':
      return knowledgeBind(rest[0] ?? '', ctx, store);
    case 'unbind': {
      const result = await unbindKnowledgeRemote(store);
      await reply(ctx, isGitError(result) ? `❌ ${result.error}` : '✓ 已解除远端绑定，本地内容保留。');
      return;
    }
    case 'sync':
      return knowledgeSync(ctx, store);
    default:
      await reply(
        ctx,
        [
          '**知识库**',
          '',
          '`/knowledge` — 当前状态（记忆条数、skill 数、同步状态）',
          '`/knowledge bind <git 仓库地址>` — 绑定远端并拉取已有内容',
          '`/knowledge sync` — 立即同步：提交本地改动、拉取远端、推上去',
          '`/knowledge unbind` — 解除绑定（本地内容保留）',
          '',
          knowledgeAutoSyncHelp(getKnowledgeSyncIntervalMinutes(ctx.controls.profileConfig.knowledge)),
        ].join('\n'),
      );
  }
}

async function knowledgeStatus(ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  const [chat, profile, skills, repo, remote] = await Promise.all([
    store.listMemories({ kind: 'chat', scopeId: ctx.scope }),
    store.listMemories({ kind: 'profile' }),
    store.listSkills(),
    knowledgeRepoStatus(store),
    knowledgeRemoteUrl(store),
  ]);
  await ctx.channel.send(
    ctx.msg.chatId,
    {
      card: knowledgeCard({
        dir: store.dir,
        chatMemories: chat.length,
        profileMemories: profile.length,
        skills: skills.length,
        ...(remote ? { remote } : {}),
        ...(repo?.branch ? { branch: repo.branch } : {}),
        ...(repo?.upstream ? { ahead: repo.upstream.ahead, behind: repo.upstream.behind } : {}),
        ...(repo ? { dirty: isDirty(repo) } : {}),
        ...knowledgeAutoSyncView(ctx),
      }),
    },
    commandReplyOptions(ctx),
  );
}

function knowledgeAutoSyncHelp(interval: number): string {
  const now = interval > 0 ? `绑定远端后每 ${interval} 分钟自动同步一次` : '自动同步已关闭';
  return `${now}（profile 配置 \`knowledge.syncIntervalMinutes\`，默认 ${DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MINUTES}，\`0\` 关闭）；连续两次失败会私聊提醒 bot 主人。`;
}

/** Auto-sync part of the `/knowledge` card; the interval is shown even before the loop exists. */
function knowledgeAutoSyncView(
  ctx: CommandContext,
): Pick<KnowledgeStatusView, 'autoSyncMinutes' | 'autoSyncing' | 'lastSync'> {
  const status = ctx.controls.knowledgeAutoSync?.status();
  const view = {
    autoSyncMinutes: status?.intervalMinutes ?? getKnowledgeSyncIntervalMinutes(ctx.controls.profileConfig.knowledge),
    ...(status?.syncing ? { autoSyncing: true } : {}),
  };
  const last = status?.last;
  if (!status || !last) return view;
  return {
    ...view,
    lastSync: {
      ago: formatAgo(Date.now() - last.at),
      auto: last.trigger === 'auto',
      ok: last.ok,
      ...(last.error ? { error: last.error } : {}),
      ...(status.failures > 1 ? { failures: status.failures } : {}),
    },
  };
}

async function knowledgeBind(url: string, ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  if (!url) {
    await reply(ctx, '用法：`/knowledge bind <git 仓库地址>`');
    return;
  }
  const result = await bindKnowledgeRemote(store, url);
  if (isGitError(result)) {
    await reply(ctx, `❌ 绑定失败：${result.error}`);
    return;
  }
  log.info('knowledge', 'remote-bound', { scope: ctx.scope });
  const interval = getKnowledgeSyncIntervalMinutes(ctx.controls.profileConfig.knowledge);
  const after = interval > 0 ? `之后每 ${interval} 分钟自动同步，也可以随时 \`/knowledge sync\`。` : '之后用 `/knowledge sync` 同步。';
  await reply(ctx, `🔗 已绑定远端。${result.note ?? '远端已有的记忆和 skill 都拉下来了。'}\n\n${after}`);
}

async function knowledgeSync(ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  // Queued behind an automatic sync that is already running, then a full
  // round of its own (`syncKnowledge` serializes per directory).
  const result = await syncKnowledge(store);
  ctx.controls.knowledgeAutoSync?.noteManual(result);
  if (isGitError(result)) {
    await reply(ctx, `❌ ${result.error}`);
    return;
  }
  const parts = [
    result.committed > 0 ? `提交了 ${result.committed} 个文件` : '本地没有新改动',
    result.pulled ? '已拉取远端' : '',
    result.pushed ? '已推送' : '',
  ].filter(Boolean);
  await reply(ctx, `🔄 ${parts.join('，')}。${result.note ?? ''}`.trim());
}

// ─── /cron ────────────────────────────────────────────────────────────────

async function handleCron(args: string, ctx: CommandContext): Promise<void> {
  const scheduler = ctx.controls.scheduler;
  if (!scheduler) {
    await reply(ctx, '当前 bridge 没有启用定时任务（缺少 profile 数据目录）。');
    return;
  }
  const trimmed = args.trim();
  const [sub = '', ...rest] = trimmed.split(/\s+/);
  const restText = trimmed.slice(sub.length).trim();

  switch (sub) {
    case '':
    case 'list':
      return cronList(ctx, scheduler);
    case 'add':
      return cronAdd(restText, ctx, scheduler);
    case 'show':
      return cronShow(rest[0] ?? '', ctx, scheduler);
    case 'run':
      return cronRun(rest[0] ?? '', ctx, scheduler);
    case 'pause':
      return cronToggle(rest[0] ?? '', false, ctx, scheduler);
    case 'resume':
      return cronToggle(rest[0] ?? '', true, ctx, scheduler);
    case 'rename':
      return cronRename(rest[0] ?? '', restText.slice((rest[0] ?? '').length).trim(), ctx, scheduler);
    case 'remove':
    case 'rm':
      return cronRemove(rest[0] ?? '', ctx, scheduler);
    default:
      await reply(ctx, CRON_USAGE);
  }
}

/**
 * Jobs are managed only from the chat that owns them. Someone who can see a
 * job id in one chat must not be able to pause or delete another chat's job
 * from somewhere else.
 */
function cronJobInScope(
  id: string,
  ctx: CommandContext,
  scheduler: Scheduler,
): ScheduledJob | undefined {
  const job = scheduler.jobs.get(id.trim());
  if (!job || job.chatId !== ctx.msg.chatId) return undefined;
  return job;
}

async function cronList(ctx: CommandContext, scheduler: Scheduler): Promise<void> {
  const jobs = scheduler.jobs.listForChat(
    ctx.msg.chatId,
    ctx.chatMode === 'topic' ? ctx.msg.threadId : undefined,
  );
  const card = cronCard(
    jobs.map((job) => ({
      id: job.id,
      ...(job.name ? { name: job.name } : {}),
      schedule: scheduleSummaryPlain(job),
      status: jobStatusLine(job),
      ...(lastRunLine(job) ? { lastRun: lastRunLine(job)! } : {}),
      prompt: truncate(job.prompt, 120),
      enabled: job.enabled,
    })),
    '发送 `/cron add 0 9 * * 1-5 | 看一下昨天 CI 的失败并总结` 建一个。',
  );
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function cronAdd(args: string, ctx: CommandContext, scheduler: Scheduler): Promise<void> {
  if (!args) {
    await reply(ctx, CRON_USAGE);
    return;
  }
  const parsed = parseAdd(args);
  if (!parsed.ok) {
    await reply(ctx, `❌ ${parsed.error}\n\n${CRON_USAGE}`);
    return;
  }

  const cwd = effectiveWorkspaceCwd(ctx);
  const job = scheduler.jobs.add({
    ...(parsed.value.name ? { name: parsed.value.name } : {}),
    prompt: parsed.value.prompt,
    schedule: parsed.value.schedule,
    session: parsed.value.session,
    chatId: ctx.msg.chatId,
    chatType: ctx.chatMode,
    ...(ctx.msg.threadId ? { threadId: ctx.msg.threadId } : {}),
    anchorMessageId: ctx.msg.messageId,
    creatorId: ctx.msg.senderId,
    ...(cwd ? { cwd } : {}),
    enabled: true,
    createdAt: Date.now(),
  });
  const armed = scheduler.armJob(job.id) ?? job;
  log.info('scheduler', 'job-created', {
    jobId: job.id,
    kind: job.schedule.kind,
    scope: ctx.scope,
  });

  await reply(
    ctx,
    [
      `✅ 已创建定时任务 ${jobTitleMd(armed)}`,
      `- 计划：${scheduleSummary(armed)}`,
      `- 下次运行：${armed.nextRunAt ? formatTime(armed.nextRunAt) : '未排期'}`,
      `- 工作目录：\`${armed.cwd ?? '(profile 默认)'}\``,
      `- 会话：${armed.session === 'continue' ? '跨次复用' : '每次新建'}`,
      '',
      `\`/cron run ${armed.id}\` 可以立刻试跑一次。`,
    ].join('\n'),
  );
}

async function cronShow(id: string, ctx: CommandContext, scheduler: Scheduler): Promise<void> {
  const job = cronJobInScope(id, ctx, scheduler);
  if (!job) {
    await reply(ctx, '未找到该任务（只能管理当前会话创建的任务）。');
    return;
  }
  const lines = [
    `**定时任务 ${jobTitleMd(job)}**`,
    `- 名称：${job.name ?? '（未命名，可用 \`/cron rename ' + job.id + ' <名称>\` 设置）'}`,
    `- 计划：${scheduleSummary(job)}`,
    `- 状态：${jobStatusLine(job)}`,
    `- 工作目录：\`${job.cwd ?? '(profile 默认)'}\``,
    `- 会话：${job.session === 'continue' ? '跨次复用' : '每次新建'}`,
    `- 创建于：${formatTime(job.createdAt)}`,
  ];
  const last = lastRunLine(job);
  if (last) lines.push(`- ${last}`);
  lines.push('', '任务内容：', job.prompt);
  await reply(ctx, lines.join('\n'));
}

async function cronRun(id: string, ctx: CommandContext, scheduler: Scheduler): Promise<void> {
  const job = cronJobInScope(id, ctx, scheduler);
  if (!job) {
    await reply(ctx, '未找到该任务（只能管理当前会话创建的任务）。');
    return;
  }
  // The run posts its own result when it finishes; a test run of a real job
  // can take minutes, and blocking the command reply on it would look hung.
  await reply(ctx, `▶️ 已触发 ${jobTitleMd(job)}，结果会单独发出来。`);
  void scheduler.runNow(job.id).catch((err: unknown) => {
    log.fail('scheduler', err, { jobId: job.id, step: 'manual-run' });
  });
}

async function cronToggle(
  id: string,
  enabled: boolean,
  ctx: CommandContext,
  scheduler: Scheduler,
): Promise<void> {
  const job = cronJobInScope(id, ctx, scheduler);
  if (!job) {
    await reply(ctx, '未找到该任务（只能管理当前会话创建的任务）。');
    return;
  }
  // Resuming also clears the failure streak: the point of resuming is that
  // whatever kept failing was fixed.
  scheduler.jobs.update(job.id, { enabled, ...(enabled ? { failureStreak: 0 } : {}) });
  const armed = scheduler.armJob(job.id);
  // Pausing a job that is mid-run has to stop that run too — a scheduled run
  // owns its own scope, so the chat's `/stop` cannot reach it.
  const stopped = !enabled && ctx.activeRuns.interrupt(jobScopeId(job.id));
  await reply(
    ctx,
    enabled
      ? `▶️ 已恢复 ${jobTitleMd(job)}，下次运行：${armed?.nextRunAt ? formatTime(armed.nextRunAt) : '未排期'}`
      : `⏸ 已暂停 ${jobTitleMd(job)}${stopped ? '，并中断了正在执行的那次运行' : ''}。`,
  );
}

async function cronRemove(id: string, ctx: CommandContext, scheduler: Scheduler): Promise<void> {
  const job = cronJobInScope(id, ctx, scheduler);
  if (!job) {
    await reply(ctx, '未找到该任务（只能管理当前会话创建的任务）。');
    return;
  }
  scheduler.jobs.remove(job.id);
  const stopped = ctx.activeRuns.interrupt(jobScopeId(job.id));
  log.info('scheduler', 'job-removed', { jobId: job.id, scope: ctx.scope, stoppedRun: stopped });
  await reply(ctx, `🗑 已删除 ${jobTitleMd(job)}${stopped ? '，并中断了正在执行的那次运行' : ''}。`);
}

async function cronRename(
  id: string,
  rawName: string,
  ctx: CommandContext,
  scheduler: Scheduler,
): Promise<void> {
  const job = cronJobInScope(id, ctx, scheduler);
  if (!job) {
    await reply(ctx, id ? '未找到该任务（只能管理当前会话创建的任务）。' : '用法：`/cron rename <id> <名称>`');
    return;
  }
  const parsed = normalizeJobName(rawName.replace(/^["“](.*)["”]$/, '$1'));
  if (!parsed.ok) {
    await reply(ctx, `❌ ${parsed.error}`);
    return;
  }
  // An undefined name is dropped when the store serialises, which clears it.
  scheduler.jobs.update(job.id, { name: parsed.value });
  log.info('scheduler', 'job-renamed', { jobId: job.id, scope: ctx.scope });
  await reply(
    ctx,
    parsed.value ? `✏️ 已把 \`${job.id}\` 命名为「${parsed.value}」。` : `✏️ 已清除 \`${job.id}\` 的名称。`,
  );
}

// ─── /account ─────────────────────────────────────────────────────────────

async function handleAccount(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showCurrent(ctx);
    case 'change':
      return showForm(ctx);
    case 'submit':
      return submitAccount(ctx);
    case 'cancel':
      return cancelAccount(ctx);
    default:
      await reply(ctx, '用法：`/account` 或 `/account change`');
  }
}

async function showCurrent(ctx: CommandContext): Promise<void> {
  // Current-status card has only a [更换凭据] button — never updated in-place,
  // so an inline card is sufficient (and avoids creating a managed card we'd
  // never re-touch).
  const card = accountCurrentCard({
    appId: ctx.controls.cfg.accounts.app.id,
    botName: ctx.channel.botIdentity?.name,
    tenant: ctx.controls.cfg.accounts.app.tenant,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function showForm(ctx: CommandContext): Promise<void> {
  const card = accountFormCard({ initialTenant: ctx.controls.cfg.accounts.app.tenant });
  if (ctx.fromCardAction) {
    await recallMessage(ctx, ctx.msg.messageId);
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

async function cancelAccount(ctx: CommandContext): Promise<void> {
  // Cancel = remove the form card. No follow-up message.
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
}

// Lark's client holds a local "form just submitted" state for a short
// window after the click that overrides any cardkit.card.update we issue.
// We always wait at least this long before flipping the form card to its
// terminal (success/failure) state. Empirically ~1s is enough; less than
// that and the update gets reverted to the form's pre-submit state.
const FORM_SETTLE_MS = 1000;

async function submitAccount(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const appId = String(fv.app_id ?? '').trim();
  const appSecret = String(fv.app_secret ?? '').trim();
  const tenant = (fv.tenant === 'lark' ? 'lark' : 'feishu') as TenantBrand;

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const restart = ctx.controls.restart;
  const retryReplyOptions = commandReplyOptions(ctx);

  // CRITICAL: detach the work from the cardAction handler. Lark's client
  // keeps the form locked while the handler is pending — if we await the
  // 2s settle window inline, the lock holds, and the moment we return the
  // client snaps the card back to its cached form state (overwriting any
  // update we made). Returning immediately lets the lock release; the
  // delayed updateManagedCard then sticks.
  const chatId = ctx.msg.chatId;
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    // Success path: in-place update. The card never accepts another submit
    // (success card has no form), so this is fine.
    const finishSuccess = async (card: object): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, card).catch((err) =>
        console.warn('[account] form update failed:', err),
      );
      forgetManagedCard(formMsgId);
    };

    // Failure path: leave the old form card as a static "❌ 校验失败" record
    // (in-place update to a non-form card so it stops responding to clicks),
    // then post a fresh managed form card below for retry. We can't reuse
    // the original card_id for the retry form because Lark's client locks
    // form interactions on it once submitted — even a re-rendered form on
    // the same card_id no longer fires cardActions.
    const finishFailure = async (errorMessage: string): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, accountFailureCard(errorMessage))
        .catch((err) => console.warn('[account] mark old form failed:', err));
      forgetManagedCard(formMsgId);
      // Don't prefill the secret on retry — pre-filled secrets can get
      // echoed back into the card payload and may persist in Lark's
      // server-side card cache. Keep appId prefilled (non-sensitive).
      const retry = accountFormCard({
        initialTenant: tenant,
        prefillAppId: appId,
      });
      await sendManagedCard(channel, chatId, retry, retryReplyOptions).catch((err) =>
        console.warn('[account] post retry form failed:', err),
      );
    };

    if (!appId || !appSecret) {
      await finishFailure('App ID 或 App Secret 为空');
      return;
    }

    const result = await validateAppCredentials(appId, appSecret, tenant);
    if (!result.ok) {
      await finishFailure(result.reason ?? 'unknown');
      return;
    }

    // Encrypted-at-rest path: store the plaintext secret in the AES keystore,
    // and write config.json with an exec-provider SecretRef instead of the
    // raw secret. lark-cli's `config bind --source lark-channel` reads the
    // same SecretRef and goes through the exec protocol to retrieve the
    // plaintext into its own OS keychain — no plaintext on disk.
    try {
      const appPaths = commandProfilePaths(ctx);
      const newCfg = await buildEncryptedAccountConfig(
        appId,
        tenant,
        ctx.controls.cfg.preferences,
        appPaths,
      );
      await saveAccountConfig(ctx, newCfg, appSecret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishFailure(`保存凭据失败：${msg}`);
      return;
    }

    await finishSuccess(accountSuccessCard({ appId, botName: result.botName, tenant }));

    // Give the user 1.5s to read the success state before we tear down the
    // WS and reconnect with new credentials.
    setTimeout(() => {
      void restart().catch((err) => {
        console.error('[account] restart failed:', err);
        process.exit(1);
      });
    }, 1500);
  })();
}

async function recallMessage(ctx: CommandContext, messageId: string): Promise<void> {
  try {
    await ctx.channel.recallMessage(messageId);
  } catch (err) {
    console.warn('[recall failed]', err);
  }
}

// ────────────── /invite and /remove — access lists ──────────────

async function handleInvite(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());

  if (tokens.includes('all') && tokens.includes('group')) {
    const list = new Set(ctx.controls.profileConfig.access.allowedChats);
    let knownChats = ctx.controls.knownChats ?? [];
    if (knownChats.length === 0) {
      knownChats = await fetchKnownChats(ctx.channel);
      ctx.controls.knownChats = knownChats;
    }
    let added = 0;
    let total = list.size;
    await saveAccessConfig(ctx, (current) => {
      list.clear();
      for (const chatId of current.allowedChats) list.add(chatId);
      added = 0;
      for (const chat of knownChats) {
        if (!list.has(chat.id)) {
          list.add(chat.id);
          added += 1;
        }
      }
      total = list.size;
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (knownChats.length === 0) {
      await reply(ctx, '当前 bot 还不在任何群里，没有可加入的群。');
    } else {
      await reply(ctx, `✅ 已把 bot 所在的 ${added} 个群加入响应群名单（共 ${total} 个）。`);
    }
    return;
  }

  const kind = tokens.find((token) => /^(user|admin|group|member)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | 'member'
    | undefined;
  if (!kind) {
    await reply(
      ctx,
      '用法：\n' +
        '• `/invite user @某人` — 加入允许私聊\n' +
        '• `/invite admin @某人` — 加入管理员\n' +
        '• `/invite group` — 把当前群加入响应群名单（群内所有人可用）\n' +
        '• `/invite group restricted @某人...` — 把当前群加入响应群名单，且只对 @ 到的人生效（一步到位，不会有"先开放给所有人"的窗口期）\n' +
        '• `/invite member @某人` — 只把这个人加进当前群的专属名单（当前群需已在响应群名单里）\n' +
        '• `/invite all group` — 把 bot 所在的所有群一键加入',
    );
    return;
  }

  if (kind === 'group') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '❌ `/invite group` 只能在群里发，在私聊里没有 chat_id 可以加。');
      return;
    }
    const chatId = ctx.msg.chatId;
    const restricted = tokens.includes('restricted');

    if (restricted) {
      const targets = mentionTargets(ctx);
      let alreadyChat = false;
      let added: string[] = [];
      let already: string[] = [];
      await saveAccessConfig(ctx, (current) => {
        const chats = new Set(current.allowedChats);
        alreadyChat = chats.has(chatId);
        chats.add(chatId);
        const memberMap = { ...(current.chatAllowedUsers ?? {}) };
        const existing = new Set(memberMap[chatId] ?? []);
        added = [];
        already = [];
        for (const target of targets) {
          if (existing.has(target.openId)) {
            already.push(target.name ?? target.openId);
          } else {
            existing.add(target.openId);
            added.push(target.name ?? target.openId);
          }
        }
        memberMap[chatId] = [...existing];
        return {
          ...current,
          allowedChats: [...chats],
          chatAllowedUsers: memberMap,
        };
      });
      const parts: string[] = [
        alreadyChat
          ? '✅ 当前群已在响应名单里，已切换为仅名单模式。'
          : `✅ 已把当前群（\`${chatId}\`）加入响应群名单，且设为仅名单模式。`,
      ];
      if (added.length > 0) parts.push(`已放行：${added.join('、')}。`);
      if (already.length > 0) parts.push(`_${already.join('、')} 已经在名单里，跳过。_`);
      if (targets.length === 0) {
        parts.push('_当前没有 @ 任何人，这个群现在只有 admin/owner 能用，之后用 `/invite member @某人` 追加。_');
      }
      await reply(ctx, parts.join('\n'));
      return;
    }

    let already = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.allowedChats);
      already = list.has(chatId);
      if (!already) list.add(chatId);
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (already) {
      await reply(ctx, '✅ 当前群已在白名单里，无需重复添加。');
      return;
    }
    await reply(ctx, `✅ 已把当前群（\`${chatId}\`）加入响应群名单。`);
    return;
  }

  if (kind === 'member') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '❌ `/invite member` 只能在群里发，在私聊里没有 chat_id 可以加。');
      return;
    }
    const chatId = ctx.msg.chatId;
    const targets = mentionTargets(ctx);
    if (targets.length === 0) {
      await reply(ctx, '❌ 没检测到 @ 的用户。请像这样发：`/invite member @某人`。');
      return;
    }
    let chatAllowed = false;
    let added: string[] = [];
    let already: string[] = [];
    await saveAccessConfig(ctx, (current) => {
      chatAllowed = current.allowedChats.includes(chatId);
      if (!chatAllowed) return current;
      const memberMap = { ...(current.chatAllowedUsers ?? {}) };
      const existing = new Set(memberMap[chatId] ?? []);
      added = [];
      already = [];
      for (const target of targets) {
        if (existing.has(target.openId)) {
          already.push(target.name ?? target.openId);
        } else {
          existing.add(target.openId);
          added.push(target.name ?? target.openId);
        }
      }
      memberMap[chatId] = [...existing];
      return { ...current, chatAllowedUsers: memberMap };
    });
    if (!chatAllowed) {
      await reply(
        ctx,
        '❌ 当前群还不在响应群名单里，先 `/invite group` 或 `/invite group restricted @某人` 再加成员。',
      );
      return;
    }
    const parts: string[] = [];
    if (added.length > 0) parts.push(`✅ 已把 ${added.join('、')} 加入当前群的专属名单。`);
    if (already.length > 0) parts.push(`_${already.join('、')} 已经在名单里，跳过。_`);
    await reply(ctx, parts.join('\n'));
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(
      ctx,
      `❌ 没检测到 @ 的用户。请像这样发：\`/invite ${kind} @某人\`（注意 @ 用户不是 @ bot）。`,
    );
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const added: string[] = [];
  const already: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    added.length = 0;
    already.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        already.push(target.name ?? target.openId);
      } else {
        list.add(target.openId);
        added.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list],
    };
  });
  const label = kind === 'user' ? '用户白名单' : '管理员';
  const parts: string[] = [];
  if (added.length > 0) parts.push(`✅ 已把 ${added.join('、')} 加入${label}。`);
  if (already.length > 0) parts.push(`_${already.join('、')} 已经在${label}里，跳过。_`);
  await reply(ctx, parts.join('\n'));
}

async function handleRemove(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  const kind = tokens.find((token) => /^(user|admin|group|member)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | 'member'
    | undefined;
  if (!kind) {
    await reply(
      ctx,
      '用法：\n' +
        '• `/remove user @某人` — 移出用户白名单\n' +
        '• `/remove admin @某人` — 移出管理员\n' +
        '• `/remove group` — 把当前群移出响应群名单\n' +
        '• `/remove group <群 ID>` — 按 ID 移除指定的群，私聊里也能用（写 `/config` 群管理面板里显示的末 6 位即可）\n' +
        '• `/remove member @某人` — 把这个人移出当前群的专属名单',
    );
    return;
  }

  if (kind === 'group') {
    const idArg = args.trim().split(/\s+/).find((token) => token.toLowerCase() !== 'group');
    if (idArg) {
      await removeGroupById(ctx, idArg);
      return;
    }
    if (ctx.chatMode === 'p2p') {
      await reply(
        ctx,
        '私聊里请带上群 ID：`/remove group <群 ID>`。ID 写全或只写 `/config` 群管理面板里显示的末 6 位都可以。',
      );
      return;
    }
    const chatId = ctx.msg.chatId;
    let missing = false;
    await saveAccessConfig(ctx, (current) => {
      missing = !current.allowedChats.includes(chatId);
      return withoutChat(current, chatId);
    });
    if (missing) {
      await reply(ctx, '✅ 当前群本来就不在响应名单里，无需移除。');
      return;
    }
    await reply(ctx, '✅ 已把当前群移出响应群名单。');
    return;
  }

  if (kind === 'member') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '❌ `/remove member` 只能在群里发，在私聊里没有 chat_id 可以移除。');
      return;
    }
    const chatId = ctx.msg.chatId;
    const targets = mentionTargets(ctx);
    if (targets.length === 0) {
      await reply(ctx, '请 @ 上要移除的人，例如：`/remove member @某人`。');
      return;
    }
    let hadList = false;
    let removed: string[] = [];
    let notThere: string[] = [];
    await saveAccessConfig(ctx, (current) => {
      const memberMap = { ...(current.chatAllowedUsers ?? {}) };
      const existing = memberMap[chatId];
      hadList = existing !== undefined;
      if (!hadList) return current;
      const set = new Set(existing);
      removed = [];
      notThere = [];
      for (const target of targets) {
        if (set.has(target.openId)) {
          set.delete(target.openId);
          removed.push(target.name ?? target.openId);
        } else {
          notThere.push(target.name ?? target.openId);
        }
      }
      memberMap[chatId] = [...set];
      return { ...current, chatAllowedUsers: memberMap };
    });
    if (!hadList) {
      await reply(ctx, '✅ 当前群不是仅名单模式，没有专属名单，无需移除。');
      return;
    }
    const parts: string[] = [];
    if (removed.length > 0) parts.push(`✅ 已把 ${removed.join('、')} 移出当前群的专属名单。`);
    if (notThere.length > 0) parts.push(`${notThere.join('、')} 本来就不在名单里，无需移除。`);
    await reply(ctx, parts.join('\n'));
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(ctx, `请 @ 上要移除的人，例如：\`/remove ${kind} @某人\`。`);
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const removed: string[] = [];
  const notThere: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    removed.length = 0;
    notThere.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        list.delete(target.openId);
        removed.push(target.name ?? target.openId);
      } else {
        notThere.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list],
    };
  });
  const label = kind === 'user' ? '用户白名单' : '管理员';
  const parts: string[] = [];
  if (removed.length > 0) parts.push(`✅ 已把 ${removed.join('、')} 移出${label}。`);
  if (notThere.length > 0) parts.push(`${notThere.join('、')} 本来就不在${label}里，无需移除。`);
  await reply(ctx, parts.join('\n'));
}

function mentionTargets(ctx: CommandContext): Array<{ openId: string; name?: string }> {
  return (ctx.msg.mentions ?? [])
    .filter((mention) => !mention.isBot && typeof mention.openId === 'string' && mention.openId)
    .map((mention) => ({
      openId: mention.openId as string,
      ...(mention.name ? { name: mention.name } : {}),
    }));
}

async function saveAccessConfig(
  ctx: CommandContext,
  mutate: (access: ProfileAccess) => ProfileAccess,
): Promise<ProfileAccess> {
  return configOps.saveAccessConfig(ctx.controls, mutate);
}

/**
 * Drop a chat from the allowlist together with its per-chat member list and
 * @ override, so removing then re-adding a group later doesn't silently
 * resurrect settings the operator no longer remembers configuring.
 */
function withoutChat(access: ProfileAccess, chatId: string): ProfileAccess {
  const memberMap = { ...(access.chatAllowedUsers ?? {}) };
  delete memberMap[chatId];
  const mentionMap = { ...(access.chatRequireMention ?? {}) };
  delete mentionMap[chatId];
  return {
    ...access,
    allowedChats: access.allowedChats.filter((id) => id !== chatId),
    chatAllowedUsers: memberMap,
    chatRequireMention: mentionMap,
  };
}

/** Shortest suffix accepted by `/remove group <id>`; the /config panel shows 6. */
const MIN_CHAT_ID_SUFFIX = 4;

/**
 * `/remove group <id>` — removes an allowlisted chat named by its full
 * chat_id or a suffix of it (the /config group panel shows the last 6
 * characters). Works from p2p, which is the only way to drop a chat the bot
 * has already left: plain `/remove group` has to be sent inside the chat.
 */
async function removeGroupById(ctx: CommandContext, rawId: string): Promise<void> {
  const needle = rawId.replace(/^[.…（(]+|[)）]+$/g, '').toLowerCase();
  const names = new Map((ctx.controls.knownChats ?? []).map((chat) => [chat.id, chat.name]));
  const label = (id: string) => `${names.get(id) ? `**${names.get(id)}**` : '(未知群)'}（\`${id}\`）`;
  const findMatches = (allowed: string[]) => {
    const exact = allowed.filter((id) => id.toLowerCase() === needle);
    if (exact.length > 0 || needle.length < MIN_CHAT_ID_SUFFIX) return exact;
    return allowed.filter((id) => id.toLowerCase().endsWith(needle));
  };

  let matches: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    matches = findMatches(current.allowedChats);
    return matches.length === 1 ? withoutChat(current, matches[0]!) : current;
  });

  if (matches.length === 1) {
    await reply(ctx, `✅ 已把 ${label(matches[0]!)} 移出响应群名单。`);
    return;
  }
  if (matches.length > 1) {
    await reply(
      ctx,
      `❌ 有 ${matches.length} 个群的 ID 以 \`${needle}\` 结尾，请多写几位或写全 ID：\n` +
        matches.map((id) => `- ${label(id)}`).join('\n'),
    );
    return;
  }
  await reply(
    ctx,
    needle.length < MIN_CHAT_ID_SUFFIX
      ? `❌ 群 ID 至少写末 ${MIN_CHAT_ID_SUFFIX} 位，或者写全 ID。`
      : `❌ 响应群名单里没有 ID 为 \`${needle}\` 或以它结尾的群。发 \`/config\` 在群管理面板里核对。`,
  );
}

// ────────────── /config — preferences form ──────────────

async function handleConfig(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showConfigForm(ctx);
    case 'submit':
      return submitConfig(ctx);
    case 'cancel':
      return cancelConfig(ctx);
    default:
      await reply(ctx, '用法:`/config`');
  }
}

async function showConfigForm(ctx: CommandContext): Promise<void> {
  await Promise.all([
    ctx.controls.refreshOwner(ctx.channel).catch(() => {}),
    fetchKnownChats(ctx.channel)
      .then((chats) => {
        if (chats.length > 0) ctx.controls.knownChats = chats;
      })
      .catch(() => {}),
  ]);

  const ms = getRunIdleTimeoutMs(ctx.controls.cfg);
  const access = ctx.controls.profileConfig.access;
  // Surface the local web console URL when the supervisor (`--web-ui`) is
  // running — read from the host sidecar and confirm the owning process is
  // alive so we don't advertise a stale address.
  const sidecar = await readUiSidecar(commandProfilePaths(ctx).hostUiFile).catch(() => undefined);
  const consoleUrl = sidecar && isAlive(sidecar.pid) ? sidecar.url : undefined;
  const card = configFormCard({
    agentKind: ctx.controls.profileConfig.agentKind,
    mode: ctx.controls.profileConfig.mode,
    model: normalizeModelSelection(
      ctx.controls.profileConfig.agentKind,
      ctx.controls.cfg.preferences?.model,
    ),
    effort: getEffort(ctx.controls.cfg),
    messageReply: getMessageReplyMode(ctx.controls.cfg),
    showToolCalls: getShowToolCalls(ctx.controls.cfg),
    cotMessages: getCotMessages(ctx.controls.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(ctx.controls.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    requireMentionInGroup: getRequireMentionInGroup(ctx.controls.cfg),
    larkCliIdentity: ctx.controls.profileConfig.larkCli.identityPreset,
    approvalsEnabled: ctx.controls.profileConfig.approvals.enabled,
    smartSession: getSmartSession(ctx.controls.cfg) !== undefined,
    autoWorktreeCleanup: getWorktreeCleanupIdleDays(ctx.controls.cfg) !== undefined,
    dream: getDream(ctx.controls.cfg) !== undefined,
    dreamAuto: ctx.controls.cfg.preferences?.dreamAuto === true,
    allowedUsers: access.allowedUsers,
    allowedChats: access.allowedChats,
    admins: access.admins,
    knownChats: ctx.controls.knownChats ?? [],
    chatRequireMention: access.chatRequireMention ?? {},
    chatAllowedUsers: access.chatAllowedUsers ?? {},
    ...(consoleUrl ? { consoleUrl } : {}),
  });
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

async function showResultCardInPlace(
  ctx: CommandContext,
  formMsgId: string,
  card: object,
): Promise<void> {
  try {
    await updateManagedCard(ctx.channel, formMsgId, card);
  } catch (err) {
    log.warn('command', 'config-card-update-fallback', { err: String(err) });
    await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx)).catch((fallbackErr) =>
      log.warn('command', 'config-card-fallback-send-failed', {
        err: String(fallbackErr),
      }),
    );
  }
  forgetManagedCard(formMsgId);
}

async function cancelConfig(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await showResultCardInPlace(ctx, formMsgId, configCancelledCard());
    })();
  }
}

async function submitConfig(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const rawReply = String(fv.message_reply ?? '').trim();
  const messageReply: MessageReplyMode =
    rawReply === 'markdown' || rawReply === 'text' || rawReply === 'card'
      ? (rawReply as MessageReplyMode)
      : getMessageReplyMode(ctx.controls.cfg);
  const rawTools = String(fv.show_tool_calls ?? '').trim();
  const showToolCalls = rawTools !== 'hide';
  // Parse the model picker. Unexpected / empty values keep the current
  // selection. Store `undefined` for the "default" sentinel to keep config
  // tidy (resolveModelArg treats both the same way).
  const agentKind = ctx.controls.profileConfig.agentKind;
  const rawModel = String(fv.model ?? '').trim();
  const modelValid =
    rawModel !== '' &&
    // Passing the submitted value as `current` also accepts a well-formed pinned
    // Claude id (e.g. `claude-opus-5-5`) that the alias picker no longer lists.
    supportedModels(agentKind, rawModel).some((m) => m.value === rawModel);
  const modelSelection = modelValid
    ? rawModel
    : normalizeModelSelection(agentKind, ctx.controls.cfg.preferences?.model);
  const model = modelSelection === DEFAULT_MODEL ? undefined : modelSelection;
  // Absent/empty means "follow default"; a level outside this agent's own
  // list (e.g. Codex-only `ultra` on a claude form) keeps the current value.
  const rawEffort = String(fv.effort ?? '').trim();
  const effort: EffortLevel | undefined =
    rawEffort === ''
      ? undefined
      : supportedEfforts(agentKind).includes(rawEffort as EffortLevel)
        ? (rawEffort as EffortLevel)
        : getEffort(ctx.controls.cfg);
  const rawCotMessages = String(fv.cot_messages ?? '').trim();
  const cotMessages =
    rawCotMessages === 'brief'
      ? 'brief'
      : rawCotMessages === 'detailed' || rawCotMessages === 'on'
        ? 'detailed'
        : rawCotMessages === 'off'
          ? 'off'
          : getCotMessages(ctx.controls.cfg);
  // Parse max_concurrent_runs; invalid input falls back to current value.
  const rawMaxCC = String(fv.max_concurrent_runs ?? '').trim();
  const parsedMaxCC = Number(rawMaxCC);
  const maxConcurrentRuns =
    Number.isFinite(parsedMaxCC) && parsedMaxCC >= 1
      ? Math.min(50, Math.floor(parsedMaxCC))
      : getMaxConcurrentRuns(ctx.controls.cfg);
  // Parse run_idle_timeout_minutes. 0 disables; otherwise clamp 1-120.
  // Empty string keeps current value.
  const rawIdle = String(fv.run_idle_timeout_minutes ?? '').trim();
  const currentIdleMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 60_000) : 0;
  let runIdleTimeoutMinutes: number;
  if (rawIdle === '') {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const parsedIdle = Number(rawIdle);
    if (!Number.isFinite(parsedIdle) || parsedIdle < 0) {
      runIdleTimeoutMinutes = currentIdleMinutes;
    } else if (parsedIdle === 0) {
      runIdleTimeoutMinutes = 0;
    } else {
      runIdleTimeoutMinutes = Math.min(120, Math.max(1, Math.floor(parsedIdle)));
    }
  }
  // Parse require_mention_in_group. Empty / unexpected keeps current.
  const rawRequireMention = String(fv.require_mention_in_group ?? '').trim();
  let requireMentionInGroup: boolean;
  if (rawRequireMention === 'yes') requireMentionInGroup = true;
  else if (rawRequireMention === 'no') requireMentionInGroup = false;
  else requireMentionInGroup = getRequireMentionInGroup(ctx.controls.cfg);
  // Parse deployment mode. Empty / unexpected keeps current.
  const rawMode = String(fv.deploy_mode ?? '').trim();
  const mode: ProfileMode =
    rawMode === 'team' || rawMode === 'personal'
      ? rawMode
      : ctx.controls.profileConfig.mode;
  // Non-admin approvals switch. Empty / unexpected keeps current.
  const rawApprovals = String(fv.approvals_enabled ?? '').trim();
  const approvalsEnabled =
    rawApprovals === 'on' ? true : rawApprovals === 'off' ? false : ctx.controls.profileConfig.approvals.enabled;
  // 会话智能压缩 switch. Empty / unexpected keeps current.
  const rawSmartSession = String(fv.smart_session ?? '').trim();
  const smartSession =
    rawSmartSession === 'on' ? true : rawSmartSession === 'off' ? false : getSmartSession(ctx.controls.cfg) !== undefined;
  const rawCleanup = String(fv.auto_worktree_cleanup ?? '').trim();
  const autoWorktreeCleanup = rawCleanup === 'on' ? true : rawCleanup === 'off' ? false : getWorktreeCleanupIdleDays(ctx.controls.cfg) !== undefined;
  // 课堂精练 switch. Empty / unexpected keeps current.
  const rawDream = String(fv.dream ?? '').trim();
  const dream = rawDream === 'on' ? true : rawDream === 'off' ? false : getDream(ctx.controls.cfg) !== undefined;
  const rawDreamAuto = String(fv.dream_auto ?? '').trim();
  const dreamAuto =
    rawDreamAuto === 'on' ? true : rawDreamAuto === 'off' ? false : ctx.controls.cfg.preferences?.dreamAuto === true;
  const rawLarkCliIdentity = String(fv.lark_cli_identity ?? '').trim();
  const larkCliIdentity =
    rawLarkCliIdentity === 'user-default' || rawLarkCliIdentity === 'bot-only'
      ? rawLarkCliIdentity
      : ctx.controls.profileConfig.larkCli.identityPreset;
  // Effective preset = what actually gets applied to lark-cli. Team mode forces
  // bot-only regardless of the stored identity select; the select value is still
  // saved verbatim so it comes back when switching to personal mode. Re-apply
  // the lark-cli policy whenever the *effective* preset changes (covers both a
  // direct identity-select change and a personal↔team flip).
  const nextEffectiveIdentity: LarkCliIdentityPreset =
    mode === 'team' ? 'bot-only' : larkCliIdentity;
  const previousEffectiveIdentity = effectiveLarkCliIdentity(ctx.controls.profileConfig);
  const larkCliIdentityChanged = nextEffectiveIdentity !== previousEffectiveIdentity;

  const formMsgId = ctx.msg.messageId;
  const access = ctx.controls.profileConfig.access;

  // Detach: same reason as account submit — Lark's client locks the form
  // while the cardAction handler is running. Wait out FORM_SETTLE_MS *after*
  // returning so the in-place card update sticks.
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    const nextPreferences: AppPreferences = {
      ...(ctx.controls.cfg.preferences ?? {}),
      model,
      effort,
      messageReply,
      // Mark the messageReply value as living in the new (post-0.1.27)
      // semantic — `text` now means real plain text, not the lightweight
      // markdown card. Set unconditionally on every submit so a user who
      // explicitly picks any option gets out of the legacy-coerce path.
      messageReplyMigrated: true,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      smartSession,
      autoWorktreeCleanup,
      dream,
      dreamAuto,
    };

    let failureStep = 'config.save';
    let larkCliPolicyApplied = false;
    try {
      if (larkCliIdentityChanged) {
        failureStep = 'config.lark-cli-policy';
        const applied = await applyConfigLarkCliIdentityPolicy(ctx, nextEffectiveIdentity);
        if (!applied) {
          throw new Error('lark-cli identity policy apply failed');
        }
        larkCliPolicyApplied = true;
        failureStep = 'config.save';
      }
      await savePreferencesConfig(ctx, nextPreferences, requireMentionInGroup, larkCliIdentity, mode, approvalsEnabled);
    } catch (err) {
      let rollbackFailed = false;
      if (larkCliIdentityChanged) {
        const rolledBack = await applyConfigLarkCliIdentityPolicy(ctx, previousEffectiveIdentity);
        if (!rolledBack) {
          rollbackFailed = true;
          log.warn('command', 'lark-cli-identity-policy-rollback-failed', {
            profile: ctx.controls.profile,
            identity: previousEffectiveIdentity,
          });
        }
      }
      log.fail('command', err, { step: failureStep });
      reportMetric('command_fail', 1, { step: failureStep });
      await waitForSettle();
      await showResultCardInPlace(
        ctx,
        formMsgId,
        configFailedCard(configFailureMessage(failureStep, rollbackFailed, larkCliPolicyApplied)),
      );
      return;
    }

    log.info('command', 'config-saved', {
      mode,
      effort: effort ?? 'default',
      messageReply,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      larkCliIdentity,
      approvalsEnabled,
      smartSession,
      autoWorktreeCleanup,
      dream,
      dreamAuto,
      allowedUsersCount: access.allowedUsers.length,
      allowedChatsCount: access.allowedChats.length,
      adminsCount: access.admins.length,
    });
    await waitForSettle();
    await showResultCardInPlace(
      ctx,
      formMsgId,
      configSavedCard({
        agentKind,
        mode,
        model: modelSelection,
        effort,
        messageReply,
        showToolCalls,
        cotMessages,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        requireMentionInGroup,
        larkCliIdentity,
        approvalsEnabled,
        smartSession,
        autoWorktreeCleanup,
        dream,
        dreamAuto,
        allowedUsers: access.allowedUsers,
        allowedChats: access.allowedChats,
        admins: access.admins,
        knownChats: ctx.controls.knownChats ?? [],
      }),
    );

    // "群里不需要 @ bot" only works if the app can actually receive non-@
    // group messages (`im:message.group_msg`). When the user opts in, verify
    // the scope and, if missing, push a one-click re-authorization link.
    if (!requireMentionInGroup) {
      await promptGroupMsgScopeIfMissing(ctx);
    }
  })();
}

/**
 * When the user enables "群里不需要 @ bot", confirm the app holds the
 * `im:message.group_msg` scope. If it's missing, generate an incremental
 * authorization link and push a guidance card; once the user finishes
 * authorizing, swap the card to a success state in place. Best-effort — any
 * failure here is logged and swallowed (the saved-config card already showed).
 */
async function promptGroupMsgScopeIfMissing(ctx: CommandContext): Promise<void> {
  const appId = ctx.controls.cfg.accounts.app.id;
  // `false` = confirmed missing; `null` = lookup failed → don't nag.
  const has = await hasGroupMsgScope(ctx.channel, appId);
  if (has !== false) return;
  log.info('command', 'group-msg-scope-missing', { appId });

  let link;
  try {
    link = await requestScopeGrantLink({ appId, tenantScopes: [GROUP_MSG_SCOPE] });
  } catch (err) {
    log.warn('command', 'scope-grant-link-failed', { err: String(err) });
    return;
  }

  const expireMins = Math.max(1, Math.round(link.expireIn / 60));
  let sent;
  try {
    sent = await sendManagedCard(
      ctx.channel,
      ctx.msg.chatId,
      groupMsgScopeGrantCard(link.url, expireMins),
    );
  } catch (err) {
    log.warn('command', 'scope-grant-card-send-failed', { err: String(err) });
    return;
  }

  // Detached: flip the card to "授权成功" once the user authorizes (or just
  // clean up the managed-card mapping if the link expires / is aborted).
  void link.completion.then(
    async () => {
      log.info('command', 'group-msg-scope-granted', { appId });
      await updateManagedCard(ctx.channel, sent.messageId, groupMsgScopeGrantedCard()).catch(
        () => {},
      );
      forgetManagedCard(sent.messageId);
    },
    (err) => {
      log.info('command', 'scope-grant-not-completed', { err: String(err) });
      forgetManagedCard(sent.messageId);
    },
  );
}

function configFailureMessage(step: string, rollbackFailed: boolean, larkCliPolicyApplied: boolean): string {
  if (rollbackFailed) {
    return '保存失败，且 lark-cli 身份策略回滚失败。请执行 /status 检查当前状态。';
  }
  if (larkCliPolicyApplied && step === 'config.save') {
    return '保存失败，lark-cli 身份策略已回滚。请重新打开 /config 确认当前状态。';
  }
  if (step === 'config.lark-cli-policy') {
    return 'lark-cli 身份策略未生效，未做任何修改。';
  }
  return '配置未写入，未做任何修改。';
}

function commandProfilePaths(ctx: CommandContext) {
  return resolveAppPaths({
    rootDir: dirname(ctx.controls.configPath),
    profile: ctx.controls.profile,
  });
}

async function applyConfigLarkCliIdentityPolicy(
  ctx: CommandContext,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
): Promise<boolean> {
  return configOps.applyProfileLarkCliIdentity(ctx.controls, larkCliIdentity);
}

async function saveAccountConfig(
  ctx: CommandContext,
  newCfg: AppConfig,
  plaintextSecret: string,
): Promise<void> {
  return configOps.saveAccountConfig(ctx.controls, newCfg, plaintextSecret);
}

async function savePreferencesConfig(
  ctx: CommandContext,
  preferences: AppPreferences,
  requireMentionInGroup: boolean,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
  mode: ProfileMode,
  approvalsEnabled: boolean,
): Promise<void> {
  return configOps.savePreferencesConfig(
    ctx.controls,
    preferences,
    requireMentionInGroup,
    larkCliIdentity,
    mode,
    { approvalsEnabled },
  );
}

// ────────────── /meeting — in-meeting agent (智能体入会) ──────────────

/**
 * `/meeting` drives the bot's presence in a Feishu video meeting: join by
 * 9-digit number, leave, inspect what the session has captured, and ask the
 * agent a question with the meeting transcript as context.
 */
async function handleMeeting(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ');
  const manager = ctx.controls.meeting;

  if (!ctx.controls.profileConfig.meeting.enabled) {
    await reply(
      ctx,
      '会议智能体未启用。在 `/config` 或 Web 控制台里开启「会议智能体」后重启 bot 即可。',
    );
    return;
  }
  if (!manager) {
    await reply(ctx, '会议能力未就绪（channel 未连接或启用后尚未重启）。');
    return;
  }

  switch (sub) {
    case '':
    case 'status':
      await replyMeetingStatus(ctx, manager);
      return;
    case 'join': {
      const meetingNo = rest.replace(/\s/g, '');
      if (!isMeetingNo(meetingNo)) {
        await reply(ctx, '用法：`/meeting join <9位会议号>`（只接受 9 位纯数字，不是会议链接）');
        return;
      }
      try {
        const session = await manager.join(meetingNo, { originChatId: ctx.msg.chatId });
        await reply(
          ctx,
          `✅ 已入会 **${session.topic ?? meetingNo}**\n` +
            `会议号 ${session.meetingNo} · 会中发 \`${ctx.controls.profileConfig.meeting.trigger} 你的问题\` 可以问我\n` +
            '`/meeting notes` 总结 · `/meeting leave` 离会',
        );
      } catch (err) {
        await reply(ctx, `入会失败：${describeMeetingError(err)}`);
      }
      return;
    }
    case 'leave': {
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      await manager.leave(picked.session.meetingId);
      await reply(ctx, `✅ 已离会（会议号 ${picked.session.meetingNo}）`);
      return;
    }
    case 'transcript': {
      // Shows exactly what the agent is given as context. Without this, "why
      // did it mention X?" is unanswerable — the buffer is invisible.
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const lines = picked.session.recentTranscript();
      if (lines.length === 0) {
        await reply(
          ctx,
          '字幕缓冲为空 —— agent 这次拿到的会议上下文是「（暂无字幕）」。\n' +
            '注意：同一场会里 agent 复用一个会话，**早先轮次**的字幕仍留在它自己的对话历史里，' +
            '所以它可能引用缓冲里已经没有的内容。`/new` 可以清掉该会话记忆。',
        );
        return;
      }
      const tail = lines.slice(-30);
      await reply(
        ctx,
        [
          `字幕缓冲共 ${lines.length} 条${tail.length < lines.length ? `，以下是最近 ${tail.length} 条` : ''}：`,
          '```',
          ...tail,
          '```',
        ].join('\n'),
      );
      return;
    }
    case 'stop': {
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const stopped = ctx.activeRuns.interrupt(meetingScopeId(picked.session.meetingId));
      await reply(ctx, stopped ? '✅ 已中断该会议的当前任务。' : '该会议当前没有正在执行的任务。');
      return;
    }
    case 'notes':
    case 'ask': {
      // `notes` takes an optional meeting number; `ask` takes the question, so
      // only `notes` can disambiguate positionally.
      const picked = pickMeetingSession(manager, ctx, sub === 'notes' ? rest : '');
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const session = picked.session;
      const question =
        sub === 'notes'
          ? '请基于以上会议字幕做一份简洁纪要：讨论了什么、结论、待办（如有）。'
          : rest;
      if (!question) {
        await reply(ctx, '用法：`/meeting ask <问题>`');
        return;
      }
      if (!ctx.runExecutor) {
        await reply(ctx, '当前上下文无法执行 agent（缺少 run executor）。');
        return;
      }
      await reply(ctx, sub === 'notes' ? '正在总结会议…' : '正在思考…');
      try {
        const answer = await answerInMeeting(
          {
            session,
            channel: ctx.channel,
            controls: ctx.controls,
            executor: ctx.runExecutor,
            activeRuns: ctx.activeRuns,
            sessions: ctx.sessions,
            ...(ctx.sessionCatalog ? { sessionCatalog: ctx.sessionCatalog } : {}),
            workspaces: ctx.workspaces,
          },
          question,
          // Typed privately -> answer only to the caller. Broadcasting a
          // summary somebody asked for in a DM would surprise the meeting.
          { deliver: 'caller' },
        );
        await reply(ctx, answer || '（没有产生回答）');
      } catch (err) {
        await reply(ctx, `执行失败：${describeMeetingError(err)}`);
      }
      return;
    }
    default:
      await reply(
        ctx,
        [
          '用法：',
          '`/meeting` — 状态',
          '`/meeting join <9位会议号>` — 让 bot 入会',
          '`/meeting leave [会议号]` — 离会',
          '`/meeting notes [会议号]` — 基于字幕做纪要（只发给你）',
          '`/meeting stop [会议号]` — 中断该会议卡住的任务',
          '`/meeting transcript [会议号]` — 看 agent 实际拿到的字幕上下文',
          '`/meeting ask <问题>` — 带会议上下文提问',
        ].join('\n'),
      );
  }
}

type PickedSession =
  | { ok: true; session: MeetingSession }
  | { ok: false; message: string };

/**
 * Resolve which meeting a command targets when the bot may be in several.
 *
 * Order: explicit 9-digit number → the only meeting → the only meeting joined
 * from *this* chat → otherwise ask, listing the candidates. Silently defaulting
 * to "the first one" would act on the wrong meeting.
 */
function pickMeetingSession(
  manager: MeetingManager,
  ctx: CommandContext,
  explicit: string,
): PickedSession {
  const wanted = explicit.replace(/\s/g, '');
  if (wanted) {
    const found = manager.byMeetingNo(wanted);
    return found
      ? { ok: true, session: found }
      : { ok: false, message: `没找到会议号 ${wanted} 对应的会议。用 \`/meeting\` 看当前在跟哪几场。` };
  }

  const all = manager.all();
  if (all.length === 0) {
    return { ok: false, message: '当前没有在跟的会议。先 `/meeting join <9位会议号>`。' };
  }
  if (all.length === 1) return { ok: true, session: all[0]! };

  // Multiple meetings: prefer the one started from this chat.
  const fromHere = all.filter((s) => s.originChatId === ctx.msg.chatId);
  if (fromHere.length === 1) return { ok: true, session: fromHere[0]! };

  const list = all.map((s) => `- ${s.meetingNo}${s.topic ? `（${s.topic}）` : ''}`).join('\n');
  return {
    ok: false,
    message: `当前在跟 ${all.length} 场会议，请指定会议号：\n${list}\n\n例如 \`/meeting notes ${all[0]!.meetingNo}\``,
  };
}

async function replyMeetingStatus(ctx: CommandContext, manager: MeetingManager): Promise<void> {
  const sessions = manager.list();
  const push = manager.pushHealth();
  const pushLine = push.hooked
    ? `推送：已挂载，累计收到 ${push.received} 条${push.received === 0 ? '（尚未收到，可能还没在后台订阅 vc.bot.* 事件）' : ''}`
    : `推送：未挂载（${push.reason ?? '未知原因'}），仅靠轮询`;

  if (sessions.length === 0) {
    await reply(ctx, [`当前没有在跟的会议。`, pushLine, '', '`/meeting join <9位会议号>` 开始。'].join('\n'));
    return;
  }
  const lines = sessions.map(
    (s) =>
      `- **${s.topic ?? s.meetingNo}**（${s.meetingNo}）· 来源 ${s.source === 'push' ? '推送' : '轮询'}` +
      ` · 字幕 ${s.transcriptLines} 条 · 参会 ${s.participants} 人`,
  );
  await reply(ctx, [`正在跟 ${sessions.length} 场会议：`, ...lines, '', pushLine].join('\n'));
}
