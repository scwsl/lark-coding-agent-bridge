import { describe, expect, it, vi } from 'vitest';
import {
  CardPatchHealth,
  instrumentCardPatches,
  larkErrorCode,
} from '../../../src/bot/card-patch-health.js';

/** Mirrors the SDK card stream: updates go out through `this.patch()`. */
class SdkLikeController {
  calls = 0;
  constructor(private readonly outcomes: Array<'ok' | 'fail'>) {}
  async patch(): Promise<void> {
    const outcome = this.outcomes[this.calls++] ?? 'ok';
    if (outcome === 'fail') {
      throw Object.assign(new Error('Request failed with status code 400'), {
        response: { data: { code: 230025 } },
      });
    }
  }
  /** What the SDK's throttle timer does. */
  fire(): Promise<void> {
    return this.patch();
  }
}

describe('card patch health', () => {
  it('reports a stuck card once after three failed updates in a row', async () => {
    const onBroken = vi.fn();
    const health = new CardPatchHealth(onBroken);
    const ctrl = new SdkLikeController(['fail', 'fail', 'fail', 'fail']);
    expect(instrumentCardPatches(ctrl, health)).toBe(true);

    for (let i = 0; i < 4; i++) await ctrl.fire();

    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(onBroken).toHaveBeenCalledWith(230025);
    expect(health.lastFailed).toBe(true);
    expect(health.lastErrorCode).toBe(230025);
  });

  it('swallows the failure instead of letting it escape the timer', async () => {
    const health = new CardPatchHealth(() => {});
    const ctrl = new SdkLikeController(['fail']);
    instrumentCardPatches(ctrl, health);
    await expect(ctrl.fire()).resolves.toBeUndefined();
  });

  it('a successful update clears the failure state', async () => {
    const onBroken = vi.fn();
    const health = new CardPatchHealth(onBroken);
    const ctrl = new SdkLikeController(['fail', 'fail', 'ok', 'fail', 'fail']);
    instrumentCardPatches(ctrl, health);
    for (let i = 0; i < 3; i++) await ctrl.fire();
    expect(health.lastFailed).toBe(false);
    for (let i = 0; i < 2; i++) await ctrl.fire();
    expect(onBroken).not.toHaveBeenCalled();
  });

  it('leaves controllers without a patch method alone', () => {
    const fake = { update: async () => {} };
    expect(instrumentCardPatches(fake, new CardPatchHealth(() => {}))).toBe(false);
    expect(fake).not.toHaveProperty('patch');
  });

  it('reads the Feishu error code off an API error', () => {
    expect(larkErrorCode({ response: { data: { code: 230099 } } })).toBe(230099);
    expect(larkErrorCode(new Error('x'))).toBeUndefined();
  });
});

describe('SDK shape the instrumentation relies on', () => {
  // instrumentCardPatches shadows `patch` on the card stream controller. That
  // only works while the SDK's throttle calls it as `this.patch()` and hands
  // the controller itself to the producer. Fail loudly on an SDK upgrade that
  // changes either, instead of silently losing stuck-card detection.
  it('@larksuite/channel card stream still patches through this.patch()', async () => {
    const { readFile } = await import('node:fs/promises');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@larksuite/channel');
    const source = await readFile(entry.replace(/index\.cjs$/, 'index.mjs'), 'utf8');
    const impl = source.slice(source.indexOf('var CardStreamControllerImpl = class'));
    const body = impl.slice(0, impl.indexOf('var CardStreamController = class'));
    expect(body).toContain('}, () => this.patch());');
    expect(body).toContain('async patch() {');
    expect(body).toContain('await producer(this);');
  });
});
