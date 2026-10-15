import type { ProfileConfig } from '../config/profile-schema';
import { probeClaudeSession } from './claude/session-probe';
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
