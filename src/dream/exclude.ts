/**
 * 独立项目拆库: some conversations and topics belong to a project kept in its
 * own private repository (thing-hub, 2026-11-07). Their scopes are never read
 * by 课堂精练, and no note, memory or skill naming them may enter this
 * profile's shared libraries — which other bots can read.
 */

/** `prefix` matches the chat itself and every topic of it (`oc_x`, `oc_x:omt_y`, `oc_x_omt_y`). */
export function excludedScope(scopeId: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => scopeId === prefix || scopeId.startsWith(`${prefix}:`) || scopeId.startsWith(`${prefix}_`),
  );
}

/** The first term `text` contains, case-insensitively; undefined when none. */
export function excludedTerm(text: string, terms: readonly string[]): string | undefined {
  const lower = text.toLowerCase();
  return terms.find((term) => lower.includes(term.toLowerCase()));
}
