import type { ProfileConfig } from '../config/profile-schema';
import { readClaudeTranscript } from './claude/session-transcript';
import { effectiveCodexHome } from './codex/account';
import { readCodexTranscript } from './codex/session-transcript';
import type { AgentKind } from './registry';
import type { AgentTranscript } from './transcript-builder';

export type { AgentTranscript, TranscriptExchange } from './transcript-builder';

type TranscriptProfile = Pick<ProfileConfig, 'codex'>;

const TRANSCRIPT_READERS: Record<
  AgentKind,
  (profileConfig: TranscriptProfile, handle: string, cwd: string) => Promise<AgentTranscript | undefined>
> = {
  claude: (_profileConfig, handle, cwd) => readClaudeTranscript(handle, cwd),
  codex: (profileConfig, handle) => {
    const home = effectiveCodexHome(profileConfig.codex);
    return home ? readCodexTranscript(home, handle) : Promise.resolve(undefined);
  },
};

/**
 * Read the conversation `handle` (a Claude session id or a Codex thread id, per
 * the agent's descriptor) of agent `agentKind`. Only that one conversation's
 * file is opened — never a scan of the host's other history. Undefined when
 * the transcript is missing or unreadable; never throws.
 */
export async function readAgentTranscript(
  agentKind: AgentKind,
  profileConfig: TranscriptProfile,
  handle: string,
  cwd: string,
): Promise<AgentTranscript | undefined> {
  try {
    return await TRANSCRIPT_READERS[agentKind]?.(profileConfig, handle, cwd);
  } catch {
    return undefined;
  }
}
