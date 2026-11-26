import { describe, expect, it, vi } from 'vitest';
import { createLarkChannel } from '@larksuite/channel';

// patches/@larksuite__channel@0.6.0.patch: a 5xx on im.message.reply/create is
// retried, but Feishu may already have delivered the message. Without a shared
// `uuid` every retry posts another copy (11-26: three identical progress cards).
function stubSender(fail: number) {
  const ch = createLarkChannel({ appId: 'cli_test', appSecret: 'x', outbound: { retry: { baseDelayMs: 1 } } } as never) as unknown as {
    sender: { client: unknown; sendCardByReference: (...a: unknown[]) => Promise<string> };
  };
  const calls: Array<Record<string, unknown>> = [];
  const err = Object.assign(new Error('Request failed with status code 500'), {
    response: { status: 500, data: { code: 2200, msg: 'internal error' } },
  });
  const op = vi.fn(async (req: { data: Record<string, unknown> }) => {
    calls.push(req.data);
    if (calls.length <= fail) throw err;
    return { data: { message_id: 'om_ok' } };
  });
  ch.sender.client = { im: { v1: { message: { reply: op, create: op } } } };
  return { sender: ch.sender, calls };
}

describe('outbound send retry dedupe (SDK patch)', () => {
  it('reuses one uuid across retries of a reply', async () => {
    const { sender, calls } = stubSender(2);
    const id = await sender.sendCardByReference('oc_x', 'chat_id', 'card_1', { replyTo: 'om_parent', replyInThread: true });
    expect(id).toBe('om_ok');
    expect(calls).toHaveLength(3);
    const uuids = new Set(calls.map((c) => c.uuid));
    expect(uuids.size).toBe(1);
    expect(typeof calls[0].uuid).toBe('string');
    expect((calls[0].uuid as string).length).toBeLessThanOrEqual(50);
  });

  it('reuses one uuid across retries of a create, and a new send gets a new uuid', async () => {
    const { sender, calls } = stubSender(1);
    await sender.sendCardByReference('oc_x', 'chat_id', 'card_1', {});
    await sender.sendCardByReference('oc_x', 'chat_id', 'card_2', {});
    expect(calls).toHaveLength(3);
    expect(calls[0].uuid).toBe(calls[1].uuid);
    expect(calls[2].uuid).not.toBe(calls[0].uuid);
  });
});
