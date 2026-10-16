import { describe, expect, it } from 'vitest';
import { normalizeProfileConfig } from '../../../src/config/profile-schema';
import { effortPrefForChat, type EffortLevel } from '../../../src/config/schema';

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

describe('effortPrefForChat', () => {
  const prefs = { effort: 'high' as EffortLevel, chatEffort: { oc_vip: 'xhigh' as EffortLevel } };

  it('uses the chat override when the chat is listed', () => {
    expect(effortPrefForChat(prefs, 'oc_vip')).toBe('xhigh');
  });

  it('falls back to the profile-wide effort for other chats and chat-less runs', () => {
    expect(effortPrefForChat(prefs, 'oc_other')).toBe('high');
    expect(effortPrefForChat(prefs, undefined)).toBe('high');
  });

  it('ignores a mistyped override instead of dropping to the CLI default', () => {
    const typo = { effort: 'high' as EffortLevel, chatEffort: { oc_vip: 'xhight' as EffortLevel } };
    expect(effortPrefForChat(typo, 'oc_vip')).toBe('high');
  });

  it('returns undefined when nothing is set', () => {
    expect(effortPrefForChat(undefined, 'oc_vip')).toBeUndefined();
    expect(effortPrefForChat({}, 'oc_vip')).toBeUndefined();
  });

  it('survives profile normalization', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      preferences: { effort: 'high', chatEffort: { oc_vip: 'xhigh' } },
    });
    expect(effortPrefForChat(cfg.preferences, 'oc_vip')).toBe('xhigh');
    expect(effortPrefForChat(cfg.preferences, 'oc_other')).toBe('high');
  });
});
