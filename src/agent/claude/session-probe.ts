import { linesBackward } from '../../utils/reverse-lines';
import { extractUserInputText } from '../prompt';
import type { AgentSessionProbe } from '../session-probe';
import { transcriptPath } from './session-cost';

const ASSISTANT = Buffer.from('"type":"assistant"');
const USER = Buffer.from('"type":"user"');
const USER_INPUT = Buffer.from('<user_input>');
/** Enough tail to reach the last request even after a long tool-heavy turn. */
const MAX_SCAN_BYTES = 16 * 1024 * 1024;

interface TranscriptRecord {
  type?: unknown;
  isSidechain?: unknown;
  timestamp?: unknown;
  message?: {
    content?: unknown;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/**
 * Last model call (time and prompt size) and last user request of a Claude
 * Code session, read backwards from its transcript
 * (`~/.claude/projects/<cwd>/<sessionId>.jsonl`).
 */
export async function probeClaudeSession(
  sessionId: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentSessionProbe | undefined> {
  const file = transcriptPath(sessionId, cwd, env);
  if (!file) return undefined;
  const probe: AgentSessionProbe = {};
  let haveCall = false;
  for (const line of linesBackward(file, { maxBytes: MAX_SCAN_BYTES })) {
    if (!haveCall && line.includes(ASSISTANT)) {
      const rec = parse(line);
      const usage = rec?.message?.usage;
      if (rec && rec.type === 'assistant' && rec.isSidechain !== true && usage) {
        const tokens =
          (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN;
        if (tokens > 0) {
          probe.contextTokens = tokens;
          if (Number.isFinite(at)) probe.lastActivityAt = at;
          haveCall = true;
        }
      }
    } else if (line.includes(USER) && line.includes(USER_INPUT)) {
      const rec = parse(line);
      if (rec && rec.type === 'user' && rec.isSidechain !== true) {
        const text = userText(rec.message?.content);
        const asked = text ? extractUserInputText(text) : undefined;
        if (asked) {
          probe.lastUserText = asked;
          break;
        }
      }
    }
  }
  return haveCall || probe.lastUserText ? probe : undefined;
}

function parse(line: Buffer): TranscriptRecord | undefined {
  try {
    return JSON.parse(line.toString('utf8')) as TranscriptRecord;
  } catch {
    return undefined;
  }
}

function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.includes('<user_input>')) return b.text;
  }
  return undefined;
}

const COMPACT_BOUNDARY = Buffer.from('"compact_boundary"');

/**
 * Whether the session's live context still holds the full knowledge block of
 * `version`: a user message carrying it after the last compaction, within the
 * transcript's last {@link MAX_SCAN_BYTES}. False when unsure (no transcript,
 * compacted since, too far back), so the caller sends the block again.
 */
export function claudeSessionHasKnowledge(
  sessionId: string,
  cwd: string | undefined,
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!/^[0-9a-f]+$/.test(version)) return false;
  const file = transcriptPath(sessionId, cwd, env);
  if (!file) return false;
  // As written inside the transcript's JSON string: `\"version\":\"<v>\"`.
  const marker = Buffer.from(`\\"version\\":\\"${version}\\"`);
  try {
    for (const line of linesBackward(file, { maxBytes: MAX_SCAN_BYTES })) {
      if (line.includes(COMPACT_BOUNDARY)) return false;
      if (line.includes(USER) && line.includes(marker)) {
        const rec = parse(line);
        if (rec && rec.type === 'user' && rec.isSidechain !== true) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}
