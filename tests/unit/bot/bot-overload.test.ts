import { describe, expect, it } from 'vitest';
import { botOwnersOf, BotOverloadGuard, isBotOnlyBatch, isOverloadExempt, planBotOverload, planBotOverloadAcross } from '../../../src/bot/bot-overload.js';
import { overloadCard } from '../../../src/card/templates.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { resolveBotOverload, type BotOverloadSettings } from '../../../src/config/schema.js';

const NOW = Date.parse('2026-10-16T13:30:00Z'); // 21:30 Shanghai
const GROUP = 'oc_aibot';

const settings: BotOverloadSettings = resolveBotOverload({ preferences: { botOverload: { chats: [GROUP] } } })!;

const reading = (week: [number, string], session: [number, string]) => ({
  windows: [
    { label: '5 小时窗口', usedPercent: session[0], resets: session[1] },
    { label: '本周', usedPercent: week[0], resets: week[1] },
  ],
});

describe('resolveBotOverload', () => {
  it('is off without chats and fills in the defaults', () => {
    expect(resolveBotOverload({ preferences: {} })).toBeUndefined();
    expect(resolveBotOverload({ preferences: { botOverload: { chats: ['not-a-chat'] } } })).toBeUndefined();
    expect(settings).toEqual({
      chats: [GROUP],
      weekPercent: 80,
      weekGraceHours: 6,
      sessionPercent: 80,
      sessionGraceHours: 1,
      cooldownMinutes: 10,
      exceptChats: [],
      exceptBots: [],
      botOwners: [],
    });
  });
});

describe('planBotOverload', () => {
  it('blocks bots while the weekly window is over 80% and more than 6 hours from its reset', () => {
    const decision = planBotOverload(settings, reading([90, 'Oct 20 at 9am (Asia/Shanghai)'], [20, 'Oct 17 at 12:20am (Asia/Shanghai)']), NOW);
    expect(decision).toEqual({
      overload: true,
      windows: [{ kind: 'week', label: '本周', usedPercent: 90, limit: 80, resetAt: Date.parse('2026-10-20T01:00:00Z') }],
    });
  });

  it('answers again in the last 6 hours before the weekly reset', () => {
    // resets 10-17 03:00 Shanghai = 10-16 19:00Z, 5.5 hours from now
    expect(planBotOverload(settings, reading([95, 'Oct 17 at 3am (Asia/Shanghai)'], [10, 'Oct 17 at 1am (Asia/Shanghai)']), NOW)).toEqual({
      overload: false,
    });
  });

  it('blocks on the 5-hour window too, except in its last hour', () => {
    const far = planBotOverload(settings, reading([30, 'Oct 20 at 9am (Asia/Shanghai)'], [85, 'Oct 17 at 12:20am (Asia/Shanghai)']), NOW);
    expect(far).toMatchObject({ overload: true, windows: [{ kind: 'session', usedPercent: 85 }] });
    const near = planBotOverload(settings, reading([30, 'Oct 20 at 9am (Asia/Shanghai)'], [85, 'Oct 16 at 10:10pm (Asia/Shanghai)']), NOW);
    expect(near).toEqual({ overload: false });
  });

  it('needs more than the limit, and never blocks without a reading', () => {
    expect(planBotOverload(settings, reading([80, 'Oct 20 at 9am (Asia/Shanghai)'], [80, 'Oct 17 at 1am (Asia/Shanghai)']), NOW)).toEqual({
      overload: false,
    });
    expect(planBotOverload(settings, undefined, NOW)).toEqual({ overload: false });
  });

  it('treats an unreadable reset time as far away', () => {
    expect(planBotOverload(settings, reading([90, 'someday'], [0, 'x']), NOW)).toMatchObject({
      overload: true,
      windows: [{ kind: 'week' }],
    });
  });
});

describe('planBotOverloadAcross', () => {
  const tightWeek = reading([81, 'Oct 20 at 9am (Asia/Shanghai)'], [13, 'Oct 17 at 12:20am (Asia/Shanghai)']);
  const tightSession = reading([50, 'Oct 22 at 9am (Asia/Shanghai)'], [98, 'Oct 17 at 2am (Asia/Shanghai)']);

  it('answers bots while any account still has room', () => {
    const roomy = reading([15, 'Oct 22 at 9am (Asia/Shanghai)'], [10, 'Oct 17 at 2am (Asia/Shanghai)']);
    expect(planBotOverloadAcross(settings, [tightWeek, roomy], NOW)).toEqual({ overload: false });
  });

  it('with every account tight, shows the one that frees up first', () => {
    const decision = planBotOverloadAcross(settings, [tightWeek, tightSession], NOW);
    expect(decision).toEqual({
      overload: true,
      windows: [expect.objectContaining({ kind: 'session', usedPercent: 98 })],
    });
  });

  it('never blocks without a reading', () => {
    expect(planBotOverloadAcross(settings, [], NOW)).toEqual({ overload: false });
  });
});

describe('every group', () => {
  it('applies to any group chat with "*"', async () => {
    const all = resolveBotOverload({ preferences: { botOverload: { chats: ['*', 'oc_x'] } } })!;
    expect(all.chats).toEqual(['*']);
    const guard = new BotOverloadGuard({
      profileConfig: () => createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'a', secret: 's', tenant: 'feishu' } } }),
      scratchDir: '/tmp/unused',
      readQuota: async () => reading([90, 'Oct 20 at 9am (Asia/Shanghai)'], [10, 'Oct 17 at 1am (Asia/Shanghai)']),
      now: () => NOW,
    });
    expect(await guard.decide(all, 'oc_anything')).toMatchObject({ overload: true, card: true });
  });
});

