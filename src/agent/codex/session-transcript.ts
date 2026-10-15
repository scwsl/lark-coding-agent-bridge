import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseBridgePromptRequest } from '../prompt';
import { parseRecordTime, TranscriptBuilder, type AgentTranscript } from '../transcript-builder';
import { findRollout } from './thread-usage';

interface RolloutRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: { type?: unknown; role?: unknown; phase?: unknown; content?: unknown };
}

/**
 * Chat requests and final answers of a Codex thread, in order, from its rollout
 * (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`). Progress
 * commentary, tool calls and reasoning are skipped.
 */
export async function readCodexTranscript(codexHome: string, threadId: string): Promise<AgentTranscript | undefined> {
  if (!/^[A-Za-z0-9-]+$/.test(threadId)) return undefined;
  const file = await findRollout(join(codexHome, 'sessions'), threadId);
  if (!file) return undefined;
  const builder = new TranscriptBuilder();
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"response_item"')) continue;
    let rec: RolloutRecord;
    try {
      rec = JSON.parse(line) as RolloutRecord;
    } catch {
      continue;
    }
    if (rec.type !== 'response_item' || rec.payload?.type !== 'message') continue;
    const at = parseRecordTime(rec.timestamp);
    builder.seen(at);
    if (rec.payload.role === 'user') {
      const text = blocksText(rec.payload.content, 'input_text');
      const request = text.includes('<user_input>') ? parseBridgePromptRequest(text) : undefined;
      if (request) builder.request({ ...request, ...(at !== undefined ? { at } : {}) });
    } else if (rec.payload.role === 'assistant') {
      // Older rollouts carry no phase; newer ones mark progress notes `commentary`.
      if (rec.payload.phase !== undefined && rec.payload.phase !== 'final_answer') continue;
      builder.answer(blocksText(rec.payload.content, 'output_text'));
    }
  }
  return builder.result();
}

function blocksText(content: unknown, kind: string): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' && (block as { type?: unknown }).type === kind
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .filter(Boolean)
    .join('\n');
}
