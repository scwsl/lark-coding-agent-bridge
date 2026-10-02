import { log } from '../core/logger';

/** Consecutive failed updates before the user is told the card is stuck. */
export const CARD_BROKEN_THRESHOLD = 3;

/**
 * Tracks whether the streamed progress card is still being updated.
 *
 * Feishu can start rejecting a card's updates mid-run (it did for a whole
 * review run: 49 rejected updates in a row). Nothing on screen shows that —
 * the card simply stops changing and looks exactly like an agent stuck in a
 * long tool call. This turns the failures into a signal: `onBroken` fires once
 * the updates have failed `threshold` times in a row, and `lastFailed` tells
 * the run at the end whether the card holds the final answer or not.
 */
export class CardPatchHealth {
  consecutiveFailures = 0;
  lastFailed = false;
  lastErrorCode: number | undefined;
  private reported = false;

  constructor(
    private readonly onBroken: (code: number | undefined) => void,
    private readonly threshold: number = CARD_BROKEN_THRESHOLD,
  ) {}

  success(): void {
    this.consecutiveFailures = 0;
    this.lastFailed = false;
  }

  failure(err: unknown): void {
    this.consecutiveFailures++;
    this.lastFailed = true;
    this.lastErrorCode = larkErrorCode(err);
    log.warn('card', 'patch-fail', {
      code: this.lastErrorCode ?? null,
      consecutive: this.consecutiveFailures,
      message: err instanceof Error ? err.message : String(err),
    });
    if (!this.reported && this.consecutiveFailures >= this.threshold) {
      this.reported = true;
      this.onBroken(this.lastErrorCode);
    }
  }
}

/**
 * Route the SDK card stream's patch results into `health`.
 *
 * The SDK (`@larksuite/channel` CardStreamControllerImpl) patches from a
 * throttle timer as `this.patch()` and lets a failure escape as an unhandled
 * rejection, so the caller never learns about it. Shadowing `patch` on the
 * controller instance catches every attempt — timer-driven and the final flush
 * alike. Failures are swallowed here on purpose: `health` now carries them,
 * and the run checks `health.lastFailed` once the stream completes.
 *
 * Returns false when the controller doesn't have that shape (a different SDK
 * version, a test fake): the run proceeds unchanged, just without detection.
 */
export function instrumentCardPatches(ctrl: object, health: CardPatchHealth): boolean {
  const target = ctrl as { patch?: unknown };
  const original = target.patch;
  if (typeof original !== 'function') return false;
  target.patch = async (): Promise<void> => {
    try {
      await (original as () => Promise<void>).call(ctrl);
      health.success();
    } catch (err) {
      health.failure(err);
    }
  };
  return true;
}

export function larkErrorCode(err: unknown): number | undefined {
  const code = (err as { response?: { data?: { code?: unknown } } } | undefined)?.response?.data
    ?.code;
  return typeof code === 'number' ? code : undefined;
}
