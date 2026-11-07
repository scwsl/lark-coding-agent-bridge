import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../../../src/scheduler/scheduler';
import { JobStore } from '../../../src/scheduler/store';
import type { JobRunRecord, ScheduledJob } from '../../../src/scheduler/types';

let dir: string;
let store: JobStore;
const sent: Array<{ chatId: string; payload: unknown }> = [];

const channel = {
  send: vi.fn(async (chatId: string, payload: unknown) => {
    sent.push({ chatId, payload });
    return { messageId: 'om_x' };
  }),
  botIdentity: { openId: 'ou_bot', name: 'bot' },
};

/** Minimal deps — every test injects `runJob`, so the agent path is never hit. */
function makeScheduler(opts: {
  now: () => number;
  runJob: (job: ScheduledJob) => Promise<JobRunRecord>;
}): Scheduler {
  return new Scheduler({
    store,
    channel: channel as never,
    executor: {} as never,
    sessions: {} as never,
    workspaces: {} as never,
    controls: {} as never,
    now: opts.now,
    runJob: opts.runJob,
  });
}

function job(overrides: Partial<ScheduledJob> = {}): Omit<ScheduledJob, 'id'> {
  return {
    prompt: '看一下昨天的日志',
    schedule: { kind: 'cron', expr: '0 9 * * *' },
    chatId: 'oc_chat',
    chatType: 'group',
    creatorId: 'ou_creator',
    session: 'fresh',
    enabled: true,
    createdAt: 0,
    ...overrides,
  } as Omit<ScheduledJob, 'id'>;
}

const ok = (): JobRunRecord => ({ startedAt: 1, finishedAt: 2, ok: true, terminal: 'done' });
const bad = (): JobRunRecord => ({ startedAt: 1, finishedAt: 2, ok: false, error: 'boom' });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lcb-scheduler-'));
  store = new JobStore(join(dir, 'jobs.json'));
  sent.length = 0;
  channel.send.mockClear();
});

afterEach(async () => {
  // Persists are fire-and-forget; drain them before the directory disappears.
  await store.flush();
  await rm(dir, { recursive: true, force: true });
});

describe('job store', () => {
  it('round-trips jobs through the file', async () => {
    const created = store.add(job());
    await store.flush();

    const reloaded = new JobStore(join(dir, 'jobs.json'));
    await reloaded.load();
    expect(reloaded.get(created.id)).toMatchObject({ prompt: '看一下昨天的日志', enabled: true });
  });

  it('persists with 0600 and drops entries that are not jobs', async () => {
    store.add(job());
    await store.flush();
    const raw = JSON.parse(await readFile(join(dir, 'jobs.json'), 'utf8')) as {
      jobs: Record<string, unknown>;
    };
    expect(Object.keys(raw.jobs)).toHaveLength(1);
    expect((await stat(join(dir, 'jobs.json'))).mode & 0o777).toBe(0o600);

    const corrupted = new JobStore(join(dir, 'jobs.json'));
    raw.jobs.broken = { id: 'broken' };
    await writeFile(join(dir, 'jobs.json'), JSON.stringify(raw));
    await corrupted.load();
    expect(corrupted.list()).toHaveLength(1);
  });

  it('only lists a chat’s own jobs', () => {
    store.add(job());
    store.add(job({ chatId: 'oc_other' }));
    expect(store.listForChat('oc_chat')).toHaveLength(1);
  });
});

