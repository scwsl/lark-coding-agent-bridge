export type BridgePromptSource = 'im' | 'card' | 'comment';

export interface BridgePromptMention {
  openId?: string;
  name?: string;
  isBot?: boolean;
}

export interface BridgePromptContext {
  chatId: string;
  chatType: string;
  senderId: string;
  senderName?: string;
  /** Whether the sender is a human user or another bot ('app' sender). */
  senderType?: 'user' | 'bot';
  /** The bridge bot's own open_id — "this id is you" for self-identification. */
  botOpenId?: string;
  /** Every message of this turn came from the bot's owner. Gates changes to
   * the bridge and the agent itself (see the system prompt). */
  senderIsOwner?: boolean;
  /** Accounts @-mentioned in the triggering message(s), deduped across the batch. */
  mentions?: BridgePromptMention[];
  threadId?: string;
  messageIds?: string[];
  source: BridgePromptSource;
}

export interface BridgePromptQuotedMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  createdAt?: string;
  rawContentType: string;
  content: string;
}

export interface BridgePromptInteractiveCard {
  messageId?: string;
  content: unknown;
}

/**
 * A group / topic message the bot never received (Feishu only pushes the ones
 * that @-mention it), supplied as read-only background. Distinct from
 * `quotedMessages` (an explicit reply-quote the user is pointing at).
 */
export interface BridgePromptContextMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  senderType?: 'user' | 'bot';
  createdAt?: string;
  rawContentType: string;
  content: string;
}

/**
 * - `catch_up`: said since the bot's previous run in this conversation (its
 *   own replies left out — they're in the session).
 * - `topic_history`: the topic so far, on the bot's first run in it.
 * - `recent`: the group's latest messages, on the bot's first run there.
 */
export type BridgePromptChatContextWindow = 'catch_up' | 'topic_history' | 'recent';

export interface BridgePromptChatContext {
  scope: 'topic' | 'group';
  window: BridgePromptChatContextWindow;
  /** Older or longer content was left out to stay within limits. */
  truncated?: boolean;
  messages: BridgePromptContextMessage[];
}

export interface BridgePromptComment {
  commentScopeId: string;
  isWholeDocument: boolean;
  docsLink?: string;
  question: string;
  quote?: string;
}

export interface BridgePromptAttachment {
  path: string;
  kind: string;
  hash?: string;
  size?: number;
  mime?: string;
  sourceMessageId?: string;
  requiredness?: 'required' | 'optional';
  decision?: 'accepted' | 'rejected' | 'skipped';
  rejectionReason?: string;
}

/**
 * Bridge-managed memory and the skill index, injected on every run. Kept out of
 * `instructions` so the agent can tell "what this deployment always knows" from
 * "what this particular turn needs".
 */
export interface BridgePromptKnowledge {
  profileMemory?: string[];
  chatMemory?: string[];
  skills?: Array<{ name: string; description: string; path: string; source?: string }>;
  truncated?: boolean;
}

export interface BuildAgentPromptInput {
  context: BridgePromptContext;
  instructions?: string[];
  userInput: string;
  knowledge?: BridgePromptKnowledge;
  chatContext?: BridgePromptChatContext;
  quotedMessages?: BridgePromptQuotedMessage[];
  interactiveCards?: BridgePromptInteractiveCard[];
  comment?: BridgePromptComment;
  attachments?: BridgePromptAttachment[];
}

export function buildAgentPrompt(input: BuildAgentPromptInput): string {
  const sections = [
    promptSection('bridge_context', input.context),
    input.instructions && input.instructions.length > 0
      ? promptSection('bridge_instructions', input.instructions)
      : undefined,
    input.knowledge ? promptSection('bridge_knowledge', input.knowledge) : undefined,
    input.chatContext && input.chatContext.messages.length > 0
      ? promptSection('chat_context', input.chatContext)
      : undefined,
    input.quotedMessages && input.quotedMessages.length > 0
      ? promptSection('quoted_messages', input.quotedMessages)
      : undefined,
    input.interactiveCards && input.interactiveCards.length > 0
      ? promptSection('interactive_cards', input.interactiveCards)
      : undefined,
    input.comment ? promptSection('comment_context', input.comment) : undefined,
    promptSection('user_input', {
      text: input.userInput,
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    }),
  ];

  return sections.filter(Boolean).join('\n\n');
}

