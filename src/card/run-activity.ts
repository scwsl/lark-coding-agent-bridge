import { hasChinese, runStrings, type Locale } from './i18n';
import type { RunState, ToolEntry } from './run-state';

const LABEL_MAX = 40;

/**
 * Short label for the tool the agent is waiting on, for the running footer.
 *
 * Uses the agent's own one-line `description` (Bash and Agent take one) and
 * never the raw command: commands carry hosts, tokens and passwords, and the
 * footer shows even when tool calls are hidden. Without a description the
 * tool name alone still says which kind of wait this is.
 *
 * The description is shown only when it is in the reply's language: the agent
 * is told to write it in the caller's language but doesn't always, and an
 * English line on a Chinese card is exactly what the caller should not see.
 */
export function runningToolLabel(state: RunState, locale: Locale = 'zh'): string | undefined {
  let latest: ToolEntry | undefined;
  for (const block of state.blocks) {
    if (block.kind === 'tool' && block.tool.status === 'running') latest = block.tool;
  }
  if (!latest) return undefined;
  const t = runStrings(locale);
  const description = toolDescription(latest.input);
  const label =
    description && inLocale(description, locale)
      ? t.toolLabel(description, latest.name)
      : t.toolRunningNamed(latest.name);
  // A subagent working under this tool: say what it is doing right now.
  const sub = state.subagent;
  if (!sub || sub.parentToolUseId !== latest.id) return label;
  const subDescription = sub.description ? oneLine(sub.description) : undefined;
  if (subDescription && inLocale(subDescription, locale)) return t.subagentStep(label, subDescription);
  return sub.tool ? t.subagentStep(label, t.toolRunningNamed(sub.tool)) : label;
}

/** The agent writes descriptions in the caller's language — when it doesn't, hide them. */
function inLocale(text: string, locale: Locale): boolean {
  return locale !== 'zh' || hasChinese(text);
}

function oneLine(raw: string): string | undefined {
  const line = raw.replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX)}…` : line;
}

function toolDescription(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = (input as { description?: unknown }).description;
  if (typeof raw !== 'string') return undefined;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (!oneLine) return undefined;
  return oneLine.length > LABEL_MAX ? `${oneLine.slice(0, LABEL_MAX)}…` : oneLine;
}