describe('白名单', () => {
  it('exempts listed chats and listed bots, by open_id or app id', () => {
    const listed = resolveBotOverload({
      preferences: { botOverload: { chats: ['*'], exceptChats: ['oc_vip', 'bad'], exceptBots: ['cli_cc', 'ou_shawn', 'x'] } },
    })!;
    expect(listed.exceptChats).toEqual(['oc_vip']);
    expect(listed.exceptBots).toEqual(['cli_cc', 'ou_shawn']);
    expect(isOverloadExempt(listed, 'oc_vip', ['cli_other'])).toBe(true);
    expect(isOverloadExempt(listed, 'oc_group', ['ou_x', 'cli_cc'])).toBe(true);
    expect(isOverloadExempt(listed, 'oc_group', ['ou_shawn'])).toBe(true);
    expect(isOverloadExempt(listed, 'oc_group', ['cli_other', 'ou_other'])).toBe(false);
  });
});

describe('isBotOnlyBatch', () => {
  it('applies only when every message comes from a bot', () => {
    const type = (m: { t: 'user' | 'bot' | undefined }) => m.t;
    expect(isBotOnlyBatch([{ t: 'bot' }, { t: 'bot' }], type)).toBe(true);
    expect(isBotOnlyBatch([{ t: 'bot' }, { t: 'user' }], type)).toBe(false);
    expect(isBotOnlyBatch([{ t: undefined }], type)).toBe(false);
    expect(isBotOnlyBatch([], type)).toBe(false);
  });
});

describe('BotOverloadGuard', () => {
  it('reads the quota once per few minutes and sends one card per chat per cooldown', async () => {
    let now = NOW;
    let reads = 0;
    const guard = new BotOverloadGuard({
      profileConfig: () => createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'a', secret: 's', tenant: 'feishu' } } }),
      scratchDir: '/tmp/unused',
      readQuota: async () => {
        reads++;
        return reading([90, 'Oct 20 at 9am (Asia/Shanghai)'], [10, 'Oct 17 at 1am (Asia/Shanghai)']);
      },
      now: () => now,
    });
    expect(await guard.decide(settings, 'oc_other')).toEqual({ overload: false });
    expect(await guard.decide(settings, GROUP)).toMatchObject({ overload: true, card: true });
    now += 60_000;
    expect(await guard.decide(settings, GROUP)).toMatchObject({ overload: true, card: false });
    now += 10 * 60_000;
    expect(await guard.decide(settings, GROUP)).toMatchObject({ overload: true, card: true });
    expect(reads).toBe(2);
  });
});

describe('overloadCard', () => {
  it('shows the gauge, when bots get answered again, and mentions nobody', () => {
    const card = overloadCard({
      windows: [{ label: '本周', usedPercent: 92, limit: 80, resetAt: Date.parse('2026-10-20T01:00:00Z'), resumeAt: Date.parse('2026-10-19T19:00:00Z') }],
      cooldownMinutes: 10,
    });
    const text = JSON.stringify(card);
    expect(text).toContain('算力过载');
    expect(text).toContain('█████████░');
    expect(text).toContain('92%');
    expect(text).toContain('起恢复回答 bot');
    expect(text).toContain('人类同事的消息照常回复');
    expect(text).not.toContain('<at');
    expect(card).toMatchObject({ schema: '2.0', header: { template: 'red' } });
  });
});

describe('bot ↔ owner table', () => {
  const table = resolveBotOverload({
    preferences: {
      botOverload: {
        chats: ['*'],
        botOwners: [
          { name: 'CC', ids: ['cli_cc', 'ou_cc'], owner: 'ou_lishuang', ownerName: '李爽' },
          { name: 'Poki', ids: ['ou_poki'], owner: 'ou_lishuang' },
          { name: 'SAMAI', ids: ['ou_samai'], owner: 'ou_yangshan' },
          { name: 'bad', ids: ['nope'], owner: 'ou_x' },
          { name: 'no owner', ids: ['ou_y'], owner: 'x' },
        ],
      },
    },
  })!;

  it('keeps well-formed entries only', () => {
    expect(table.botOwners.map((entry) => entry.name)).toEqual(['CC', 'Poki', 'SAMAI']);
  });

  it('finds the owners of the asking bots by any of their ids, once each', () => {
    expect(botOwnersOf(table, ['cli_cc', 'ou_poki', 'ou_samai', 'ou_cc'])).toEqual(['ou_lishuang', 'ou_yangshan']);
    expect(botOwnersOf(table, ['ou_unknown'])).toEqual([]);
  });

  it('@s the owners, then a plain @ALL label, and never a bot', () => {
    const text = JSON.stringify(
      overloadCard({ windows: [{ label: '本周', usedPercent: 90, limit: 80 }], cooldownMinutes: 10, owners: ['ou_lishuang', 'ou_yangshan'] }),
    );
    expect(text).toContain('<at id=ou_lishuang></at> <at id=ou_yangshan></at> @ALL');
    expect(text).not.toContain('<at id=all>');
    expect(text).toContain('只 @ bot 的主人，不 @ 任何 bot');
    expect(JSON.stringify(overloadCard({ windows: [], cooldownMinutes: 10 }))).toContain('"content":"@ALL"');
  });
});
