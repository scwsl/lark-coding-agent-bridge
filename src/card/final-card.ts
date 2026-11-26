import type { CardHeaderTemplate } from '../config/schema';
import { runStrings, type Locale } from './i18n';
import { deepMaskEmails } from './mask-email';
import { pauseNotice } from './pause-notice';
import { backgroundLeft, type RunState } from './run-state';
import { truncateTitle } from './title-marker';

/**
 * `messageReply: 'final-card'`: the answer as one clean card, sent once when
 * the run is over. Nothing of the run itself is on it — no progress, stop
 * button, tool blocks, reasoning, byline, or the bridge's own notes (account
 * switch, mid-run supplement, a fresh conversation). Pass the final answer
 * only (`finalAnswerState`, then the prefs filter).
 *
 * The answer is just the text, like a chat message, unless it has a title: a
 * header bar then names what the answer is about. The title is the one the
 * agent gave with `[[TITLE: …]]` (`state.title`, see card/title-marker), else
 * the leading `#` heading of a long answer. Nothing else is guessed — the
 * answer's opening line is often whom it addresses (「张三，…」), and the bot's
 * name is already on the message's sender line — so no title, no header bar.
 */

/** A leading heading becomes the title only on answers longer than this many non-blank lines (or with a table). */
export const FINAL_CARD_HEADER_AFTER_LINES = 6;
const SUMMARY_MAX = 60;
const ERROR_MAX = 80;

export interface FinalCardOptions {
  headerTemplate: CardHeaderTemplate;
  /** Image key for the header icon (the bot's avatar). */
  headerIcon?: string;
  /** Model name for the optional grey footer line; none when absent. */
  footerModel?: string;
  locale?: Locale;
}

/** The card, or undefined when there is nothing to show (an empty or `[[NO_REPLY]]` answer). */
export function renderFinalCard(state: RunState, opts: FinalCardOptions): object | undefined {
  let answer = finalCardAnswer(state);
  const status = finalCardStatus(state, opts.locale);
  if (!answer && !status) return undefined;

  let title = answer ? state.title : undefined;
  const heading = answer ? leadingHeading(answer) : undefined;
  if (heading && (title ? heading.title === title : needsHeader(answer))) {
    title = heading.title;
    answer = heading.rest;
  }

  const elements: object[] = [];
  if (answer) elements.push({ tag: 'markdown', content: answer });
  if (status) elements.push(greyLine(status));
  if (opts.footerModel) elements.push(greyLine(opts.footerModel));

  return deepMaskEmails({
    schema: '2.0',
    config: { width_mode: 'fill', summary: { content: summaryOf(title ?? answer, status) } },
    ...(title
      ? {
          header: {
            template: opts.headerTemplate,
            title: { tag: 'plain_text', content: title },
            ...(opts.headerIcon ? { icon: { tag: 'custom_icon', img_key: opts.headerIcon } } : {}),
          },
        }
      : {}),
    body: { elements },
  });
}

/** The same content as plain markdown, for when the card cannot be sent. */
export function finalCardText(state: RunState, locale?: Locale): string {
  return [finalCardAnswer(state), finalCardStatus(state, locale)].filter(Boolean).join('\n\n');
}

/** What the agent wrote: text blocks without the bridge's own notes. */
export function finalCardAnswer(state: RunState): string {
  return state.blocks
    .flatMap((b) => (b.kind === 'text' && !b.note ? [b.content.trim()] : []))
    .filter(Boolean)
    .join('\n\n');
}

/** How the run ended, when that is worth a word: one short line, never a stack of error text. */
export function finalCardStatus(state: RunState, locale?: Locale): string | undefined {
  const t = runStrings(locale);
  switch (state.terminal) {
    case 'interrupted':
      return state.interruptReason === 'recalled' ? t.recalled : t.interrupted;
    case 'idle_timeout':
      return t.idleTimeout(state.idleTimeoutMinutes ?? 0);
    case 'paused':
      return oneLine(pauseNotice(state.limit, locale));
    case 'error':
      return state.errorMsg ? t.agentFailed(truncate(oneLine(state.errorMsg), ERROR_MAX)) : t.summary.error;
    default: {
      const background = backgroundLeft(state);
      return background > 0 ? t.backgroundRunning(background) : undefined;
    }
  }
}

export function needsHeader(answer: string): boolean {
  if (hasTable(answer)) return true;
  return answer.split('\n').filter((line) => line.trim()).length > FINAL_CARD_HEADER_AFTER_LINES;
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/** A markdown table outside code fences: a row of `---` cells under a header row. */
export function hasTable(answer: string): boolean {
  let fenced = false;
  for (const line of answer.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && TABLE_SEPARATOR.test(line)) return true;
  }
  return false;
}

/**
 * The answer's leading `#` / `##` / `###` heading as a header title, and the
 * answer without it. Undefined when the answer opens otherwise, or is nothing
 * but the heading.
 */
export function leadingHeading(answer: string): { title: string; rest: string } | undefined {
  const lines = answer.split('\n');
  const at = lines.findIndex((line) => line.trim());
  const heading = /^\s*#{1,3}\s+(.+?)\s*#*\s*$/.exec(lines[at] ?? '');
  if (!heading?.[1]) return undefined;
  const title = truncateTitle(plain(heading[1]));
  const rest = lines.slice(at + 1).join('\n').trim();
  return title && rest ? { title, rest } : undefined;
}

function greyLine(text: string): object {
  return { tag: 'markdown', content: `<font color='grey'>${text}</font>`, text_size: 'notation' };
}

function summaryOf(text: string, status: string | undefined): string {
  const first = text.split('\n').find((line) => line.trim()) ?? '';
  return truncate(plain(first), SUMMARY_MAX) || plain(status ?? '');
}

/** Markdown marks off, for plain-text spots (header title, chat-list preview). */
function plain(text: string): string {
  return text
    .replace(/^#+\s*/, '')
    .replace(/^\s*[-*>]\s+/, '')
    .replace(/[*_`~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

function oneLine(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
