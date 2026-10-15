import { readFile } from 'node:fs/promises';
import type { ApiMessageItem, LarkChannel } from '@larksuite/channel';
import type { BridgePromptChatContextWindow } from '../agent/prompt';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import { fetchSubTreeItems, normalizeItemToQuoted, preExpandInteractive, type QuotedContext } from './quote';

/**
 * 群聊 / 话题上下文. Feishu only pushes a group message to the bot when it
 * @-mentions the bot, so whatever the group said around those mentions never
 * reaches the agent: the question a topic opened with, the discussion the user
 * means by "看下上面这个", what others added since the bot last answered. Before
 * each group run we read that slice back from `im.v1.message.list` and inject
 * it as `<chat_context>`.
 *
 * Which slice depends on what the conversation already holds:
 *  - `catch_up`: the scope has a cursor (the newest message an earlier run in
 *    it was given) — only what was said after it, minus the bot's own replies,
 *    which already sit in the session.
 *  - `topic_history`: first engagement in a topic — the topic so far.
 *  - `recent`: first engagement in a group — its latest messages.
 */

export const CHAT_CONTEXT_LIMITS = {
  catchUpMessages: 30,
  topicHistoryMessages: 40,
  recentMessages: 20,
  /** How far back `recent` looks. */
  recentWindowMs: 12 * 60 * 60_000,
  /** Per message; longer content is cut with a marker. */
  messageChars: 4000,
  /** Across the block; the oldest messages are dropped first. */
  totalChars: 24_000,
  /** Newest-first pages read at most; 50 messages each. */
  maxPages: 3,
} as const;

const PAGE_SIZE = 50;
const TRUNCATED_MARK = '…（已截断）';

export interface ChatContextPlan {
  container: 'thread' | 'chat';
  containerId: string;
  window: BridgePromptChatContextWindow;
  /** Only messages created strictly after this (ms). */
  afterMs?: number;
  /** Only messages created at or before this (ms): the batch's newest message. */
  untilMs: number;
  maxMessages: number;
  /** Drop messages this bot sent itself. */
  excludeOwn: boolean;
}

export interface ChatContextResult {
  messages: QuotedContext[];
  /** More matched than fit (count, page or size caps). */
  truncated: boolean;
}

/**
 * Decide what, if anything, to read back for a run. p2p never needs it: every
 * DM reaches the bot. A topic message without a thread id has no container to
 * read. A scope that already has a session but no cursor predates this feature
 * — its history is in the resumed conversation, and this run sets the cursor.
 */
export function planChatContext(input: {
  mode: 'p2p' | 'group' | 'topic';
  chatId: string;
  threadId?: string;
  cursorMs?: number;
  hasSession: boolean;
  untilMs: number;
}): ChatContextPlan | undefined {
  if (input.mode === 'p2p') return undefined;
  if (input.mode === 'topic' && !input.threadId) return undefined;
  const container: Pick<ChatContextPlan, 'container' | 'containerId'> =
    input.mode === 'topic' && input.threadId
      ? { container: 'thread', containerId: input.threadId }
      : { container: 'chat', containerId: input.chatId };
  const base = { ...container, untilMs: input.untilMs };
  if (input.cursorMs !== undefined) {
    return {
      ...base,
      window: 'catch_up',
      afterMs: input.cursorMs,
      maxMessages: CHAT_CONTEXT_LIMITS.catchUpMessages,
      excludeOwn: true,
    };
  }
  if (input.hasSession) return undefined;
  if (container.container === 'thread') {
    return {
      ...base,
      window: 'topic_history',
      maxMessages: CHAT_CONTEXT_LIMITS.topicHistoryMessages,
      excludeOwn: false,
    };
  }
  return {
    ...base,
    window: 'recent',
    afterMs: input.untilMs - CHAT_CONTEXT_LIMITS.recentWindowMs,
    maxMessages: CHAT_CONTEXT_LIMITS.recentMessages,
    excludeOwn: false,
  };
}

/**
 * Read the planned slice, oldest first. `excludeIds` drops the triggering
 * messages and reply-quote targets (both are in the prompt already);
 * `ownAppId` identifies this bot's messages, which the list API reports with
 * the app id as sender. Best-effort: any API failure yields no context.
 */
