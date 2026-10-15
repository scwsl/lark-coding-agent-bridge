import { join } from 'node:path';
import { linesBackward } from '../../utils/reverse-lines';
import { extractUserInputText } from '../prompt';
import type { AgentSessionProbe } from '../session-probe';
import { findRollout } from './thread-usage';

const TOKEN_COUNT = Buffer.from('"token_count"');
const USER_ROLE = Buffer.from('"role":"user"');
const USER_INPUT = Buffer.from('<user_input>');
const MAX_SCAN_BYTES = 16 * 1024 * 1024;

interface RolloutRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: {
    type?: unknown;
    role?: unknown;
    content?: unknown;
    info?: { last_token_usage?: { input_tokens?: unknown } } | null;
  };
}

/**
 * Last model call (time and prompt size) and last user request of a Codex
 * thread, read backwards from its rollout
 * (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`).
 */
export async function probeCodexSession(codexHome: string, threadId: string): Promise<AgentSessionProbe | undefined> {
  const file = await findRollout(join(codexHome, 'sessions'), threadId);
  if (!file) return undefined;
  const probe: AgentSessionProbe = {};
  let haveCall = false;
  for (const line of linesBackward(file, { maxBytes: MAX_SCAN_BYTES })) {
    if (!haveCall && line.includes(TOKEN_COUNT)) {
      const rec = parse(line);
      const input = rec?.payload?.type === 'token_count' ? rec.payload.info?.last_token_usage?.input_tokens : undefined;
      if (typeof input === 'number' && input > 0) {
        probe.contextTokens = input;
        const at = typeof rec?.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN;
        if (Number.isFinite(at)) probe.lastActivityAt = at;
        haveCall = true;
      }
    } else if (line.includes(USER_ROLE) && line.includes(USER_INPUT)) {
      const rec = parse(line);
      if (rec?.type === 'response_item' && rec.payload?.type === 'message' && rec.payload.role === 'user') {
        const asked = inputText(rec.payload.content);
        if (asked) {
          probe.lastUserText = asked;
          break;
        }
      }
    }
  }
  return haveCall || probe.lastUserText ? probe : undefined;
}

function parse(line: Buffer): RolloutRecord | undefined {
  try {
    return JSON.parse(line.toString('utf8')) as RolloutRecord;
  } catch {
    return undefined;
  }
}

function inputText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b?.type === 'input_text' && typeof b.text === 'string') {
      const asked = extractUserInputText(b.text);
      if (asked) return asked;
    }
  }
  return undefined;
}
