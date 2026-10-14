// Natural-language phrasing for the `/coffee` easter egg — "来一杯咖啡",
// "整杯咖啡", "给我发杯咖啡" — so the card isn't gated behind knowing the exact
// slash command. Deliberately narrow (verb + 杯咖啡) to avoid firing on
// unrelated chat that merely mentions coffee (e.g. "喝咖啡", "咖啡因").
const COFFEE_NL_INTENT_RE = /(给\S{0,12})?(发|来|整|要)(一)?杯咖啡/;

/** Mentions a group or chat by name, e.g. "在 AI-bot军团 群". */
const NAMES_A_CHAT_RE = /群/;

export interface CoffeeMention {
  openId?: string;
}

/**
 * Whether the easter egg should answer this message with a card in the same
 * chat. Only a plain coffee request qualifies: once the message aims the
 * coffee elsewhere — @-mentions anyone but this bot, or names a group — it is
 * a task ("在 X 群给 @Y 发杯咖啡") for the agent, not something to swallow here.
 */
export function isPlainCoffeeRequest(
  text: string,
  mentions: readonly CoffeeMention[] | undefined,
  selfOpenId: string | undefined,
): boolean {
  if (!COFFEE_NL_INTENT_RE.test(text)) return false;
  const others = (mentions ?? []).filter((m) => !(selfOpenId && m.openId === selfOpenId));
  if (others.length > 0) return false;
  return !NAMES_A_CHAT_RE.test(text);
}
