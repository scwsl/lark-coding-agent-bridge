import type { AgentCapability } from '../agent/capability';
import { resolveEffortArg, resolveModelArg } from '../agent/models';
import type { AgentEvent } from '../agent/types';
import type { ProfileConfig } from '../config/profile-schema';
import type { AccessDecision } from '../policy/access';
import {
  evaluateRunPolicy,
  type AgentAttachment,
  type RunPolicyAllow,
  type RunPolicyReject,
  type ScopeContext,
} from '../policy/run-policy';
import {
  resolveWorkingDirectory,
  type WorkingDirectoryRejectReason,
  type WorkingDirectoryResolveResult,
} from '../policy/workspace';
import type { BackgroundTurnHandler, RunExecution, RunExecutor } from '../runtime/run-executor';
import type { GateContext } from '../runtime/approvals';
import { RunRejected, type RunRejectedCode } from '../runtime/errors';
import type { AgentSessionProbe } from '../agent/session-probe';
import { effortPrefForChat, type SmartSessionSettings } from '../config/schema';
import type { SessionCatalog } from '../session/catalog';
import {
  decideRotation,
  handoffSection,
  type PendingRotation,
  type RotationVerdict,
} from '../session/smart-session';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import type { RunGuard } from '../policy/owner-guard';

export interface StartRunFlowInput {
  scopeId: string;
  scope: ScopeContext;
  prompt: string;
  attachments: AgentAttachment[];
  access: AccessDecision;
  capability: AgentCapability;
  profileConfig: ProfileConfig;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  executor: RunExecutor;
  now: number;
  /** Display name of `scope.actorId`, for usage reports. */
  actorName?: string;
  /** Set when a non-admin drives the run (see SubmitRunInput.gate). */
  gate?: GateContext;
  /** Passed to the executor as `SubmitRunInput.onBackgroundTurn`. */
  onBackgroundTurn?: BackgroundTurnHandler;
  stopGraceMs?: number;
  /** Limits for a run the bot owner didn't start (see ownerOnlyGuard). */
  guard?: RunGuard;
  /** Working directory pinned by the chat (`access.restrictedChats`); wins over `/cd`. */
  cwd?: string;
  /** 会话智能压缩: see AgentRunOptions.compactWindowTokens. */
  compactWindowTokens?: number;
  /**
   * 会话智能压缩 (IM only): may leave the conversation this message would
   * resume and start fresh. Leave unset to always resume.
   */
  rotation?: {
    settings: SmartSessionSettings;
    /** The agent asked to close the conversation at the end of its last answer. */
    pending?: PendingRotation;
    probe: (handle: string, cwd: string) => Promise<AgentSessionProbe | undefined>;
  };
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export type RunFlowRejectCode =
  | WorkingDirectoryRejectReason
  | RunPolicyReject['rejectReason']['code']
  | RunRejectedCode;

export type StartRunFlowResult =
  | {
      ok: true;
      execution: RunExecution;
      policy: RunPolicyAllow;
      cwdRealpath: string;
      resumeFrom?: string;
      /** Set when 会话智能压缩 archived the conversation this message would have resumed. */
      rotated?: RotationVerdict;
    }
  | {
      ok: false;
      rejectReason: {
        code: RunFlowRejectCode;
        userVisible: string;
      };
      workspace?: WorkingDirectoryResolveResult;
    };

export interface RecordRunSessionEventInput {
  scopeId: string;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  capability: AgentCapability;
  policy: RunPolicyAllow;
  event: AgentEvent;
}

export async function startRunFlow(input: StartRunFlowInput): Promise<StartRunFlowResult> {
  const requestedCwd =
    input.cwd ?? input.workspaces.cwdFor(input.scopeId) ?? input.profileConfig.workspaces.default ?? '';
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    return {
      ok: false,
      rejectReason: {
        code: workspace.reason,
        userVisible: workspace.userVisible,
      },
      workspace,
    };
  }

  const policy = evaluateRunPolicy({
    scope: input.scope,
    attachments: input.attachments,
    prompt: input.prompt,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    capability: input.capability,
    profileConfig: input.profileConfig,
    now: input.now,
    codexHome: input.profileConfig.codex?.codexHome,
    inheritCodexHome: input.profileConfig.codex?.inheritCodexHome,
  });
  if (!policy.ok) {
    return {
      ok: false,
      rejectReason: policy.rejectReason,
      workspace,
    };
  }