export function promptSection(tag: string, value: unknown): string {
  return `<${tag}>\n${safeJsonStringify(value)}\n</${tag}>`;
}

export function safeJsonStringify(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The user's own words from a prompt built by {@link buildAgentPrompt} — the
 * `text` of its `<user_input>` section, without the `[name (user)]:` speaker
 * labels a merged batch carries. Undefined when the prompt has no such section.
 */
export function extractUserInputText(prompt: string): string | undefined {
  const open = '<user_input>\n';
  const start = prompt.lastIndexOf(open);
  if (start === -1) return undefined;
  const end = prompt.indexOf('\n</user_input>', start + open.length);
  if (end === -1) return undefined;
  try {
    const parsed = JSON.parse(prompt.slice(start + open.length, end)) as { text?: unknown };
    if (typeof parsed.text !== 'string') return undefined;
    return parsed.text.replace(/^\[[^\]\n]{1,80} \((?:user|bot)\)\]:\s*/gm, '').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** One request as the bridge recorded it in a prompt from {@link buildAgentPrompt}. */
export interface BridgePromptRequest {
  /** The user's words, speaker labels removed. */
  text: string;
  senderId?: string;
  senderName?: string;
  senderType?: 'user' | 'bot';
  /**
   * A merged batch carrying more than one speaker (or a bot): the
   * `bridge_context` sender is then not the author of every line in it.
   */
  mixedSenders: boolean;
}

const SPEAKER_LABEL_RE = /^\[([^\]\n]{1,80}) \((user|bot)\)\]:/gm;

/**
 * The request and its sender from a prompt built by {@link buildAgentPrompt}.
 * Undefined when the prompt has no `<user_input>` section — tool results,
 * compaction summaries and anything else that is not a chat request.
 */
export function parseBridgePromptRequest(prompt: string): BridgePromptRequest | undefined {
  const text = extractUserInputText(prompt);
  if (!text) return undefined;
  const open = '<user_input>\n';
  const start = prompt.lastIndexOf(open);
  const end = prompt.indexOf('\n</user_input>', start + open.length);
  let raw = '';
  try {
    const parsed = JSON.parse(prompt.slice(start + open.length, end)) as { text?: unknown };
    raw = typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    raw = '';
  }
  const speakers = new Set<string>();
  let botSpeaker = false;
  for (const match of raw.matchAll(SPEAKER_LABEL_RE)) {
    speakers.add(match[1] ?? '');
    if (match[2] === 'bot') botSpeaker = true;
  }
  // The context block right before this request: an agent that gets the
  // bridge system prompt inline (Codex) carries an example block earlier on.
  const context = readPromptSection(prompt.slice(0, start), 'bridge_context') as Partial<BridgePromptContext> | undefined;
  const senderType = context?.senderType === 'user' || context?.senderType === 'bot' ? context.senderType : undefined;
  return {
    text,
    ...(typeof context?.senderId === 'string' && context.senderId ? { senderId: context.senderId } : {}),
    ...(typeof context?.senderName === 'string' && context.senderName ? { senderName: context.senderName } : {}),
    ...(senderType ? { senderType } : {}),
    mixedSenders: speakers.size > 1 || botSpeaker,
  };
}

/** The JSON value of the last `<tag>` section of a bridge prompt. */
function readPromptSection(prompt: string, tag: string): unknown {
  const open = `<${tag}>\n`;
  const start = prompt.lastIndexOf(open);
  if (start === -1) return undefined;
  const end = prompt.indexOf(`\n</${tag}>`, start + open.length);
  if (end === -1) return undefined;
  try {
    return JSON.parse(prompt.slice(start + open.length, end)) as unknown;
  } catch {
    return undefined;
  }
}
