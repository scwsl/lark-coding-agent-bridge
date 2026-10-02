import type { Block, RunState } from './run-state';

/**
 * Feishu rejects a card message past ~30 KB of content (230025 "The length of
 * the message content reaches its limit"), and once a streamed card crosses it
 * every later update fails too — the card freezes mid-run and the answer never
 * lands. Measured as UTF-8 bytes of the card JSON (a CJK character is 3), with
 * headroom for the second JSON encoding the request applies.
 */
export const CARD_BYTE_BUDGET = 24_000;

export interface FittedCard {
  card: object;
  /** Text was cut to fit — the full answer has to go out some other way. */
  trimmed: boolean;
}

const RUNNING_NOTICE = '_（内容较长，卡片里只保留最新部分，完整内容会在结束后另发）_';
const FINAL_NOTICE = '_（内容超出卡片上限，这里只保留结尾，完整内容见下一条消息）_';

export function cardBytes(card: object): number {
  return Buffer.byteLength(JSON.stringify(card), 'utf8');
}

/**
 * Render `state`, shrinking it until the card fits the budget: first drop the
 * reasoning panel and tool blocks, then keep only the tail of the text (the
 * newest output, and for a finished run the conclusion).
 */
export function fitCardToBudget(
  state: RunState,
  render: (state: RunState) => object,
  budget: number = CARD_BYTE_BUDGET,
): FittedCard {
  const full = render(state);
  if (cardBytes(full) <= budget) return { card: full, trimmed: false };

  const textOnly: RunState = {
    ...state,
    reasoning: { content: '', active: false },
    blocks: state.blocks.filter((b) => b.kind === 'text'),
  };
  const lean = render(textOnly);
  if (cardBytes(lean) <= budget) return { card: lean, trimmed: true };

  const text = fullText(state);
  const notice = state.terminal === 'running' ? RUNNING_NOTICE : FINAL_NOTICE;
  const withTail = (keep: number): object => {
    const tail = keep > 0 ? `…${text.slice(text.length - keep)}` : '';
    const block: Block = {
      kind: 'text',
      content: tail ? `${notice}\n\n${tail}` : notice,
      streaming: false,
    };
    return render({ ...textOnly, blocks: [block] });
  };
  // Largest tail that fits, by binary search over its length.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cardBytes(withTail(mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return { card: withTail(lo), trimmed: true };
}

/** Every text block of the run, in order — the answer as the agent wrote it. */
export function fullText(state: RunState): string {
  return state.blocks
    .filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.content.trim())
    .filter(Boolean)
    .join('\n\n');
}
