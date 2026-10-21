import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../core/logger';

/**
 * A task to start in a conversation without waiting for anyone to write in
 * it — e.g. the opening task of a topic a skill just opened, which would
 * otherwise sit idle until the owner replied "go".
 *
 * A file per task in the profile's `kickoffs/` directory:
 *
 * ```json
 * { "chatId": "oc_…", "chatType": "p2p", "threadId": "omt_…",
 *   "senderId": "ou_…", "originMessageId": "om_…", "prompt": "…" }
 * ```
 *
 * Writers put it there atomically (write `<name>.tmp`, then rename to
 * `<name>.json`). The run goes out as if `senderId` had sent `prompt` in that
 * conversation, replying to `originMessageId`; their access is checked again
 * when it fires. Only runs that may write into the bridge's own directory can
 * leave one there — other people's runs are fenced off from it.
 */
export interface Kickoff {
  chatId: string;
  chatType: 'p2p' | 'group';
  threadId?: string;
  senderId: string;
  senderName?: string;
  /** The message the run's reply goes under. */
  originMessageId: string;
  prompt: string;
}

/** Longest prompt a kickoff may carry; anything longer is a mistake, not a task. */
export const MAX_KICKOFF_PROMPT = 20_000;

export interface KickoffInboxOptions {
  dir: string;
  /** Start the run. Errors are logged; the file is gone either way. */
  fire: (kickoff: Kickoff) => Promise<void>;
  tickMs?: number;
}

/** Picks up kickoff files and starts each task once. */
export class KickoffInbox {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(private readonly opts: KickoffInboxOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 3_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over the directory. Returns how many tasks were started. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      let names: string[];
      try {
        names = await readdir(this.opts.dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw err;
      }
      let fired = 0;
      for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
        const path = join(this.opts.dir, name);
        let text: string;
        try {
          text = await readFile(path, 'utf8');
          // Consumed before it runs: a task that fails is reported, not retried
          // on every tick.
          await unlink(path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
        const kickoff = parseKickoff(text);
        if (!kickoff) {
          log.warn('kickoff', 'malformed', { file: name });
          continue;
        }
        log.info('kickoff', 'fire', {
          file: name,
          chatId: kickoff.chatId,
          threadId: kickoff.threadId,
          originMessageId: kickoff.originMessageId,
        });
        await this.opts.fire(kickoff).catch((err: unknown) => log.warn('kickoff', 'fire-failed', { file: name, err: String(err) }));
        fired += 1;
      }
      return fired;
    } catch (err) {
      log.warn('kickoff', 'tick-failed', { err: String(err) });
      return 0;
    } finally {
      this.ticking = false;
    }
  }
}

/** The kickoff a file describes, or undefined when it is not a usable one. */
export function parseKickoff(text: string): Kickoff | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const chatId = str(r.chatId);
  const senderId = str(r.senderId);
  const originMessageId = str(r.originMessageId);
  const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : '';
  if (!chatId?.startsWith('oc_') || !senderId || !originMessageId?.startsWith('om_')) return undefined;
  if (!prompt || prompt.length > MAX_KICKOFF_PROMPT) return undefined;
  const threadId = str(r.threadId);
  const senderName = str(r.senderName);
  return {
    chatId,
    chatType: r.chatType === 'p2p' ? 'p2p' : 'group',
    ...(threadId ? { threadId } : {}),
    senderId,
    ...(senderName ? { senderName } : {}),
    originMessageId,
    prompt,
  };
}

/** The session scope the kickoff runs in — the same one a reply there would land in. */
export function kickoffScope(kickoff: Kickoff): string {
  return kickoff.threadId ? `${kickoff.chatId}:${kickoff.threadId}` : kickoff.chatId;
}
