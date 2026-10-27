/**
 * One chat request in a stored conversation and the answer the agent gave to
 * it, as read back from the agent CLI's own transcript. Tool calls, tool
 * output, reasoning and progress commentary are left out: only what the
 * person asked and what the bot finally said.
 */
export interface TranscriptExchange {
  /** 1-based position among the conversation's chat requests. */
  index: number;
  /** When the request reached the agent (epoch ms). */
  at?: number;
  senderId?: string;
  senderName?: string;
  senderType?: 'user' | 'bot';
  /** Several speakers merged into one request; see `BridgePromptRequest`. */
  mixedSenders: boolean;
  user: string;
  assistant: string;
  /**
   * Markdown files the agent's tool calls named while answering (absolute or
   * `~/` paths, at most {@link MAX_EXCHANGE_READS}) — which notes and skills
   * it opened, for 课堂精练's recall counts. Absent when none.
   */
  reads?: string[];
}

export interface AgentTranscript {
  exchanges: TranscriptExchange[];
  /** Time of the transcript's last record (epoch ms). */
  lastActivityAt?: number;
}

/** Longest text kept per side of an exchange; the rest is cut. */
export const TRANSCRIPT_TEXT_LIMIT = 20_000;

/** Distinct paths kept per exchange in {@link TranscriptExchange.reads}. */
export const MAX_EXCHANGE_READS = 100;
/** Tool input looked at for paths; a giant input (a file being written) is cut. */
const TOOL_INPUT_LIMIT = 20_000;
/** An absolute or home-relative path of a Markdown file. */
const MARKDOWN_PATH_RE = /(?:~\/|\/)[\w@+~.\/-]*?\.md(?![\w.-])/g;

/** Build an exchange list incrementally while reading a transcript in order. */
export class TranscriptBuilder {
  readonly exchanges: TranscriptExchange[] = [];
  lastActivityAt: number | undefined;

  request(request: {
    text: string;
    at?: number;
    senderId?: string;
    senderName?: string;
    senderType?: 'user' | 'bot';
    mixedSenders: boolean;
  }): void {
    this.exchanges.push({
      index: this.exchanges.length + 1,
      ...(request.at !== undefined ? { at: request.at } : {}),
      ...(request.senderId ? { senderId: request.senderId } : {}),
      ...(request.senderName ? { senderName: request.senderName } : {}),
      ...(request.senderType ? { senderType: request.senderType } : {}),
      mixedSenders: request.mixedSenders,
      user: clip(request.text),
      assistant: '',
    });
  }

  /** Answer text for the latest request; ignored before the first one. */
  answer(text: string): void {
    const current = this.exchanges.at(-1);
    const clean = text.trim();
    if (!current || !clean) return;
    current.assistant = clip(current.assistant ? `${current.assistant}\n\n${clean}` : clean);
  }

  /** A tool call made while answering the latest request; ignored before the first one. */
  tool(input: unknown): void {
    const current = this.exchanges.at(-1);
    if (!current || input === undefined || input === null) return;
    const text = (typeof input === 'string' ? input : JSON.stringify(input) ?? '').slice(0, TOOL_INPUT_LIMIT);
    const found = markdownPaths(text);
    if (found.length === 0) return;
    const reads = new Set(current.reads ?? []);
    for (const path of found) {
      if (reads.size >= MAX_EXCHANGE_READS) break;
      reads.add(path);
    }
    current.reads = [...reads];
  }

  seen(at: number | undefined): void {
    if (at !== undefined && Number.isFinite(at)) this.lastActivityAt = Math.max(this.lastActivityAt ?? 0, at);
  }

  result(): AgentTranscript {
    return {
      exchanges: this.exchanges,
      ...(this.lastActivityAt !== undefined ? { lastActivityAt: this.lastActivityAt } : {}),
    };
  }
}

/** Markdown file paths named in a tool call's input, in order, without repeats. */
export function markdownPaths(text: string): string[] {
  return [...new Set(text.match(MARKDOWN_PATH_RE) ?? [])];
}

function clip(text: string): string {
  return text.length > TRANSCRIPT_TEXT_LIMIT ? `${text.slice(0, TRANSCRIPT_TEXT_LIMIT)}…` : text;
}

export function parseRecordTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}
