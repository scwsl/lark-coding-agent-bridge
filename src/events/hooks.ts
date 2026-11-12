import { log } from '../core/logger';
import { spawnProcess } from '../platform/spawn';

/**
 * 事件钩子 (`preferences.eventHooks`): hand selected platform events to a local
 * command. The bridge already holds the app's only long connection, so this is
 * how anything else on the machine gets pushes — a second connection for the
 * same app would make Feishu split delivery and the bridge's own IM events
 * would start disappearing.
 *
 * Built for 会议跟会 (`vc.bot.meeting_started_v1` etc. → the auto-join script),
 * but any event type works once it is subscribed in the developer console.
 * Config-file only; read at startup, so a change needs a bridge restart.
 */
export interface EventHookConfig {
  /** Event types, e.g. `vc.bot.meeting_started_v1`. */
  events?: unknown;
  /** argv (no shell). The event goes to stdin as `{"eventType":…,"payload":…}`. */
  command?: unknown;
  /** Kill the command after this long. Default 120, range 5–1800. */
  timeoutSeconds?: unknown;
}

export interface EventHook {
  events: string[];
  command: string[];
  timeoutMs: number;
}

export interface EventHookResult {
  code: number | null;
  /** Last non-empty output line (stdout, else stderr), or the spawn error. */
  line: string;
  timedOut: boolean;
}

const EVENT_TYPE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
const DEFAULT_TIMEOUT_SECONDS = 120;
const OUTPUT_CAP = 8 * 1024;

/** Valid hooks only: a hook with no usable event type or an empty command is dropped. */
export function resolveEventHooks(raw: unknown): EventHook[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): EventHook[] => {
    if (!entry || typeof entry !== 'object') return [];
    const cfg = entry as EventHookConfig;
    const events = Array.isArray(cfg.events)
      ? [...new Set(cfg.events.filter((e): e is string => typeof e === 'string').map((e) => e.trim()).filter((e) => EVENT_TYPE.test(e)))]
      : [];
    const command = Array.isArray(cfg.command) ? cfg.command.filter((c): c is string => typeof c === 'string') : [];
    if (events.length === 0 || command.length === 0 || !command[0]!.trim()) return [];
    const seconds =
      typeof cfg.timeoutSeconds === 'number' && Number.isFinite(cfg.timeoutSeconds) && cfg.timeoutSeconds >= 5 && cfg.timeoutSeconds <= 1800
        ? cfg.timeoutSeconds
        : DEFAULT_TIMEOUT_SECONDS;
    return [{ events, command, timeoutMs: Math.round(seconds * 1000) }];
  });
}

interface RawEventSource {
  onRawEvent(eventType: string, handler: (payload: unknown) => void | Promise<void>): () => void;
}

export type EventHookRunner = (hook: EventHook, eventType: string, payload: unknown) => Promise<EventHookResult>;

/**
 * Subscribe every hooked event type on the channel's existing connection.
 * The handler only spawns — it never waits for the command — so the
 * dispatcher acknowledges Feishu right away and a slow hook cannot cause a
 * redelivery. Returns a teardown; a no-op when the channel has no `onRawEvent`.
 */
export function attachEventHooks(channel: unknown, hooks: EventHook[], run: EventHookRunner = runEventHook): () => void {
  if (hooks.length === 0) return () => {};
  const source = channel as RawEventSource | undefined;
  if (typeof source?.onRawEvent !== 'function') {
    log.warn('event-hook', 'unavailable', { reason: 'channel 不支持 onRawEvent' });
    return () => {};
  }
  const types = [...new Set(hooks.flatMap((h) => h.events))];
  const offs = types.map((eventType) =>
    source.onRawEvent(eventType, (payload) => {
      log.info('event-hook', 'received', { eventType, eventId: eventIdOf(payload) });
      for (const hook of hooks) {
        if (!hook.events.includes(eventType)) continue;
        void run(hook, eventType, payload).then(
          (r) => {
            const fields = { eventType, command: hook.command.join(' ').slice(0, 200), code: r.code, timedOut: r.timedOut, line: r.line.slice(0, 300) };
            if (r.code === 0) log.info('event-hook', 'done', fields);
            else log.warn('event-hook', 'failed', fields);
          },
          (err) => log.warn('event-hook', 'failed', { eventType, err: String(err) }),
        );
      }
    }),
  );
  log.info('event-hook', 'attached', { events: types });
  return () => {
    for (const off of offs) {
      try {
        off();
      } catch {
        // Channel already torn down.
      }
    }
  };
}

/** Run one hook: event JSON on stdin, killed after `timeoutMs`. Never rejects. */
export function runEventHook(hook: EventHook, eventType: string, payload: unknown): Promise<EventHookResult> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    const finish = (r: EventHookResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawnProcess(hook.command[0]!, hook.command.slice(1), {
      env: { ...process.env, BRIDGE_EVENT_TYPE: eventType },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, hook.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      out = (out + chunk.toString()).slice(-OUTPUT_CAP);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString()).slice(-OUTPUT_CAP);
    });
    child.once('error', (e) => finish({ code: null, line: String(e), timedOut }));
    child.once('close', (code) => finish({ code, line: lastLine(out) || lastLine(err), timedOut }));
    // A command that ignores stdin closes the pipe early; that is not our failure.
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ eventType, payload }));
  });
}

function eventIdOf(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const header = p.header && typeof p.header === 'object' ? (p.header as Record<string, unknown>) : undefined;
  const id = p.event_id ?? header?.event_id ?? p.uuid;
  return typeof id === 'string' ? id : undefined;
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}
