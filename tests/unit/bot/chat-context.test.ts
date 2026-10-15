import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_CONTEXT_LIMITS,
  ChatContextCursorStore,
  fetchChatContext,
  planChatContext,
  type ChatContextPlan,
} from '../../../src/bot/chat-context';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const tmps: TmpProfile[] = [];

afterEach(async () => {
  await Promise.all(tmps.splice(0).map((t) => t.cleanup()));
});

const UNTIL = 1_760_000_100_000;

describe('planChatContext', () => {
  const base = { chatId: 'oc_1', untilMs: UNTIL };

  it('never reads back in p2p', () => {
    expect(planChatContext({ ...base, mode: 'p2p', hasSession: false })).toBeUndefined();
  });

  it('catches up from the cursor, without the bot’s own replies', () => {
    expect(
      planChatContext({ ...base, mode: 'topic', threadId: 'omt_1', cursorMs: UNTIL - 5000, hasSession: true }),
    ).toMatchObject({
      container: 'thread',
      containerId: 'omt_1',
      window: 'catch_up',
      afterMs: UNTIL - 5000,
      excludeOwn: true,
    });
    expect(planChatContext({ ...base, mode: 'group', cursorMs: UNTIL - 5000, hasSession: false })).toMatchObject({
      container: 'chat',
      containerId: 'oc_1',
      window: 'catch_up',
    });
  });

  it('reads the whole topic, or the recent group timeline, on a first engagement', () => {
    expect(planChatContext({ ...base, mode: 'topic', threadId: 'omt_1', hasSession: false })).toMatchObject({
      window: 'topic_history',
      excludeOwn: false,
    });
    const recent = planChatContext({ ...base, mode: 'group', hasSession: false });
    expect(recent).toMatchObject({ window: 'recent', container: 'chat' });
    expect(recent?.afterMs).toBe(UNTIL - CHAT_CONTEXT_LIMITS.recentWindowMs);
  });

  it('skips a scope whose session predates the cursor, and a topic message with no thread', () => {
    expect(planChatContext({ ...base, mode: 'group', hasSession: true })).toBeUndefined();
    expect(planChatContext({ ...base, mode: 'topic', hasSession: false })).toBeUndefined();
  });
});

describe('fetchChatContext', () => {
  const catchUp: ChatContextPlan = {
    container: 'thread',
    containerId: 'omt_1',
    window: 'catch_up',
    afterMs: UNTIL - 10_000,
    untilMs: UNTIL,
    maxMessages: 30,
    excludeOwn: true,
  };

  it('keeps only what falls inside the window, oldest first', async () => {
    const channel = fakeChannel([
      [
        item('om_late', 'ou_a', UNTIL + 1000, 'after the trigger'),
        item('om_trigger', 'ou_a', UNTIL, 'the trigger'),
        item('om_own', 'cli_app', UNTIL - 2000, 'own reply', 'app'),
        item('om_other_bot', 'cli_other', UNTIL - 3000, 'another bot', 'app'),
        item('om_b', 'ou_b', UNTIL - 4000, 'second'),
        { ...item('om_deleted', 'ou_b', UNTIL - 4500, 'gone'), deleted: true },
        item('om_a', 'ou_a', UNTIL - 5000, 'first'),
        item('om_old', 'ou_a', UNTIL - 20_000, 'before the cursor'),
      ],
    ]);

    const result = await fetchChatContext(channel, catchUp, {
      chatId: 'oc_1',
      ownAppId: 'cli_app',
      excludeIds: new Set(['om_trigger']),
    });

    expect(result.messages.map((m) => m.messageId)).toEqual(['om_a', 'om_b', 'om_other_bot']);
    expect(result.messages[0]?.senderName).toBe('Alice');
    expect(result.messages[2]?.senderType).toBe('bot');
    expect(result.truncated).toBe(false);
  });

  it('names the bot’s own messages when a first engagement keeps them', async () => {
    const channel = fakeChannel([[item('om_own', 'cli_app', UNTIL - 2000, 'earlier answer', 'app')]]);

    const result = await fetchChatContext(
      channel,
      { ...catchUp, window: 'topic_history', afterMs: undefined, excludeOwn: false },
      { chatId: 'oc_1', ownAppId: 'cli_app' },
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.senderName).toBe('Bridge');
  });

  it('keeps the newest messages and flags the cut when more match than fit', async () => {
    const items = Array.from({ length: 8 }, (_, i) => item(`om_${i}`, 'ou_a', UNTIL - 1000 * (8 - i), `m${i}`));
    const channel = fakeChannel([items.reverse()]);

    const result = await fetchChatContext(channel, { ...catchUp, maxMessages: 3 }, { chatId: 'oc_1' });

    expect(result.messages.map((m) => m.messageId)).toEqual(['om_5', 'om_6', 'om_7']);
    expect(result.truncated).toBe(true);
  });

  it('cuts an overlong message and stays within the total size budget', async () => {
    const long = 'x'.repeat(CHAT_CONTEXT_LIMITS.messageChars + 500);
    const items = Array.from({ length: 10 }, (_, i) => item(`om_${i}`, 'ou_a', UNTIL - 1000 * (10 - i), long));
    const channel = fakeChannel([items]);

    const result = await fetchChatContext(channel, catchUp, { chatId: 'oc_1' });

    expect(result.truncated).toBe(true);
    expect(result.messages[0]?.content.endsWith('…（已截断）')).toBe(true);
    const total = result.messages.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(CHAT_CONTEXT_LIMITS.totalChars);
    expect(result.messages.at(-1)?.messageId).toBe('om_9');
  });

  it('stops paging once a page reaches back past the window', async () => {
    const channel = fakeChannel([
      [item('om_new', 'ou_a', UNTIL - 1000, 'new'), item('om_older', 'ou_a', UNTIL - 30_000, 'older')],
      [item('om_ancient', 'ou_a', UNTIL - 90_000, 'ancient')],
    ]);

    const result = await fetchChatContext(channel, catchUp, { chatId: 'oc_1' });

    expect(channel.rawClient.im.v1.message.list).toHaveBeenCalledTimes(1);
    expect(result.messages.map((m) => m.messageId)).toEqual(['om_new']);
  });

  it('passes time bounds in seconds for a chat container', async () => {
    const channel = fakeChannel([[]]);

    await fetchChatContext(
      channel,
      { ...catchUp, container: 'chat', containerId: 'oc_1', afterMs: 1_760_000_000_500, untilMs: 1_760_000_100_200 },
      { chatId: 'oc_1' },
    );

    expect(channel.rawClient.im.v1.message.list).toHaveBeenCalledWith({
      params: expect.objectContaining({
        container_id_type: 'chat',
        sort_type: 'ByCreateTimeDesc',
        start_time: '1760000000',
        end_time: '1760000101',
      }),
    });
  });

  it('returns no context when the API call fails', async () => {
    const channel = fakeChannel([]);
    channel.rawClient.im.v1.message.list.mockRejectedValueOnce(new Error('99991672 no permission'));

    await expect(fetchChatContext(channel, catchUp, { chatId: 'oc_1' })).resolves.toEqual({
      messages: [],
      truncated: false,
    });
  });
});