export async function fetchChatContext(
  channel: LarkChannel,
  plan: ChatContextPlan,
  opts: { chatId: string; ownAppId?: string; excludeIds?: Set<string> },
): Promise<ChatContextResult> {
  const exclude = opts.excludeIds ?? new Set<string>();
  const seen = new Set<string>();
  const relevant: ApiMessageItem[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  try {
    do {
      const res = await channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: plan.container,
          container_id: plan.containerId,
          sort_type: 'ByCreateTimeDesc',
          page_size: PAGE_SIZE,
          // Without this, Feishu returns the v1-canonical fallback body for
          // CardKit 2.0 cards ("请升级至最新版本客户端") instead of the DSL.
          card_msg_content_type: 'user_card_content',
          // Time bounds (seconds) only work on chat containers; thread
          // results are filtered below either way.
          ...(plan.container === 'chat'
            ? {
                ...(plan.afterMs !== undefined ? { start_time: String(Math.floor(plan.afterMs / 1000)) } : {}),
                end_time: String(Math.ceil(plan.untilMs / 1000)),
              }
            : {}),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      const data = (res as {
        data?: { items?: ApiMessageItem[]; has_more?: boolean; page_token?: string };
      }).data;
      const items = data?.items ?? [];
      pages += 1;
      let oldest = Number.POSITIVE_INFINITY;
      for (const item of items) {
        const created = createdMs(item);
        if (created < oldest) oldest = created;
        if (!item.message_id || seen.has(item.message_id)) continue;
        seen.add(item.message_id);
        if (isRelevant(item, created, plan, exclude, opts.ownAppId)) relevant.push(item);
      }
      pageToken = data?.has_more ? data.page_token : undefined;
      // Newest first: a page that reaches back past the window ends the walk.
      if (plan.afterMs !== undefined && oldest <= plan.afterMs) pageToken = undefined;
    } while (pageToken && pages < CHAT_CONTEXT_LIMITS.maxPages && relevant.length < plan.maxMessages);
  } catch (err) {
    log.warn('chat-context', 'fetch-failed', {
      container: plan.container,
      window: plan.window,
      err: err instanceof Error ? err.message : String(err),
    });
    return { messages: [], truncated: false };
  }

  relevant.sort((a, b) => createdMs(a) - createdMs(b));
  const kept = relevant.slice(-plan.maxMessages);
  let truncated = relevant.length > kept.length || pageToken !== undefined;

  const resolveName = await senderNameResolver(channel, opts.chatId, kept, opts.ownAppId);
  const normalized: QuotedContext[] = [];
  for (const item of kept) {
    const fetchSubMessages = async (mid: string): Promise<ApiMessageItem[]> => {
      const source = mid === item.message_id ? [item] : await fetchSubTreeItems(channel, mid);
      return source.map(preExpandInteractive);
    };
    const quoted = await normalizeItemToQuoted(channel, item, fetchSubMessages, resolveName);
    if (!quoted) continue;
    if (quoted.content.length > CHAT_CONTEXT_LIMITS.messageChars) {
      quoted.content = quoted.content.slice(0, CHAT_CONTEXT_LIMITS.messageChars) + TRUNCATED_MARK;
      truncated = true;
    }
    normalized.push(quoted);
  }

  // Keep the newest messages that fit the size budget.
  let budget = CHAT_CONTEXT_LIMITS.totalChars;
  let start = normalized.length;
  while (start > 0) {
    const size = normalized[start - 1]?.content.length ?? 0;
    if (size > budget) break;
    budget -= size;
    start -= 1;
  }
  if (start > 0) truncated = true;
  return { messages: normalized.slice(start), truncated };
}

function createdMs(item: ApiMessageItem): number {
  const n = Number.parseInt(String(item.create_time ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function isRelevant(
  item: ApiMessageItem,
  created: number,
  plan: ChatContextPlan,
  exclude: Set<string>,
  ownAppId: string | undefined,
): boolean {
  if (!item.message_id || exclude.has(item.message_id)) return false;
  if ((item as { deleted?: boolean }).deleted) return false;
  if (item.msg_type === 'system') return false;
  if (created > plan.untilMs) return false;
  if (plan.afterMs !== undefined && created <= plan.afterMs) return false;
  if (plan.excludeOwn && ownAppId && item.sender?.id === ownAppId) return false;
  return true;
}

/**
 * List items carry sender ids only. Users resolve through the chat roster
 * (cached by the SDK); this bot's own messages carry its app id, which maps to
 * its name. Other bots stay nameless — the list API gives no way to name them.
 */
async function senderNameResolver(
  channel: LarkChannel,
  chatId: string,
  items: ApiMessageItem[],
  ownAppId: string | undefined,
): Promise<(id: string) => string | undefined> {
  const names = new Map<string, string>();
  const botName = channel.botIdentity?.name;
  if (ownAppId && botName) names.set(ownAppId, botName);
  if (items.some((m) => m.sender?.sender_type === 'user')) {
    try {
      for (const member of await channel.getChatMembers(chatId)) {
        if (member.name) names.set(member.id, member.name);
      }
    } catch (err) {
      log.warn('chat-context', 'roster-failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }
  return (id) => names.get(id);
}

type CursorMap = Record<string, { lastSeenAt: number }>;

/** A scope nobody has engaged for this long starts over as a first engagement. */
const CURSOR_MAX_AGE_MS = 90 * 24 * 60 * 60_000;

/**
 * Per scope, the creation time of the newest message an accepted run was
 * given — where the next run's `catch_up` window starts. On disk so a restart
 * neither re-injects what the session already holds nor loses the window.
 * Without a path (tests that omit appPaths) it is memory-only.
 */
export class ChatContextCursorStore {
  private data: CursorMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string | undefined;

  constructor(path?: string) {
    this.path = path;
  }

  async load(now: number = Date.now()): Promise<void> {
    if (!this.path) return;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
      this.data = {};
      for (const [scope, entry] of Object.entries(raw)) {
        const at = (entry as { lastSeenAt?: unknown } | null)?.lastSeenAt;
        if (typeof at === 'number' && Number.isFinite(at) && now - at < CURSOR_MAX_AGE_MS) {
          this.data[scope] = { lastSeenAt: at };
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.warn('chat-context', 'cursor-load-failed', { err: String(err) });
      this.data = {};
    }
  }

  get(scope: string): number | undefined {
    return this.data[scope]?.lastSeenAt;
  }

  /** Move the scope's cursor to `ms`; never backwards. */
  advance(scope: string, ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const prev = this.data[scope]?.lastSeenAt;
    if (prev !== undefined && prev >= ms) return;
    this.data[scope] = { lastSeenAt: ms };
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    if (!this.path) return;
    const path = this.path;
    const snapshot = JSON.stringify(this.data);
    this.saving = this.saving
      .then(() => writeFileAtomic(path, snapshot, { mode: 0o600 }))
      .catch((err) => log.warn('chat-context', 'cursor-persist-failed', { err: String(err) }));
  }
}
