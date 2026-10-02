import { maskEmails } from './mask-email';
import { runStrings, type Locale, type RunStrings } from './i18n';
import { pauseNotice } from './pause-notice';
import type { Block, RunState, ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'text'`
 * mode where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Tool calls collapse to a single short line each (no body)
 *   - No reasoning / thinking output (no place to fold it; would be noise)
 *   - Footer is appended inline at the bottom while running
 */
export function renderText(state: RunState, locale?: Locale): string {
  const t = runStrings(locale);
  const parts: string[] = [];

  for (const block of state.blocks) {
    const piece = renderBlock(block);
    if (piece) parts.push(piece);
  }

  if (state.terminal === 'interrupted') {
    parts.push(t.interrupted);
  } else if (state.terminal === 'idle_timeout') {
    parts.push(t.idleTimeout(state.idleTimeoutMinutes ?? 0));
  } else if (state.terminal === 'paused') {
    parts.push(pauseNotice(state.limit, locale));
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(t.agentFailed(state.errorMsg));
  } else if (state.terminal === 'running' && state.footer) {
    parts.push(footerLine(state.footer, t));
  }

  // Strip raw emails so the Feishu tenant audit doesn't reject the message
  // (see mask-email.ts). Never removes content, so emptiness checks upstream
  // still behave.
  return maskEmails(parts.join('\n\n'));
}

function renderBlock(block: Block): string {
  if (block.kind === 'text') {
    return block.content.trim();
  }
  return toolLine(block.tool);
}

/**
 * One-line summary for a tool call:
 *   `> ⏳ **Bash** — git status`
 *   `> ✅ **Read** — ~/code/foo.ts`
 * Reuses `toolHeaderText` so the format matches the card mode header.
 */
function toolLine(tool: ToolEntry): string {
  return `> ${toolHeaderText(tool)}`;
}

function footerLine(status: 'thinking' | 'tool_running' | 'streaming', t: RunStrings): string {
  if (status === 'thinking') return `_${t.thinking}…_`;
  if (status === 'tool_running') return `_${t.toolRunning}…_`;
  return `_${t.streaming}…_`;
}
