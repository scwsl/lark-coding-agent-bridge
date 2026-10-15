import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ALIVE_PID = 4242;

vi.mock('../../../src/runtime/registry', () => ({
  isAlive: (pid: number) => pid === ALIVE_PID,
}));

import { RunRegistry, type RunRecord } from '../../../src/runtime/run-registry';

const OWN_PID = 1111;
const DEAD_PID = 9999;

let dir: string;
let file: string;
let opened: RunRegistry[] = [];

/** Every registry made by a test, so afterEach can drain its debounced
 * writes before the temp dir goes away. */
function makeRegistry(pid: number): RunRegistry {
  const reg = new RunRegistry(file, pid);
  opened.push(reg);
  return reg;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'run-registry-test-'));
  file = join(dir, 'runs.json');
  opened = [];
});

afterEach(async () => {
  await Promise.all(opened.map((r) => r.flush()));
  await rm(dir, { recursive: true, force: true });
});

function record(over: Partial<RunRecord> = {}): Omit<RunRecord, 'ownerPid'> {
  return {
    runId: 'run-1',
    scope: 'oc_chat',
    chatId: 'oc_chat',
    originMessageId: 'om_1',
    promptPreview: '整理一份文档',
    startedAt: 1_000,
    ...over,
  };
}

describe('RunRegistry persistence', () => {
  it('round-trips a started run through the file', async () => {
    const a = makeRegistry(OWN_PID);
    a.start(record({ chatType: 'group', chatName: '研发群', actorId: 'ou_person', actorName: '张三' }));
    await a.flush();

    const b = makeRegistry(OWN_PID);
    await b.load();
    expect(b.size()).toBe(1);
    expect(b.takeOwn()[0]).toMatchObject({ runId: 'run-1', ownerPid: OWN_PID, chatType: 'group', chatName: '研发群', actorId: 'ou_person', actorName: '张三' });
  });

  it('drops a finished run from the file', async () => {
    const reg = makeRegistry(OWN_PID);
    reg.start(record());
    reg.finish('run-1');
    await reg.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({});
  });

  it('starts empty when the file does not exist', async () => {
    const reg = makeRegistry(OWN_PID);
    await reg.load();
    expect(reg.size()).toBe(0);
  });

  it('skips malformed entries instead of throwing', async () => {
    const reg = makeRegistry(OWN_PID);
    reg.start(record());
    await reg.flush();
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    raw['junk'] = { runId: 'junk' };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify(raw));

    const next = makeRegistry(OWN_PID);
    await next.load();
    expect(next.size()).toBe(1);
  });
});

describe('RunRegistry orphan detection', () => {
  it('claims records whose owning daemon is gone', async () => {
    const prev = makeRegistry(DEAD_PID);
    prev.start(record());
    await prev.flush();

    const next = makeRegistry(OWN_PID);
    await next.load();
    const orphans = next.takeOrphans(2_000);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.runId).toBe('run-1');
    // Claimed exactly once — a second sweep must not re-notify.
    expect(next.takeOrphans(2_000)).toHaveLength(0);
  });

  it('leaves records owned by a live daemon alone', async () => {
    const prev = makeRegistry(ALIVE_PID);
    prev.start(record());
    await prev.flush();

    const next = makeRegistry(OWN_PID);
    await next.load();
    expect(next.takeOrphans(2_000)).toHaveLength(0);
  });

  it('claims a live-owner record once it is older than a day', async () => {
    const prev = makeRegistry(ALIVE_PID);
    prev.start(record({ startedAt: 0 }));
    await prev.flush();

    const next = makeRegistry(OWN_PID);
    await next.load();
    expect(next.takeOrphans(25 * 60 * 60 * 1000)).toHaveLength(1);
  });

  it('never treats its own runs as orphans', () => {
    const reg = makeRegistry(OWN_PID);
    reg.start(record());
    expect(reg.takeOrphans(2_000)).toHaveLength(0);
    expect(reg.takeOwn()).toHaveLength(1);
  });
});
