import type { Locale } from './i18n';
import type { RunState } from './run-state';

const HAN = /\p{Script=Han}/u;
const CODE_FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
const LATIN_WORD = /[A-Za-z]{2,}/g;

/**
 * A line of prose with no Chinese in it — code, paths and identifiers aside.
 * Pure code (or a word or two) is not prose and stays visible.
 */
export function isOffLocaleProse(text: string): boolean {
  const prose = text.replace(CODE_FENCE, ' ').replace(INLINE_CODE, ' ');
  if (HAN.test(prose)) return false;
  return (prose.match(LATIN_WORD)?.length ?? 0) >= 2;
}

/**
 * In a Chinese conversation the agent still slips into English for its
 * in-between progress notes ("Now edit the generator…"), however often it is
 * told not to. Hide those on the reply: the running tool's footer already says
 * what is happening, in Chinese. Only the answer the run ends on is always
 * shown — while the run is going, any text may yet turn out to be a progress
 * note, so English text stays hidden until the run is over.
 */
export function withoutOffLocaleProgress(state: RunState, locale: Locale): RunState {
  if (locale !== 'zh') return state;
  const last = state.blocks.length - 1;
  const finished = state.terminal !== 'running';
  const blocks = state.blocks.filter(
    (b, i) => !(b.kind === 'text' && (i < last || !finished) && isOffLocaleProse(b.content)),
  );
  return blocks.length === state.blocks.length ? state : { ...state, blocks };
}
