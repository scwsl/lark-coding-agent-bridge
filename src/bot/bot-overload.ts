import { mkdir } from 'node:fs/promises';
import { quotaResetAt, readAgentQuota, type QuotaReading, type QuotaWindow } from '../agent/quota';
import type { ProfileConfig } from '../config/profile-schema';
import type { BotOverloadSettings } from '../config/schema';

/**
 * 过载保护: in the group chats listed in `preferences.botOverload` (`*`: all), other
 * bots' questions are not answered while the agent account's quota is tight —
 * the bot posts an overload card instead and starts no run, so what is left
 * goes to the humans. A window counts as tight when it is used above its limit
 * and its reset is still further away than its grace period: close to a reset
 * the rest would be thrown away anyway, so bots get answered again.
 */

export interface OverloadWindow {
  kind: 'week' | 'session';
  label: string;
  usedPercent: number;
  limit: number;
  /** Epoch ms; undefined when the CLI's wording could not be read. */
  resetAt?: number;
}

export type OverloadDecision = { overload: false } | { overload: true; windows: OverloadWindow[] };

const LABELS: Record<OverloadWindow['kind'], string> = { week: '本周', session: '5 小时窗口' };

/** The tight windows of a quota reading, or `{ overload: false }`. Unknown quota never blocks. */
export function planBotOverload(settings: BotOverloadSettings, reading: QuotaReading | undefined, now: number): OverloadDecision {
  if (!reading) return { overload: false };
  const tight: OverloadWindow[] = [];
  for (const kind of ['week', 'session'] as const) {
    const window = reading.windows.find((item) => item.label === LABELS[kind]);
    const limit = kind === 'week' ? settings.weekPercent : settings.sessionPercent;
    const graceMs = (kind === 'week' ? settings.weekGraceHours : settings.sessionGraceHours) * 3_600_000;
    const used = reading.blocked ? 100 : window?.usedPercent;
    if (used === undefined || used <= limit) continue;
    const resetAt = quotaResetAt(window?.resets, now);
    // Inside the last hours before the reset: what is left would expire unused.
    if (resetAt !== undefined && resetAt - now <= graceMs) continue;
    tight.push({ kind, label: LABELS[kind], usedPercent: Math.round(used), limit, ...(resetAt !== undefined ? { resetAt } : {}) });
  }
  return tight.length > 0 ? { overload: true, windows: tight } : { overload: false };
}

/** A batch the rule applies to: every message comes from a bot. */
export function isBotOnlyBatch<T>(batch: readonly T[], senderType: (msg: T) => 'user' | 'bot' | undefined): boolean {
  return batch.length > 0 && batch.every((msg) => senderType(msg) === 'bot');
}

/** The owners (open_ids, in order, no repeats) of the bots behind these sender ids, from the bot ↔ owner table. */
export function botOwnersOf(settings: BotOverloadSettings, senderIds: readonly string[]): string[] {
  const owners: string[] = [];
  for (const id of senderIds) {
    const owner = settings.botOwners.find((entry) => entry.ids.includes(id))?.owner;
    if (owner && !owners.includes(owner)) owners.push(owner);
  }
  return owners;
}

/** 白名单: a whitelisted chat, or a batch with a message from a whitelisted bot, is always answered. */
export function isOverloadExempt(settings: BotOverloadSettings, chatId: string, senderIds: readonly string[]): boolean {
  if (settings.exceptChats.includes(chatId)) return true;
  return senderIds.some((id) => settings.exceptBots.includes(id));
}

const QUOTA_TTL_MS = 5 * 60_000;

/**
 * The quota reading (cached for a few minutes — `claude -p /usage` takes
 * seconds) and the per-chat cooldown of the overload card.
 */
export class BotOverloadGuard {
  private cached: { at: number; reading: QuotaReading | undefined } | undefined;
  private reading: Promise<QuotaReading | undefined> | undefined;
  private readonly lastCard = new Map<string, number>();

  constructor(
    private readonly deps: {
      profileConfig: () => ProfileConfig;
      scratchDir: string;
      profileDir?: string;
      readQuota?: () => Promise<QuotaReading | undefined>;
      now?: () => number;
    },
  ) {}

  /**
   * Whether this bot-only batch in `chatId` goes unanswered, and whether a
   * card is due (`card: false` inside the cooldown: drop it silently).
   */
  async decide(
    settings: BotOverloadSettings,
    chatId: string,
  ): Promise<{ overload: false } | { overload: true; card: boolean; windows: OverloadWindow[] }> {
    if (!settings.chats.includes('*') && !settings.chats.includes(chatId)) return { overload: false };
    const now = this.now();
    const decision = planBotOverload(settings, await this.quota(now), now);
    if (!decision.overload) return decision;
    const last = this.lastCard.get(chatId);
    const card = last === undefined || now - last >= settings.cooldownMinutes * 60_000;
    if (card) this.lastCard.set(chatId, now);
    return { overload: true, card, windows: decision.windows };
  }

  private async quota(now: number): Promise<QuotaReading | undefined> {
    if (this.cached && now - this.cached.at < QUOTA_TTL_MS) return this.cached.reading;
    this.reading ??= this.read().finally(() => {
      this.reading = undefined;
    });
    const reading = await this.reading;
    this.cached = { at: now, reading };
    return reading;
  }

  private async read(): Promise<QuotaReading | undefined> {
    if (this.deps.readQuota) return this.deps.readQuota().catch(() => undefined);
    await mkdir(this.deps.scratchDir, { recursive: true, mode: 0o700 });
    return readAgentQuota(this.deps.profileConfig(), {
      cwd: this.deps.scratchDir,
      ...(this.deps.profileDir ? { profileDir: this.deps.profileDir } : {}),
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

export type { QuotaWindow };