describe('ChatContextCursorStore', () => {
  it('only moves forward and survives a reload', async () => {
    const tmp = await createTmpProfile('chat-cursor-');
    tmps.push(tmp);
    const path = join(tmp.profile, 'chat-context-cursors.json');
    const store = new ChatContextCursorStore(path);
    await store.load();

    store.advance('oc_1', 2000);
    store.advance('oc_1', 1000);
    store.advance('oc_2', 0);
    await store.flush();

    const reloaded = new ChatContextCursorStore(path);
    await reloaded.load(3000);
    expect(reloaded.get('oc_1')).toBe(2000);
    expect(reloaded.get('oc_2')).toBeUndefined();
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('forgets cursors nobody has used for months', async () => {
    const tmp = await createTmpProfile('chat-cursor-');
    tmps.push(tmp);
    const path = join(tmp.profile, 'chat-context-cursors.json');
    const now = 200 * 24 * 60 * 60_000;
    await writeFile(path, JSON.stringify({ stale: { lastSeenAt: 1 }, fresh: { lastSeenAt: now - 1000 } }));

    const store = new ChatContextCursorStore(path);
    await store.load(now);

    expect(store.get('stale')).toBeUndefined();
    expect(store.get('fresh')).toBe(now - 1000);
  });
});

function item(
  messageId: string,
  senderId: string,
  createTime: number,
  text: string,
  senderType: 'user' | 'app' = 'user',
): Record<string, unknown> {
  return {
    message_id: messageId,
    msg_type: 'text',
    body: { content: JSON.stringify({ text }) },
    sender: { id: senderId, sender_type: senderType },
    create_time: String(createTime),
  };
}

function fakeChannel(pages: Array<Array<Record<string, unknown>>>) {
  let call = 0;
  const list = vi.fn(async () => {
    const items = pages[call] ?? [];
    call += 1;
    const hasMore = call < pages.length;
    return { data: { items, has_more: hasMore, ...(hasMore ? { page_token: `p${call}` } : {}) } };
  });
  const channel = {
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: { im: { v1: { message: { list } } } },
    getChatMembers: vi.fn(async () => [
      { id: 'ou_a', name: 'Alice' },
      { id: 'ou_b', name: 'Bob' },
    ]),
    fetchRawMessage: vi.fn(async () => []),
  };
  return channel as unknown as LarkChannel & typeof channel;
}
