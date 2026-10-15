import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { PendingStore } from '../../../src/bot/pending-store';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function storePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pending-store-'));
  dirs.push(dir);
  return join(dir, 'pending.json');
}

function msg(id: string, content = `text ${id}`): NormalizedMessage {
  return { messageId: id, chatId: 'oc_1', chatType: 'p2p', senderId: 'ou_1', content } as NormalizedMessage;
}

describe('PendingStore', () => {
  it('survives a new process: what one store records, the next one takes exactly once', async () => {
    const path = await storePath();
    const first = new PendingStore(path);
    first.set('oc_1', [msg('m1'), msg('m2')], 1000);
    first.set('oc_2', [msg('m3')], 2000);
    first.set('oc_2', [], 3000);
    await first.flush();
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const next = new PendingStore(path);
    await next.load();
    expect(next.takeAll()).toEqual([{ scope: 'oc_1', queuedAt: 1000, messages: [msg('m1'), msg('m2')] }]);
    expect(next.takeAll()).toEqual([]);
    await next.flush();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({});
  });

  it('keeps the oldest queue time as a scope grows', async () => {
    const store = new PendingStore(await storePath());
    store.set('oc_1', [msg('m1')], 1000);
    store.set('oc_1', [msg('m1'), msg('m2')], 5000);
    expect(store.takeAll()[0]?.queuedAt).toBe(1000);
    await store.flush();
  });

  it('ignores a corrupt file instead of failing boot', async () => {
    const path = await storePath();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{not json', 'utf8');
    const store = new PendingStore(path);
    await store.load();
    expect(store.takeAll()).toEqual([]);
  });
});

describe('PendingQueue durability hooks', () => {
  it('reports every change, and stop() forgets in memory without reporting the messages gone', () => {
    const changes: Array<[string, string[]]> = [];
    const flushed: string[][] = [];
    const queue = new PendingQueue(
      10_000,
      (_scope, batch) => flushed.push(batch.map((m) => m.messageId)),
      (scope, messages) => changes.push([scope, messages.map((m) => m.messageId)]),
    );
    queue.push('s1', msg('a'));
    queue.push('s1', msg('b'));
    queue.push('s2', msg('c'));
    queue.cancel('s2');
    queue.stop();

    expect(changes).toEqual([
      ['s1', ['a']],
      ['s1', ['a', 'b']],
      ['s2', ['c']],
      ['s2', []],
    ]);
    expect(queue.depth('s1')).toBe(0);
    expect(flushed).toEqual([]);
  });
});
