import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../src/agent/types';
import { ActiveRuns, type RunHandle } from '../../../src/bot/active-runs';
import { PendingQueue } from '../../../src/bot/pending-queue';
import {
  applyRecall,
  parseRecallEvent,
  RECALL_PREVIEW,
  RecalledMessages,
  settleEarlyRecalls,
} from '../../../src/bot/recall';

function msg(id: string): NormalizedMessage {
  return { messageId: id, chatId: 'oc_1', chatType: 'p2p', senderId: 'ou_1', content: id } as NormalizedMessage;
}

function fakeRun(acceptsInput = true): AgentRun {
  return {
    stop: vi.fn(async () => {}),
    waitForExit: vi.fn(async () => true),
    inject: vi.fn(() => acceptsInput),
  } as unknown as AgentRun;
}

/** A registered IM run that was started by `batch` (and took in `supplements` since). */
function startRun(activeRuns: ActiveRuns, scope: string, batch: string[], supplements: string[] = []): RunHandle {
  const handle = activeRuns.register(scope, fakeRun());
  handle.supplement = {
    originIds: new Set([...batch, ...supplements]),
    replyIds: new Set(),
    initiators: new Set(['ou_1']),
  };
  return handle;
}

function setup() {
  const flushed: string[][] = [];
  const pending = new PendingQueue(10_000, (_scope, batch) => flushed.push(batch.map((m) => m.messageId)));
  const activeRuns = new ActiveRuns();
  const recalled = new RecalledMessages();
  return { pending, activeRuns, recalled, flushed, deps: { pending, activeRuns, recalled } };
}

describe('recalling a message sent to the bot', () => {
  it('takes a queued message out of the queue so it never runs', () => {
    const { pending, activeRuns, flushed, deps } = setup();
    const running = startRun(activeRuns, 's1', ['m1']);
    pending.push('s1', msg('m2'));
    pending.push('s1', msg('m3'));

    expect(applyRecall('m2', deps)).toEqual({ action: 'dequeued', scope: 's1' });
    expect(pending.depth('s1')).toBe(1);
    // The run going on in the scope is left alone.
    expect(running.interrupted).toBe(false);
    expect(running.run.inject).not.toHaveBeenCalled();
    pending.stop();
    expect(flushed).toEqual([]);
  });

  it('cancels the run its message started, saying why', () => {
    const { activeRuns, deps } = setup();
    const handle = startRun(activeRuns, 's1', ['m1']);

    expect(applyRecall('m1', deps)).toEqual({ action: 'cancelled', scope: 's1' });
    expect(handle.interrupted).toBe(true);
    expect(handle.stopCause).toBe('recalled');
    expect(handle.run.stop).toHaveBeenCalled();
    expect(activeRuns.get('s1')).toBeUndefined();
  });

  it('cancels a run started by several messages only once all of them are recalled', () => {
    const { activeRuns, deps } = setup();
    const handle = startRun(activeRuns, 's1', ['m1', 'm2']);

    expect(applyRecall('m1', deps)).toEqual({ action: 'voided', scope: 's1', injected: true });
    expect(handle.interrupted).toBe(false);
    expect(handle.run.inject).toHaveBeenCalledWith(expect.stringContaining('m1'), RECALL_PREVIEW);

    expect(applyRecall('m2', deps)).toEqual({ action: 'cancelled', scope: 's1' });
    expect(handle.stopCause).toBe('recalled');
  });

  it('tells the agent to ignore a recalled supplement and keeps the run going', () => {
    const { activeRuns, deps } = setup();
    const handle = startRun(activeRuns, 's1', ['m1'], ['sup']);

    expect(applyRecall('sup', deps)).toEqual({ action: 'voided', scope: 's1', injected: true });
    expect(handle.interrupted).toBe(false);
    const [note] = vi.mocked(handle.run.inject!).mock.calls[0]!;
    expect(note).toContain('撤回了消息 sup');
    expect(note).toContain('忽略');
  });

  it('keeps a run whose starting message is recalled while a supplement it took in still stands', () => {
    const { activeRuns, deps } = setup();
    const handle = startRun(activeRuns, 's1', ['m1'], ['sup']);

    expect(applyRecall('m1', deps).action).toBe('voided');
    expect(handle.interrupted).toBe(false);
    expect(applyRecall('sup', deps).action).toBe('cancelled');
  });

  it('reports a run that can no longer take input as not told', () => {
    const { activeRuns, deps } = setup();
    const handle = activeRuns.register('s1', fakeRun(false));
    handle.supplement = { originIds: new Set(['m1', 'm2']), replyIds: new Set(), initiators: new Set() };

    expect(applyRecall('m1', deps)).toEqual({ action: 'voided', scope: 's1', injected: false });
  });

  it('ignores a recall of a message it never saw, but remembers it for one still on its way', () => {
    const { activeRuns, recalled, deps } = setup();
    const handle = startRun(activeRuns, 's1', ['m1']);
    // Quoting the run's reply does not make the reply an input of the run.
    handle.supplement!.replyIds.add('reply');

    expect(applyRecall('reply', deps)).toEqual({ action: 'none' });
    expect(applyRecall('elsewhere', deps)).toEqual({ action: 'none' });
    expect(handle.interrupted).toBe(false);
    expect(recalled.has('elsewhere')).toBe(true);
  });

  it('settles a recall that landed while the batch was being prepared, once the run registers', () => {
    const { activeRuns, recalled, deps } = setup();
    applyRecall('m1', deps); // nothing to act on yet
    const partial = startRun(activeRuns, 's1', ['m1', 'm2']);
    expect(settleEarlyRecalls('s1', partial, deps)).toEqual([{ action: 'voided', scope: 's1', injected: true }]);
    expect(partial.interrupted).toBe(false);

    recalled.add('m3');
    const whole = startRun(activeRuns, 's2', ['m3']);
    expect(settleEarlyRecalls('s2', whole, deps)).toEqual([{ action: 'cancelled', scope: 's2' }]);
    expect(whole.stopCause).toBe('recalled');

    const untouched = startRun(activeRuns, 's3', ['m4']);
    expect(settleEarlyRecalls('s3', untouched, deps)).toEqual([]);
  });
});

describe('RecalledMessages', () => {
  it('forgets a recall after the window', () => {
    const recalled = new RecalledMessages(1_000);
    recalled.add('m1', 0);
    expect(recalled.has('m1', 1_000)).toBe(true);
    expect(recalled.has('m1', 1_001)).toBe(false);
    recalled.add('m2', 5_000);
    expect(recalled.has('m1', 5_000)).toBe(false);
  });
});

describe('parseRecallEvent', () => {
  it('reads the flattened event the SDK dispatcher hands raw handlers', () => {
    expect(
      parseRecallEvent({
        event_type: 'im.message.recalled_v1',
        message_id: 'om_1',
        chat_id: 'oc_1',
        recall_time: '1745000000000',
        recall_type: 'message_owner',
      }),
    ).toEqual({ messageId: 'om_1', chatId: 'oc_1', recallTime: '1745000000000', recallType: 'message_owner' });
  });

  it('also reads the nested v2 envelope, and rejects a body without a message id', () => {
    expect(parseRecallEvent({ header: {}, event: { message_id: 'om_2' } })).toEqual({ messageId: 'om_2' });
    expect(parseRecallEvent({ chat_id: 'oc_1' })).toBeUndefined();
    expect(parseRecallEvent(undefined)).toBeUndefined();
  });
});
