import { detectLocale, runStrings, type Locale } from './i18n';
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
  const description = toolDescription(latest.input);
  const t = runStrings(locale);
  if (description && (locale !== 'zh' || detectLocale([description]) === 'zh')) {
    return t.toolLabel(description, latest.name);
  }
  return t.toolRunningNamed(latest.name);
}

function toolDescription(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = (input as { description?: unknown }).description;
  if (typeof raw !== 'string') return undefined;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (!oneLine) return undefined;
  return oneLine.length > LABEL_MAX ? `${oneLine.slice(0, LABEL_MAX)}…` : oneLine;
}
