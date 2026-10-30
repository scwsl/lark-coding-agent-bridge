import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import {
  EditedMessages,
  editInstruction,
  editPreview,
  isEdited,
  markEdited,
  parseEditEvent,
  runForMessage,
} from '../../../src/bot/edit';
import { PendingQueue } from '../../../src/bot/pending-queue';

function msg(id: string, content = id): NormalizedMessage {
  return { messageId: id, chatId: 'oc_1', chatType: 'p2p', senderId: 'ou_1', content } as NormalizedMessage;
}

function rawEdit(overrides: Record<string, unknown> = {}) {
  return {
    sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'group',
      message_type: 'text',
      content: '{"text":"@_user_1 hi"}',
      update_time: '1761800000000',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Occam' }],
    },
    ...overrides,
  };
}

describe('parseEditEvent', () => {
  it('reads the receive-shaped body and keeps it for normalize()', () => {
    const evt = parseEditEvent(rawEdit());
    expect(evt).toMatchObject({
      messageId: 'om_1',
      chatId: 'oc_1',
      updateTime: '1761800000000',
      senderType: 'user',
    });
    expect(evt?.event?.message.content).toBe('{"text":"@_user_1 hi"}');
  });

  it('accepts the nested { header, event } envelope', () => {
    const evt = parseEditEvent({ header: { event_type: 'im.message.updated_v1' }, event: rawEdit() });
    expect(evt?.messageId).toBe('om_1');
  });

  it('drops a body without message id or chat id', () => {
    expect(parseEditEvent({})).toBeUndefined();
    expect(parseEditEvent({ message: { message_id: 'om_1' } })).toBeUndefined();
  });

  it('leaves out the event when the sender is missing', () => {
    const evt = parseEditEvent(rawEdit({ sender: undefined }));
    expect(evt?.messageId).toBe('om_1');
    expect(evt?.event).toBeUndefined();
  });
});

describe('EditedMessages', () => {
  it('lets each edit through once; a later edit of the same message goes through', () => {
    const edits = new EditedMessages();
    expect(edits.firstSeen({ messageId: 'om_1', updateTime: '1' }, 0)).toBe(true);
    expect(edits.firstSeen({ messageId: 'om_1', updateTime: '1' }, 10)).toBe(false);
    expect(edits.firstSeen({ messageId: 'om_1', updateTime: '2' }, 20)).toBe(true);
  });

  it('forgets after the ttl', () => {
    const edits = new EditedMessages(100);
    expect(edits.firstSeen({ messageId: 'om_1', updateTime: '1' }, 0)).toBe(true);
    expect(edits.firstSeen({ messageId: 'om_1', updateTime: '1' }, 500)).toBe(true);
  });
});

describe('edited marker and texts', () => {
  it('tags only the message built from an edit', () => {
    const edited = markEdited(msg('om_1'));
    expect(isEdited(edited)).toBe(true);
    expect(isEdited(msg('om_1'))).toBe(false);
  });

  it('names the edited messages in the run instruction', () => {
    expect(editInstruction(['om_1', 'om_2'])).toContain('om_1、om_2');
  });

  it('previews the edited content on one line', () => {
    expect(editPreview('a\n b')).toBe('✏️ 消息已编辑：a b');
    expect(editPreview('x'.repeat(80))).toBe(`✏️ 消息已编辑：${'x'.repeat(60)}…`);
    expect(editPreview('  ')).toBe('✏️ 消息已编辑：（空消息）');
  });
});

describe('runForMessage', () => {
  it('finds the run whose batch took the message in', () => {
    const activeRuns = new ActiveRuns();
    const handle = activeRuns.register('oc_1', { stop: vi.fn(), inject: vi.fn() } as unknown as AgentRun);
    handle.supplement = { originIds: new Set(['om_1']), replyIds: new Set(), initiators: new Set(['ou_1']) };
    expect(runForMessage(activeRuns, 'om_1')).toEqual({ scope: 'oc_1', handle });
    expect(runForMessage(activeRuns, 'om_2')).toBeUndefined();
  });
});

describe('PendingQueue.replace', () => {
  it('swaps a queued message in place and keeps the flush', () => {
    vi.useFakeTimers();
    try {
      const flushed: string[][] = [];
      const changes: string[][] = [];
      const pending = new PendingQueue(
        100,
        (_scope, batch) => flushed.push(batch.map((m) => m.content)),
        (_scope, messages) => changes.push(messages.map((m) => m.content)),
      );
      pending.push('s', msg('om_1', 'old'));
      pending.push('s', msg('om_2', 'two'));
      expect(pending.replace('om_1', msg('om_1', 'new'))).toBe('s');
      expect(pending.replace('om_9', msg('om_9'))).toBeUndefined();
      expect(changes.at(-1)).toEqual(['new', 'two']);
      vi.advanceTimersByTime(100);
      expect(flushed).toEqual([['new', 'two']]);
    } finally {
      vi.useRealTimers();
    }
  });
});
