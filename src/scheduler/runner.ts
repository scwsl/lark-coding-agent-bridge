import type { LarkChannel } from '@larksuite/channel';
import { agentAccountName } from '../agent/account';
import { agentCapability } from '../agent/capability';
import { agentDescriptor } from '../agent/registry';
import { modelLabel, resolveEffortArg } from '../agent/models';
import { processAgentStream } from '../bot/agent-stream';
import { recordRunSessionEvent, startRunFlow } from '../bot/run-flow';
import { renderCard, type RunCardRenderOptions } from '../card/run-renderer';
import type { RunState } from '../card/run-state';
import { renderText } from '../card/text-renderer';
import { promptSection } from '../agent/prompt';
import { buildKnowledgeContext } from '../knowledge/inject';
import type { Controls } from '../commands';
import { getMessageReplyMode, getRunIdleTimeoutMs, getShowToolCalls } from '../config/schema';
import { log } from '../core/logger';
import { canUseDm, canUseGroup } from '../policy/access';
import type { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { describeCron } from './cron';
import type { JobRunRecord, ScheduledJob } from './types';

export interface JobRunnerDeps {
  channel: LarkChannel;
  executor: RunExecutor;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  controls: Controls;
}

/** Session scope for a job — one conversation per job, never shared with a chat. */
export function jobScopeId(jobId: string): string {
  return `cron:${jobId}`;
}

/**
 * Run one scheduled job end to end: re-check the creator's access, submit the
 * run, drain it, and deliver the result into the job's chat.
 *
 * Never throws — a scheduler tick must survive one bad job, so every failure
 * comes back as a {@link JobRunRecord} with `ok: false` instead.
 */
export async function runScheduledJob(
  deps: JobRunnerDeps,
  job: ScheduledJob,
): Promise<JobRunRecord> {
  const startedAt = Date.now();
  const fail = (error: string): JobRunRecord => ({
    startedAt,
    finishedAt: Date.now(),
    ok: false,
    error,
  });

  // The creator's access is authority, re-evaluated on every fire: a job must
  // not outlive the permission that created it (`/remove user @them` has to
  // disarm whatever they scheduled, without anyone hunting for job ids).
  const access =
    job.chatType === 'p2p'
      ? canUseDm(deps.controls.profileConfig, deps.controls, job.creatorId)
      : canUseGroup(deps.controls.profileConfig, deps.controls, job.chatId, job.creatorId);
  if (!access.ok) {
    log.warn('scheduler', 'job-access-denied', { jobId: job.id, reason: access.reason });
    return fail(`创建者已无权限（${access.reason}）`);
  }

  const scopeId = jobScopeId(job.id);
  // The job remembers where it was created; without this the run would land in
  // whatever directory the scope happens to hold (or the profile default).
  if (job.cwd) deps.workspaces.setCwd(scopeId, job.cwd);
  // `fresh` is the default for a reason: a daily job that resumed forever would
  // drag a year of unrelated transcript into every run.
  if (job.session === 'fresh') deps.sessions.clear(scopeId);

  const capability = agentCapability(deps.controls.profileConfig);

  const flow = await startRunFlow({
    scopeId,
    scope: {
      source: 'cron',
      actorId: job.creatorId,
      chatId: job.chatId,
      ...(job.threadId ? { threadId: job.threadId } : {}),
    },
    prompt: await buildJobPrompt(deps, job, startedAt),
    attachments: [],
    access,
    capability,
    profileConfig: deps.controls.profileConfig,
    sessions: deps.sessions,
    ...(deps.sessionCatalog ? { sessionCatalog: deps.sessionCatalog } : {}),
    workspaces: deps.workspaces,
    executor: deps.executor,
    now: Date.now(),
    observability: {
      profile: deps.controls.profile,
      agent: capability.agentId,
      source: 'cron',
      stage: 'submit',
    },
  });
  if (!flow.ok) {
    log.info('scheduler', 'job-rejected', { jobId: job.id, code: flow.rejectReason.code });
    return fail(flow.rejectReason.userVisible);
  }

  log.info('scheduler', 'job-started', {
    jobId: job.id,
    runId: flow.execution.runId,
    cwd: flow.cwdRealpath,
    resumed: Boolean(flow.resumeFrom),
  });

  let state: RunState;
  try {
    state = await processAgentStream(
      flow.execution.handle,
      flow.execution.subscribe(),
      scopeId,
      getRunIdleTimeoutMs(deps.controls.cfg),
      (event) =>
        recordRunSessionEvent({
          scopeId,
          sessions: deps.sessions,
          ...(deps.sessionCatalog ? { sessionCatalog: deps.sessionCatalog } : {}),
          capability,
          policy: flow.policy,
          event,
        }),
      async () => {},
    );
  } catch (err) {
    log.fail('scheduler', err, { jobId: job.id, step: 'stream' });
    return fail(err instanceof Error ? err.message : String(err));
  }

  const visible = getShowToolCalls(deps.controls.cfg)
    ? state
    : { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool'), reasoning: { content: '', active: false } };

  await deliver(deps, job, visible).catch((err: unknown) => {
    log.fail('scheduler', err, { jobId: job.id, step: 'deliver' });
  });

  const ok = state.terminal === 'done';
  log.info('scheduler', 'job-finished', {
    jobId: job.id,
    terminal: state.terminal,
    durationMs: Date.now() - startedAt,
  });
  return {
    startedAt,
    finishedAt: Date.now(),
    ok,
    terminal: state.terminal,
    ...(ok ? {} : { error: state.errorMsg ?? `运行结束状态：${state.terminal}` }),
  };
}

/**
 * Deliver the finished run into the job's chat.
 *
 * A scheduled run has no message to stream a reply onto and nobody is
 * necessarily watching when it starts, so the result goes out as one finished
 * message rather than a live card. In a topic group it replies to the message
 * that created the job, which is the only way to land inside that topic.
 */
async function deliver(deps: JobRunnerDeps, job: ScheduledJob, state: RunState): Promise<void> {
  const body = renderText(state);
  if (!body.trim()) {
    log.info('scheduler', 'deliver-skip-empty', { jobId: job.id });
    return;
  }
  const replyMode = getMessageReplyMode(deps.controls.cfg);
  const header = `⏰ 定时任务 \`${job.id}\` · ${scheduleLabel(job)}`;
  const payload =
    replyMode === 'card'
      ? { card: renderCard(headedState(state, header), await cardOptions(deps)) }
      : { markdown: `${header}\n\n${body}` };
  await sendToJobChat(deps, job, payload);
}

/** Post a plain notice (failure, auto-disable) into the job's chat. */
export async function notifyJobChat(
  deps: JobRunnerDeps,
  job: ScheduledJob,
  markdown: string,
): Promise<void> {
  await sendToJobChat(deps, job, { markdown }).catch((err: unknown) => {
    log.warn('scheduler', 'notify-failed', { jobId: job.id, err: String(err) });
  });
}

async function sendToJobChat(
  deps: JobRunnerDeps,
  job: ScheduledJob,
  payload: { markdown: string } | { card: object },
): Promise<void> {
  const threaded =
    job.threadId && job.anchorMessageId
      ? { replyTo: job.anchorMessageId, replyInThread: true }
      : undefined;
  if (threaded) {
    try {
      await deps.channel.send(job.chatId, payload, threaded);
      return;
    } catch (err) {
      // The anchor can be recalled or expire; a job whose topic anchor is gone
      // should still deliver, just at chat level.
      log.warn('scheduler', 'thread-send-failed', { jobId: job.id, err: String(err) });
    }
  }
  await deps.channel.send(job.chatId, payload);
}

async function cardOptions(deps: JobRunnerDeps): Promise<RunCardRenderOptions> {
  const { profileConfig } = deps.controls;
  return {
    meta: {
      title: deps.channel.botIdentity?.name ?? deps.controls.profile,
      agent: profileConfig.agentKind,
      model: modelLabel(profileConfig.agentKind, profileConfig.preferences.model),
      effort: resolveEffortArg(profileConfig.agentKind, profileConfig.preferences.effort),
      provider: agentDescriptor(profileConfig.agentKind).provider,
      sponsor: await agentAccountName(profileConfig),
    },
  };
}

/** Put the job banner in front of the rendered answer so the card self-identifies. */
function headedState(state: RunState, header: string): RunState {
  return {
    ...state,
    blocks: [{ kind: 'text', content: `${header}\n\n`, streaming: false }, ...state.blocks],
  };
}

export function scheduleLabel(job: ScheduledJob): string {
  if (job.schedule.kind === 'cron') return describeCron(job.schedule.expr);
  return `单次 ${formatTime(job.schedule.at)}`;
}

export function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Frame the ask so the agent knows it is running unattended: nobody is waiting
 * to answer a clarifying question, and the reply lands in a chat as-is.
 *
 * The job's own chat memory and the profile's skill index come along too: a
 * scheduled run has no conversation to pick context up from, so without this it
 * would be the one place the bot forgets everything it was taught.
 */
async function buildJobPrompt(
  deps: JobRunnerDeps,
  job: ScheduledJob,
  firedAt: number,
): Promise<string> {
  const store = deps.controls.knowledge;
  // Chat memory is keyed by the *originating* chat's scope, not the job's own
  // `cron:<id>` scope — the job should inherit what that conversation taught
  // the bot, which is where it was created.
  const originScope = job.threadId ? `${job.chatId}:${job.threadId}` : job.chatId;
  const knowledge = store
    ? await buildKnowledgeContext({ store, scopeId: originScope }).catch(() => undefined)
    : undefined;
  return [
    ...(knowledge ? [promptSection('bridge_knowledge', knowledge), ''] : []),
    `[定时任务 ${job.id}]`,
    `本次运行由 bridge 调度器在 ${formatTime(firedAt)} 触发（${scheduleLabel(job)}），没有人在旁边等着回答追问。`,
    '请直接完成任务并给出可以直接发到群里的结论；需要澄清的地方按最合理的假设推进，并在结论里说明假设。',
    '',
    '任务内容：',
    job.prompt,
  ].join('\n');
}
