import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { attachEventHooks, resolveEventHooks, runEventHook, type EventHook } from '../../../src/events/hooks';

describe('resolveEventHooks', () => {
  it('keeps valid hooks and drops malformed ones', () => {
    const hooks = resolveEventHooks([
      { events: ['vc.bot.meeting_started_v1', ' vc.bot.meeting_started_v1 ', 'not an event'], command: ['/usr/bin/python3', 'x.py'] },
      { events: ['vc.bot.meeting_ended_v1'], command: [] },
      { events: [], command: ['/bin/true'] },
      { events: ['im.message.recalled_v1'], command: ['/bin/true'], timeoutSeconds: 3 },
      'junk',
    ]);
    expect(hooks).toEqual([
      { events: ['vc.bot.meeting_started_v1'], command: ['/usr/bin/python3', 'x.py'], timeoutMs: 120_000 },
      { events: ['im.message.recalled_v1'], command: ['/bin/true'], timeoutMs: 120_000 },
    ]);
    expect(resolveEventHooks(undefined)).toEqual([]);
    expect(resolveEventHooks([{ events: ['a.b'], command: ['/bin/true'], timeoutSeconds: 30 }])[0]!.timeoutMs).toBe(30_000);
  });
});

describe('attachEventHooks', () => {
  it('subscribes each event type once and runs only the matching hooks', () => {
    const handlers = new Map<string, (p: unknown) => void>();
    const channel = {
      onRawEvent: vi.fn((type: string, h: (p: unknown) => void) => {
        handlers.set(type, h);
        return () => handlers.delete(type);
      }),
    };
    const a: EventHook = { events: ['vc.bot.meeting_started_v1', 'vc.bot.meeting_ended_v1'], command: ['a'], timeoutMs: 1000 };
    const b: EventHook = { events: ['vc.bot.meeting_ended_v1'], command: ['b'], timeoutMs: 1000 };
    const run = vi.fn(async () => ({ code: 0, line: '', timedOut: false }));
    const off = attachEventHooks(channel, [a, b], run);
    expect(channel.onRawEvent).toHaveBeenCalledTimes(2);

    handlers.get('vc.bot.meeting_started_v1')!({ event_id: 'e1' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith(a, 'vc.bot.meeting_started_v1', { event_id: 'e1' });

    handlers.get('vc.bot.meeting_ended_v1')!({ event_id: 'e2' });
    expect(run).toHaveBeenCalledTimes(3);

    off();
    expect(handlers.size).toBe(0);
  });

  it('is a no-op without onRawEvent or hooks', () => {
    const run = vi.fn();
    expect(() => attachEventHooks({}, [{ events: ['a.b'], command: ['x'], timeoutMs: 1 }], run)()).not.toThrow();
    expect(() => attachEventHooks(undefined, [], run)()).not.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('runEventHook', () => {
  it('feeds the event on stdin and reports exit code and last line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'event-hook-'));
    const file = join(dir, 'in.json');
    const r = await runEventHook(
      { events: ['vc.bot.meeting_started_v1'], command: ['/bin/sh', '-c', `cat > "${file}"; echo "$BRIDGE_EVENT_TYPE"; echo done`], timeoutMs: 10_000 },
      'vc.bot.meeting_started_v1',
      { meeting: { meeting_no: '123456789' } },
    );
    expect(r).toEqual({ code: 0, line: 'done', timedOut: false });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      eventType: 'vc.bot.meeting_started_v1',
      payload: { meeting: { meeting_no: '123456789' } },
    });
  });

  it('kills a command that runs past the timeout, and reports spawn errors', async () => {
    const slow = await runEventHook({ events: ['a.b'], command: ['/bin/sh', '-c', 'sleep 5'], timeoutMs: 100 }, 'a.b', {});
    expect(slow.timedOut).toBe(true);
    expect(slow.code).not.toBe(0);
    const missing = await runEventHook({ events: ['a.b'], command: ['/nonexistent/cmd'], timeoutMs: 1000 }, 'a.b', {});
    expect(missing.code).not.toBe(0);
  });
});
