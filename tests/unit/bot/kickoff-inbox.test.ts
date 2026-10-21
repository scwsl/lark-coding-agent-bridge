import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KickoffInbox,
  MAX_KICKOFF_PROMPT,
  kickoffScope,
  parseKickoff,
  type Kickoff,
} from '../../../src/bot/kickoff-inbox.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function inboxDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kickoff-'));
  dirs.push(dir);
  return dir;
}

const topic = {
  chatId: 'oc_chat',
  chatType: 'p2p',
  threadId: 'omt_topic',
  senderId: 'ou_owner',
  originMessageId: 'om_opened',
  prompt: '按首帖简报开始执行',
};

describe('parseKickoff', () => {
  it('reads a complete kickoff, trimming text fields', () => {
    expect(parseKickoff(JSON.stringify({ ...topic, prompt: '  开始  ', senderName: ' 王仕龙 ' }))).toEqual({
      ...topic,
      prompt: '开始',
      senderName: '王仕龙',
    });
  });

  it('treats anything but p2p as a group chat and leaves out an absent thread', () => {
    const { threadId: _drop, ...noThread } = topic;
    expect(parseKickoff(JSON.stringify({ ...noThread, chatType: 'topic' }))).toEqual({ ...noThread, chatType: 'group' });
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['no chat', JSON.stringify({ ...topic, chatId: '' })],
    ['a chat id of the wrong kind', JSON.stringify({ ...topic, chatId: 'ou_x' })],
    ['no sender', JSON.stringify({ ...topic, senderId: undefined })],
    ['no message to reply to', JSON.stringify({ ...topic, originMessageId: 'x' })],
    ['an empty prompt', JSON.stringify({ ...topic, prompt: '   ' })],
    ['an oversized prompt', JSON.stringify({ ...topic, prompt: 'x'.repeat(MAX_KICKOFF_PROMPT + 1) })],
  ])('rejects %s', (_label, text) => {
    expect(parseKickoff(text)).toBeUndefined();
  });
});

describe('kickoffScope', () => {
  it('is the topic scope inside a thread and the chat otherwise', () => {
    expect(kickoffScope(topic as Kickoff)).toBe('oc_chat:omt_topic');
    expect(kickoffScope({ ...(topic as Kickoff), threadId: undefined })).toBe('oc_chat');
  });
});

describe('KickoffInbox', () => {
  it('starts each kickoff once and consumes its file', async () => {
    const dir = await inboxDir();
    await writeFile(join(dir, 'a.json'), JSON.stringify(topic));
    const fire = vi.fn(async () => {});
    const inbox = new KickoffInbox({ dir, fire });

    expect(await inbox.tick()).toBe(1);
    expect(fire).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'oc_chat', threadId: 'omt_topic' }));
    expect(await readdir(dir)).toEqual([]);
    expect(await inbox.tick()).toBe(0);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('drops malformed files without firing and leaves half-written ones alone', async () => {
    const dir = await inboxDir();
    await writeFile(join(dir, 'bad.json'), '{"chatId":');
    await writeFile(join(dir, 'later.tmp'), JSON.stringify(topic));
    const fire = vi.fn(async () => {});

    expect(await new KickoffInbox({ dir, fire }).tick()).toBe(0);
    expect(fire).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(['later.tmp']);
  });

  it('does not retry a kickoff whose run failed to start', async () => {
    const dir = await inboxDir();
    await writeFile(join(dir, 'a.json'), JSON.stringify(topic));
    const fire = vi.fn(async () => {
      throw new Error('boom');
    });
    const inbox = new KickoffInbox({ dir, fire });

    await inbox.tick();
    await inbox.tick();
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('is quiet when the directory does not exist yet', async () => {
    const dir = join(await inboxDir(), 'missing');
    expect(await new KickoffInbox({ dir, fire: vi.fn() }).tick()).toBe(0);
  });
});
