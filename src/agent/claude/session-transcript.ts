import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseBridgePromptRequest } from '../prompt';
import { parseRecordTime, TranscriptBuilder, type AgentTranscript } from '../transcript-builder';
import { transcriptPath } from './session-cost';

interface TranscriptRecord {
  type?: unknown;
  isSidechain?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
}

/**
 * Chat requests and final answers of a Claude Code session, in order, from its
 * transcript (`~/.claude/projects/<cwd>/<sessionId>.jsonl`). Sub-agent
 * (sidechain) records, tool results and thinking are skipped.
 */
export async function readClaudeTranscript(
  sessionId: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentTranscript | undefined> {
  const file = transcriptPath(sessionId, cwd, env);
  if (!file) return undefined;
  const builder = new TranscriptBuilder();
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let rec: TranscriptRecord;
    try {
      rec = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    if (rec.isSidechain === true) continue;
    const at = parseRecordTime(rec.timestamp);
    builder.seen(at);
    if (rec.type === 'user') {
      const text = blocksText(rec.message?.content);
      const request = text.includes('<user_input>') ? parseBridgePromptRequest(text) : undefined;
      if (request) builder.request({ ...request, ...(at !== undefined ? { at } : {}) });
    } else if (rec.type === 'assistant') {
      builder.answer(blocksText(rec.message?.content));
    }
  }
  return builder.result();
}

/** Text of a message's content: a plain string or the `text` blocks of an array. */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .filter(Boolean)
    .join('\n');
}
