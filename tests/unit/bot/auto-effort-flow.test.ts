import { beforeEach, describe, expect, it, vi } from 'vitest';

const classifyMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/agent/auto-effort', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agent/auto-effort')>();
  return { ...actual, classify: classifyMock };
});

import { AutoEffortStore, resolveAutoEffort } from '../../../src/agent/auto-effort';
import { autoEffortByline, startAutoEffort, type StartAutoEffortInput } from '../../../src/bot/auto-effort-flow';

const settings = resolveAutoEffort({ enabled: true })!;

function plan(store: AutoEffortStore, over: Partial<StartAutoEffortInput> = {}) {
  return startAutoEffort({
    settings,
    store,
    scope: 'p2p:ou_owner',
    texts: ['帮我查一下 staging-sea 这台设备为什么没有 0x10 数据'],
    attachments: 0,
    chatType: 'p2p',
    owner: true,
    cap: 'high',
    classify: { cwd: '/tmp/auto-effort-test', env: () => ({}) },
    now: () => 1_000,
    ...over,
  });
}

describe('startAutoEffort', () => {
  beforeEach(() => {
    classifyMock.mockReset();
  });

  it('starts a new conversation on the rated rung, then climbs one rung per message', async () => {
    const store = new AutoEffortStore();
    classifyMock.mockResolvedValue({ rung: 2, reason: '多系统排障' });
    const first = plan(store);
    const a = await first.pick(undefined, false);
    expect(a).toMatchObject({ label: 'xhigh', model: 'opus', effort: 'xhigh', via: 'fresh', reason: '多系统排障' });
    first.finish({ handle: 'sess-1', terminal: 'done', durationMs: 60_000 });

    classifyMock.mockResolvedValue({ rung: 3 });
    const second = plan(store, { texts: ['还是不对，换个思路彻底查一下根因'] });
    const b = await second.pick('sess-1', false);
    expect(b).toMatchObject({ label: 'fable', model: 'fable', via: 'up', from: 'xhigh' });
    expect(autoEffortByline(b!)).toBe('xhigh（自动↑）');
    // The rating saw where the conversation stood.
    expect(classifyMock.mock.calls[1]![1]).toMatchObject({ current: 'xhigh', last: { terminal: 'done' } });
  });

  it('keeps the rung on a short follow-up without rating it', async () => {
    const store = new AutoEffortStore();
    store.set('p2p:ou_owner', { rung: 2, downVotes: 0, handle: 'sess-1' });
    const p = plan(store, { texts: ['继续'] });
    expect(await p.pick('sess-1', false)).toMatchObject({ label: 'xhigh', via: 'stay' });
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('starts a short opener at the bottom', async () => {
    const p = plan(new AutoEffortStore(), { texts: ['你好'] });
    expect(await p.pick(undefined, false)).toMatchObject({ label: 'medium', via: 'fresh' });
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('starts over when the conversation changed', async () => {
    const store = new AutoEffortStore();
    store.set('p2p:ou_owner', { rung: 3, downVotes: 0, handle: 'sess-old' });
    classifyMock.mockResolvedValue({ rung: 1 });
    expect(await plan(store).pick(undefined, false)).toMatchObject({ label: 'high', via: 'fresh' });
  });

  it('caps runs the owner did not start at the chat effort', async () => {
    const store = new AutoEffortStore();
    store.set('group:oc_x', { rung: 1, downVotes: 0, handle: 'sess-1' });
    classifyMock.mockResolvedValue({ rung: 3 });
    const p = plan(store, { scope: 'group:oc_x', owner: false, chatType: 'group' });
    expect(await p.pick('sess-1', false)).toMatchObject({ label: 'high', via: 'stay' });
  });

  it('pins a /<rung> prefix and flags it for the agent', async () => {
    const store = new AutoEffortStore();
    const p = plan(store, { texts: ['/fable 设计一下新的账户调度'] });
    expect(p.forcedLabel).toBe('fable');
    expect(await p.pick(undefined, false)).toMatchObject({ label: 'fable', via: 'forced' });
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('skips Fable for a while after a run on it failed', async () => {
    const store = new AutoEffortStore();
    store.set('p2p:ou_owner', { rung: 3, downVotes: 0, handle: 'sess-1' });
    classifyMock.mockResolvedValue({ rung: 3 });
    const failed = plan(store);
    expect((await failed.pick('sess-1', false))?.label).toBe('fable');
    failed.finish({ handle: 'sess-1', terminal: 'error', durationMs: 5_000 });
    expect((await plan(store).pick('sess-1', false))?.label).toBe('xhigh');
  });

  it('leaves the rung alone when the message joins a live process', async () => {
    const store = new AutoEffortStore();
    store.set('p2p:ou_owner', { rung: 0, downVotes: 0, handle: 'sess-1' });
    classifyMock.mockResolvedValue({ rung: 3 });
    expect(await plan(store).pick('sess-1', true)).toMatchObject({ label: 'medium', via: 'stay' });
  });

  it('keeps the current rung when the rating fails', async () => {
    const store = new AutoEffortStore();
    store.set('p2p:ou_owner', { rung: 1, downVotes: 0, handle: 'sess-1' });
    classifyMock.mockResolvedValue(undefined);
    expect(await plan(store).pick('sess-1', false)).toMatchObject({ label: 'high', via: 'stay' });
  });
});

describe('startAutoEffort Fable quota', () => {
  beforeEach(() => {
    classifyMock.mockReset();
  });

  it('skips Fable while its own weekly window is past the line on the run account', async () => {
    const store = new AutoEffortStore();
    store.set('p2p:ou_owner', { rung: 2, downVotes: 0, handle: 'sess-1' });
    classifyMock.mockResolvedValue({ rung: 3 });
    const full = plan(store, { windowUsed: (kind) => (kind === 'seven_day_fable' ? 92 : undefined) });
    expect((await full.pick('sess-1', false))?.label).toBe('xhigh');
    const room = plan(store, { windowUsed: () => 40 });
    expect((await room.pick('sess-1', false))?.label).toBe('fable');
    const unknown = plan(store, { windowUsed: () => undefined });
    expect((await unknown.pick('sess-1', false))?.label).toBe('fable');
  });
});
