import { describe, expect, it, vi } from 'vitest';
import { autoTopicEnabled, autoTopicPrefix, matchTopicPrefix, openTopicUnder, topicOpenedText, topicRunText } from '../../../src/bot/topic-prefix.js';

const LABELS = ['medium', 'high', 'xhigh', 'fable'];

describe('matchTopicPrefix', () => {
  it('matches a rung prefix standing alone, case-insensitively', () => {
    expect(matchTopicPrefix('/xhigh 帮我看下', LABELS)).toEqual({ label: 'xhigh', kind: 'effort', rest: '帮我看下' });
    expect(matchTopicPrefix('  /Fable\n多行\n任务', LABELS)).toEqual({ label: 'fable', kind: 'effort', rest: '多行\n任务' });
  });

  it('ignores other commands, glued words and prefixes not at the start', () => {
    expect(matchTopicPrefix('/status 看下', LABELS)).toBeUndefined();
    expect(matchTopicPrefix('/highest 看下', LABELS)).toBeUndefined();
    expect(matchTopicPrefix('/high帮我', LABELS)).toBeUndefined();
    expect(matchTopicPrefix('帮我 /high', LABELS)).toBeUndefined();
    expect(matchTopicPrefix('/high 帮我', [])).toBeUndefined();
  });

  it('needs something to do after the prefix', () => {
    expect(matchTopicPrefix('/high', LABELS)).toBeUndefined();
    expect(matchTopicPrefix('/high   ', LABELS)).toBeUndefined();
    expect(matchTopicPrefix('/high', LABELS, { attachments: 1 })).toEqual({ label: 'high', kind: 'effort', rest: '' });
    expect(matchTopicPrefix('/high', LABELS, { quoted: true })).toEqual({ label: 'high', kind: 'effort', rest: '' });
  });

  it('matches /new-topic whatever the ladder', () => {
    expect(matchTopicPrefix('/new-topic 把 X 拎出来', [])).toEqual({ label: 'new-topic', kind: 'new-topic', rest: '把 X 拎出来' });
    expect(matchTopicPrefix('/New-Topic 做 Y', LABELS)).toMatchObject({ kind: 'new-topic', rest: '做 Y' });
    expect(matchTopicPrefix('/new-topic', LABELS)).toBeUndefined();
    expect(matchTopicPrefix('/new-topics 做 Y', LABELS)).toBeUndefined();
  });

  it('names the rung in the opening line', () => {
    expect(topicOpenedText({ label: 'xhigh', kind: 'effort', rest: 'x' })).toContain('/xhigh');
    expect(topicOpenedText({ label: 'new-topic', kind: 'new-topic', rest: 'x' })).toContain('已开话题');
  });

  it('takes /new-topic off the text the run gets, and keeps a rung prefix', () => {
    const text = '/new-topic 把 X 拎出来';
    expect(topicRunText(text, matchTopicPrefix(text, LABELS)!)).toBe('把 X 拎出来');
    const quoted = matchTopicPrefix('/new-topic', LABELS, { quoted: true })!;
    expect(topicRunText('/new-topic', quoted)).not.toContain('/new-topic');
    expect(topicRunText('/xhigh 看下', matchTopicPrefix('/xhigh 看下', LABELS)!)).toBe('/xhigh 看下');
  });
});

describe('openTopicUnder', () => {
  const msg = { chatId: 'oc_1', messageId: 'om_1' };

  it('replies in thread under the message and reads the topic back from it', async () => {
    const send = vi.fn(async () => ({ messageId: 'om_reply' }));
    const fetchRawMessage = vi.fn(async () => [{ message_id: 'om_1', thread_id: 'omt_1' }]);
    const channel = { send, fetchRawMessage } as never;
    await expect(openTopicUnder(channel, msg, '🧵', 0)).resolves.toEqual({ threadId: 'omt_1', openerId: 'om_reply' });
    expect(send).toHaveBeenCalledWith('oc_1', { text: '🧵' }, { replyTo: 'om_1', replyInThread: true });
  });

  it('asks once more when the topic is not there yet', async () => {
    const fetchRawMessage = vi
      .fn()
      .mockResolvedValueOnce([{ message_id: 'om_1' }])
      .mockResolvedValueOnce([{ message_id: 'om_1', thread_id: 'omt_late' }]);
    const channel = { send: vi.fn(async () => ({ messageId: 'om_reply' })), fetchRawMessage } as never;
    await expect(openTopicUnder(channel, msg, '🧵', 1)).resolves.toEqual({ threadId: 'omt_late', openerId: 'om_reply' });
    expect(fetchRawMessage).toHaveBeenCalledTimes(2);
  });

  it('opens with a card when given one', async () => {
    const send = vi.fn(async () => ({ messageId: 'om_card' }));
    const fetchRawMessage = vi.fn(async () => [{ message_id: 'om_1', thread_id: 'omt_c' }]);
    const card = { schema: '2.0' };
    await expect(openTopicUnder({ send, fetchRawMessage } as never, msg, { card }, 0)).resolves.toEqual({
      threadId: 'omt_c',
      openerId: 'om_card',
    });
    expect(send).toHaveBeenCalledWith('oc_1', { card }, { replyTo: 'om_1', replyInThread: true });
  });

  it('hands back the opener without a topic when Feishu gives none', async () => {
    const fetchRawMessage = vi.fn(async () => [{ message_id: 'om_1' }]);
    const channel = { send: vi.fn(async () => ({ messageId: 'om_reply' })), fetchRawMessage } as never;
    await expect(openTopicUnder(channel, msg, '🧵', 0)).resolves.toEqual({ threadId: undefined, openerId: 'om_reply' });
  });

  it('gives up without a topic when the reply fails', async () => {
    const fetchRawMessage = vi.fn();
    const channel = { send: vi.fn(async () => Promise.reject(new Error('230002'))), fetchRawMessage } as never;
    await expect(openTopicUnder(channel, msg, '🧵', 0)).resolves.toBeUndefined();
    expect(fetchRawMessage).not.toHaveBeenCalled();
  });
});

describe('autoTopicEnabled', () => {
  it('reads true, chat lists and exceptions', () => {
    expect(autoTopicEnabled(undefined, 'oc_a')).toBe(false);
    expect(autoTopicEnabled(false, 'oc_a')).toBe(false);
    expect(autoTopicEnabled(true, 'oc_a')).toBe(true);
    expect(autoTopicEnabled({}, 'oc_a')).toBe(true);
    expect(autoTopicEnabled({ chats: ['oc_a'] }, 'oc_a')).toBe(true);
    expect(autoTopicEnabled({ chats: ['oc_a'] }, 'oc_b')).toBe(false);
    expect(autoTopicEnabled({ exceptChats: ['oc_a'] }, 'oc_a')).toBe(false);
    expect(autoTopicEnabled({ exceptChats: ['oc_a'] }, 'oc_b')).toBe(true);
  });

  it('runs the text as sent', () => {
    expect(topicRunText('看看', autoTopicPrefix('看看'))).toBe('看看');
    expect(topicOpenedText(autoTopicPrefix('看看'))).toContain('已开话题');
  });
});

describe('model prefix', () => {
  it('opens the topic naming the model and runs the task without the prefix', () => {
    const prefix = { label: 'sonnet', kind: 'model' as const, rest: '帮我看下' };
    expect(topicOpenedText(prefix)).toContain('sonnet');
    expect(topicRunText('/model sonnet 帮我看下', prefix)).toBe('帮我看下');
    expect(topicRunText('/model sonnet', { ...prefix, rest: '' })).toBe('请处理我引用的消息或发来的附件。');
  });
});
