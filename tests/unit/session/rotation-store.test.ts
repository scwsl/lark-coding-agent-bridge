import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PendingRotationStore } from '../../../src/session/rotation-store';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const DAY = 24 * 60 * 60_000;
const tmps: TmpProfile[] = [];

afterEach(async () => {
  await Promise.all(tmps.splice(0).map((tmp) => tmp.cleanup()));
});

async function storePath(): Promise<string> {
  const tmp = await createTmpProfile('rotation-store-');
  tmps.push(tmp);
  return join(tmp.profile, 'pending-rotations.json');
}

describe('PendingRotationStore', () => {
  it('survives a reload and is consumed by take', async () => {
    const path = await storePath();
    const first = new PendingRotationStore(path);
    first.set('oc_chat', { summary: '做完了', handle: 'sess-1' }, 1_000);
    await first.flush();
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const second = new PendingRotationStore(path);
    await second.load(2_000);
    expect(second.get('oc_chat')).toEqual({ summary: '做完了', handle: 'sess-1', requestedAt: 1_000 });
    expect(second.take('oc_chat')).toMatchObject({ handle: 'sess-1' });
    expect(second.take('oc_chat')).toBeUndefined();
    await second.flush();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({});
  });

  it('drops malformed and month-old entries at load', async () => {
    const path = await storePath();
    const now = 100 * DAY;
    await writeFile(
      path,
      JSON.stringify({
        fresh: { requestedAt: now - DAY },
        stale: { requestedAt: now - 31 * DAY },
        broken: { summary: 42, requestedAt: now },
        missing: {},
      }),
    );
    const store = new PendingRotationStore(path);
    await store.load(now);
    expect(store.get('fresh')).toBeDefined();
    expect(store.get('stale')).toBeUndefined();
    expect(store.get('broken')).toBeUndefined();
    expect(store.get('missing')).toBeUndefined();
  });

  it('works in memory without a path', async () => {
    const store = new PendingRotationStore();
    await store.load();
    store.set('oc_chat', {});
    expect(store.take('oc_chat')).toMatchObject({ requestedAt: expect.any(Number) });
    await store.flush();
  });
});