describe('scheduler ticking', () => {
  it('fires a due job once and re-arms it for the next slot', async () => {
    let now = new Date('2026-09-22T08:59:00').getTime();
    const runJob = vi.fn(async () => ok());
    const scheduler = makeScheduler({ now: () => now, runJob });
    const created = store.add(job());
    scheduler.armJob(created.id);
    expect(store.get(created.id)?.nextRunAt).toBe(new Date('2026-09-22T09:00:00').getTime());

    await scheduler.tick();
    expect(runJob).not.toHaveBeenCalled();

    now = new Date('2026-09-22T09:00:30').getTime();
    await scheduler.tick();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(store.get(created.id)?.nextRunAt).toBe(new Date('2026-09-23T09:00:00').getTime());
    expect(store.get(created.id)?.lastRun?.ok).toBe(true);

    // Same tick window again: the job must not fire twice.
    await scheduler.tick();
    expect(runJob).toHaveBeenCalledTimes(1);
  });

  it('skips a cron fire that was missed by more than the catch-up window', async () => {
    const runJob = vi.fn(async () => ok());
    // Armed at 09:00, woken three days later.
    let now = new Date('2026-09-22T08:00:00').getTime();
    const scheduler = makeScheduler({ now: () => now, runJob });
    const created = store.add(job());
    scheduler.armJob(created.id);

    now = new Date('2026-09-25T08:00:00').getTime();
    await scheduler.tick();
    expect(runJob).not.toHaveBeenCalled();
    expect(store.get(created.id)?.nextRunAt).toBe(new Date('2026-09-25T09:00:00').getTime());
  });

  it('still fires a recently missed cron', async () => {
    const runJob = vi.fn(async () => ok());
    let now = new Date('2026-09-22T08:00:00').getTime();
    const scheduler = makeScheduler({ now: () => now, runJob });
    const created = store.add(job());
    scheduler.armJob(created.id);

    now = new Date('2026-09-22T11:00:00').getTime();
    await scheduler.tick();
    expect(runJob).toHaveBeenCalledTimes(1);
  });

  it('keeps a due slot across a restart instead of re-arming past it', async () => {
    // 06:00 slot was due (queued behind another job, or cut short) when the bridge restarted.
    const now = new Date('2026-11-07T06:03:27').getTime();
    const runJob = vi.fn(async () => ok());
    const created = store.add(job({ schedule: { kind: 'cron', expr: '0 6 * * *' } }));
    store.update(created.id, { nextRunAt: new Date('2026-11-07T06:00:00').getTime() });
    const scheduler = makeScheduler({ now: () => now, runJob });
    scheduler.start();
    scheduler.stop();
    expect(store.get(created.id)?.nextRunAt).toBe(new Date('2026-11-07T06:00:00').getTime());

    await scheduler.tick();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(store.get(created.id)?.nextRunAt).toBe(new Date('2026-11-08T06:00:00').getTime());
  });

  it('still re-arms future slots on start', () => {
    const now = new Date('2026-11-07T05:00:00').getTime();
    const created = store.add(job({ schedule: { kind: 'cron', expr: '0 6 * * *' } }));
    store.update(created.id, { nextRunAt: new Date('2026-11-09T06:00:00').getTime() });
    const scheduler = makeScheduler({ now: () => now, runJob: async () => ok() });
    scheduler.start();
    scheduler.stop();
    expect(store.get(created.id)?.nextRunAt).toBe(new Date('2026-11-07T06:00:00').getTime());
  });

  it('keeps the slot and the streak when a shutdown interrupts the run', async () => {
    const now = new Date('2026-11-07T06:00:30').getTime();
    let release!: (r: JobRunRecord) => void;
    const runJob = vi.fn(() => new Promise<JobRunRecord>((r) => { release = r; }));
    const created = store.add(job({ schedule: { kind: 'cron', expr: '0 6 * * 6' } }));
    const slot = new Date('2026-11-07T06:00:00').getTime();
    store.update(created.id, { nextRunAt: slot });
    const scheduler = makeScheduler({ now: () => now, runJob });
    scheduler.start();
    const ticking = scheduler.tick();
    await vi.waitFor(() => expect(runJob).toHaveBeenCalledTimes(1));
    scheduler.stop();
    release({ startedAt: 1, finishedAt: 2, ok: false, terminal: 'interrupted', error: 'interrupted' });
    await ticking;

    const after = store.get(created.id);
    expect(after?.nextRunAt).toBe(slot);
    expect(after?.failureStreak ?? 0).toBe(0);
    expect(after?.lastRun?.terminal).toBe('interrupted');
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('removes a one-shot after it fires', async () => {
    const now = new Date('2026-09-22T09:00:00').getTime();
    const runJob = vi.fn(async () => ok());
    const scheduler = makeScheduler({ now: () => now, runJob });
    const created = store.add(job({ schedule: { kind: 'once', at: now - 1000 } }));
    scheduler.armJob(created.id);
    // A one-shot whose moment already passed is still due on the next tick.
    store.update(created.id, { nextRunAt: now - 1000 });

    await scheduler.tick();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(store.get(created.id)).toBeUndefined();
  });

  it('never schedules a one-shot whose time has passed', () => {
    const now = new Date('2026-09-22T09:00:00').getTime();
    const scheduler = makeScheduler({ now: () => now, runJob: async () => ok() });
    const created = store.add(job({ schedule: { kind: 'once', at: now - 1 } }));
    expect(scheduler.armJob(created.id)?.nextRunAt).toBeUndefined();
  });

  it('reports a failure into the chat and auto-disables after repeated failures', async () => {
    let now = new Date('2026-09-22T08:00:00').getTime();
    const scheduler = makeScheduler({ now: () => now, runJob: async () => bad() });
    const created = store.add(job());
    scheduler.armJob(created.id);
    now = new Date('2026-09-22T09:00:30').getTime();

    for (let i = 0; i < 5; i++) {
      await scheduler.tick();
      now += 24 * 60 * 60 * 1000;
    }

    const stored = store.get(created.id);
    expect(stored?.failureStreak).toBe(5);
    expect(stored?.enabled).toBe(false);
    expect(stored?.nextRunAt).toBeUndefined();
    expect(sent).toHaveLength(5);
    expect(JSON.stringify(sent[4]?.payload)).toContain('自动暂停');
  });

  it('clears the failure streak after a success', async () => {
    let now = new Date('2026-09-22T08:00:00').getTime();
    let outcome = bad;
    const scheduler = makeScheduler({ now: () => now, runJob: async () => outcome() });
    const created = store.add(job());
    scheduler.armJob(created.id);
    now = new Date('2026-09-22T09:00:30').getTime();

    await scheduler.tick();
    expect(store.get(created.id)?.failureStreak).toBe(1);

    outcome = ok;
    now += 24 * 60 * 60 * 1000;
    await scheduler.tick();
    expect(store.get(created.id)?.failureStreak).toBe(0);
  });

  it('does not count a manual run toward auto-disable or move the schedule', async () => {
    const now = new Date('2026-09-22T08:00:00').getTime();
    const scheduler = makeScheduler({ now: () => now, runJob: async () => bad() });
    const created = store.add(job());
    scheduler.armJob(created.id);
    const armedAt = store.get(created.id)?.nextRunAt;

    for (let i = 0; i < 6; i++) await scheduler.runNow(created.id);

    const stored = store.get(created.id);
    expect(stored?.enabled).toBe(true);
    expect(stored?.failureStreak ?? 0).toBe(0);
    expect(stored?.nextRunAt).toBe(armedAt);
  });

  it('leaves a disabled job unarmed', async () => {
    const now = new Date('2026-09-22T09:00:30').getTime();
    const runJob = vi.fn(async () => ok());
    const scheduler = makeScheduler({ now: () => now, runJob });
    const created = store.add(job({ enabled: false }));
    scheduler.armJob(created.id);
    await scheduler.tick();
    expect(runJob).not.toHaveBeenCalled();
    expect(store.get(created.id)?.nextRunAt).toBeUndefined();
  });

  it('does not arm a job whose cron no longer parses', () => {
    const now = Date.now();
    const scheduler = makeScheduler({ now: () => now, runJob: async () => ok() });
    const created = store.add(job({ schedule: { kind: 'cron', expr: 'not a cron' } }));
    expect(scheduler.armJob(created.id)?.nextRunAt).toBeUndefined();
  });
});
