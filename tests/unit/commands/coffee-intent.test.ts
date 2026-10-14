import { describe, expect, it } from 'vitest';
import { isPlainCoffeeRequest } from '../../../src/commands/coffee-intent';

const SELF = 'ou_bot_self';

describe('isPlainCoffeeRequest', () => {
  it.each([
    ['来一杯咖啡'],
    ['整杯咖啡'],
    ['给我发杯咖啡'],
    ['要一杯咖啡，谢谢'],
  ])('answers a plain request: %s', (text) => {
    expect(isPlainCoffeeRequest(text, [], SELF)).toBe(true);
  });

  it('still answers when the only mention is this bot', () => {
    expect(isPlainCoffeeRequest('@Occam 来杯咖啡', [{ openId: SELF }], SELF)).toBe(true);
  });

  it('leaves a coffee aimed at someone else to the agent', () => {
    expect(isPlainCoffeeRequest('给 @李爽 发一杯咖啡', [{ openId: 'ou_lishuang' }], SELF)).toBe(false);
    expect(
      isPlainCoffeeRequest('@Occam 给 @欧宇 发杯咖啡', [{ openId: SELF }, { openId: 'ou_ouyu' }], SELF),
    ).toBe(false);
  });

  it('leaves a coffee for another chat to the agent', () => {
    expect(isPlainCoffeeRequest('在 AI-bot军团 群，给大家发一杯咖啡', [], SELF)).toBe(false);
    expect(isPlainCoffeeRequest('在 Talk 群，给 @欧宇 发杯咖啡', [{ openId: 'ou_ouyu' }], SELF)).toBe(false);
  });

  it('treats an unknown self id conservatively', () => {
    expect(isPlainCoffeeRequest('@Occam 来杯咖啡', [{ openId: SELF }], undefined)).toBe(false);
    expect(isPlainCoffeeRequest('来杯咖啡', undefined, undefined)).toBe(true);
  });

  it('ignores messages that merely mention coffee', () => {
    expect(isPlainCoffeeRequest('喝咖啡吗', [], SELF)).toBe(false);
    expect(isPlainCoffeeRequest('咖啡因含量多少', [], SELF)).toBe(false);
  });
});