  const { descriptor } = input.capability;
  let resumeFrom: string | undefined;
  if (input.sessionCatalog) {
    const catalogEntry = input.sessionCatalog.activeFor({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
    });
    resumeFrom = catalogEntry?.[descriptor.sessionHandle];
  }
  if (!resumeFrom && descriptor.scopeSessionStore) {
    resumeFrom = input.sessions.resumeFor(input.scopeId, workspace.cwdRealpath);
    const stale = input.sessions.getRaw(input.scopeId);
    if (!resumeFrom && stale?.cwd && stale.cwd !== workspace.cwdRealpath) {
      input.sessions.clear(input.scopeId);
    }
  }
  let runPolicy = policy;
  let rotated: RotationVerdict | undefined;
  if (resumeFrom && input.rotation) {
    const probe = await input.rotation.probe(resumeFrom, workspace.cwdRealpath).catch(() => undefined);
    rotated = decideRotation({
      settings: input.rotation.settings,
      probe,
      ...(input.rotation.pending ? { pending: input.rotation.pending } : {}),
      resumeHandle: resumeFrom,
      now: input.now,
    });
    if (rotated) {
      // Same as `/new`: the conversation stays listed in /resume.
      input.sessionCatalog?.archiveActive({
        scopeId: input.scopeId,
        agentId: input.capability.agentId,
        cwdRealpath: workspace.cwdRealpath,
        policyFingerprint: policy.policyFingerprint,
        now: input.now,
      });
      if (descriptor.scopeSessionStore) input.sessions.clear(input.scopeId);
      resumeFrom = undefined;
      runPolicy = { ...policy, prompt: `${handoffSection(rotated)}\n\n${policy.prompt}` };
    }
  }
  const sessionId = descriptor.sessionHandle === 'sessionId' ? resumeFrom : undefined;
  const threadId = descriptor.sessionHandle === 'threadId' ? resumeFrom : undefined;

  let execution: RunExecution;
  try {
    execution = await input.executor.submit({
      scopeId: input.scopeId,
      policy: runPolicy,
      sessionId,
      threadId,
      model: resolveModelArg(
        input.profileConfig.agentKind,
        input.profileConfig.preferences.model,
      ),
      effort: resolveEffortArg(
        input.profileConfig.agentKind,
        effortPrefForChat(input.profileConfig.preferences, input.scope.chatId),
      ),
      images:
        descriptor.imageArgs
          ? policy.attachments
              .filter((attachment) => attachment.kind === 'image' && attachment.decision === 'accepted')
              .map((attachment) => attachment.path)
              .filter((path): path is string => Boolean(path))
          : undefined,
      stopGraceMs: input.stopGraceMs,
      ...(input.guard ? { guard: input.guard } : {}),
      ...(input.compactWindowTokens ? { compactWindowTokens: input.compactWindowTokens } : {}),
      // Adapters without subagents (Codex) ignore it.
      ...(input.profileConfig.preferences.subagentModel ? { subagentModel: input.profileConfig.preferences.subagentModel } : {}),
      actor: { id: input.scope.actorId, ...(input.actorName ? { name: input.actorName } : {}) },
      ...(input.scope.chatId ? { chatId: input.scope.chatId } : {}),
      ...(input.gate ? { gate: input.gate } : {}),
      onBackgroundTurn: input.onBackgroundTurn,
      observability: input.observability,
    });
  } catch (err) {
    if (err instanceof RunRejected) {
      return {
        ok: false,
        rejectReason: {
          code: err.code,
          userVisible:
            err.code === 'reconnect-in-progress'
              ? '当前 bot 正在重连，稍后会继续处理新消息。'
              : err.code === 'run-already-active'
                ? '当前会话已有运行在执行，请稍后再试或先停止当前运行。'
              : '当前无法发起运行，请稍后重试。',
        },
        workspace,
      };
    }
    throw err;
  }

  return {
    ok: true,
    execution,
    policy: runPolicy,
    cwdRealpath: workspace.cwdRealpath,
    ...(resumeFrom ? { resumeFrom } : {}),
    ...(rotated ? { rotated } : {}),
  };
}

export function recordRunSessionEvent(input: RecordRunSessionEventInput): void {
  if (input.event.type !== 'system') return;
  const { descriptor } = input.capability;
  const handle = input.event[descriptor.sessionHandle];
  if (!handle) return;
  const cwdRealpath = input.event.cwd ?? input.policy.cwdRealpath;
  if (descriptor.scopeSessionStore) input.sessions.set(input.scopeId, handle, cwdRealpath);
  input.sessionCatalog?.upsertActive({
    scopeId: input.scopeId,
    agentId: input.capability.agentId,
    cwdRealpath,
    policyFingerprint: input.policy.policyFingerprint,
    [descriptor.sessionHandle]: handle,
  });
}
