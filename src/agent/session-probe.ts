import type { ProfileConfig } from '../config/profile-schema';
import { claudeSessionHasKnowledge, probeClaudeSession } from './claude/session-probe';
import { effectiveCodexHome } from './codex/account';
import { probeCodexSession } from './codex/session-probe';
import type { AgentKind } from './registry';

/**
 * What the bridge can tell about a stored conversation without resuming it —
 * read from the agent CLI's own transcript. Every field is best-effort and
 * absent when the transcript cannot say.
 */
export interface AgentSessionProbe {
  /** When the conversation last got a model response (epoch ms). */
  lastActivityAt?: number;
  /**
   * Prompt size of the conversation's latest model call, cached part included:
   * roughly what every call of the next turn re-reads.
   */
  contextTokens?: number;
  /** The last request the user made in it, for the hand-off note. */
  lastUserText?: string;
}

type ProbeProfile = Pick<ProfileConfig, 'agentKind' | 'codex'>;

const SESSION_PROBES: Record<
  AgentKind,
  (profileConfig: ProbeProfile, handle: string, cwd: string) => Promise<AgentSessionProbe | undefined>
> = {
  claude: (_profileConfig, handle, cwd) => probeClaudeSession(handle, cwd),
  codex: (profileConfig, handle) => {
    const home = effectiveCodexHome(profileConfig.codex);
    return home ? probeCodexSession(home, handle) : Promise.resolve(undefined);
  },
};

const KNOWLEDGE_CHECKS: Record<AgentKind, ((handle: string, cwd: string, version: string) => boolean) | undefined> = {
  claude: (handle, cwd, version) => claudeSessionHasKnowledge(handle, cwd, version),
  // Codex keeps its thread elsewhere; it always gets the full block.
  codex: undefined,
};

/**
 * Whether the conversation `handle` still holds the full `<bridge_knowledge>`
 * block of `version` (not compacted away since). False when the agent cannot
 * tell. Never throws.
 */
export function sessionHasKnowledge(profileConfig: ProbeProfile, handle: string, cwd: string, version: string): boolean {
  try {
    return KNOWLEDGE_CHECKS[profileConfig.agentKind]?.(handle, cwd, version) ?? false;
  } catch {
    return false;
  }
}

/**
 * Probe the conversation `handle` (a Claude session id or a Codex thread id,
 * per the agent's descriptor) of the profile's agent. Never throws.
 */
export async function probeAgentSession(
  profileConfig: ProbeProfile,
  handle: string,
  cwd: string,
): Promise<AgentSessionProbe | undefined> {
  try {
    return await SESSION_PROBES[profileConfig.agentKind]?.(profileConfig, handle, cwd);
  } catch {
    return undefined;
  }
}
