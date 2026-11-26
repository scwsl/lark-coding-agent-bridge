/**
 * `[[TITLE: 主题]]` — the header title the agent gives its answer in
 * `messageReply: 'final-card'` (see {@link FINAL_CARD_TITLE_INSTRUCTION}).
 * The bridge strips the line in every reply mode and the final card shows it
 * in its header bar; an answer without one gets no header bar.
 *
 * The agent names the topic itself because the answer's own opening says
 * nothing reliable about it: a group reply that opens with whom it addresses
 * (「张三，…」) would put a person's name in the header.
 */

/** One character of a title: anything but a line break, and a `]` only when it does not start the closing `]]`. */
const TITLE_CHAR = String.raw`(?:[^\]\n]|\](?!\](?!\])))`;
/** `[[TITLE: 主题]]` anywhere in the answer (normally its first line). */
const TITLE_MARKER = new RegExp(String.raw`[ \t]*\[\[TITLE[:：]\s*(${TITLE_CHAR}*?)\s*\]\](?!\])[ \t]*\n?`, 'g');
/** A marker still arriving at the end of a stream: `[[`, `[[TIT`, `[[TITLE: 验证`… */
const TITLE_PARTIAL = new RegExp(String.raw`\s*\[\[(?:T(?:I(?:T(?:L(?:E(?:[:：]${TITLE_CHAR}*\]?)?)?)?)?)?)?$`);

/** Hard cap on a title; the instruction asks for 16 characters, this only stops a runaway one. */
export const TITLE_MAX = 24;

/** The agent's title in `text`, if it wrote one (the last one wins). */
export function titleOf(text: string | undefined): string | undefined {
  if (!text?.includes('[[TITLE')) return undefined;
  let found: string | undefined;
  for (const m of text.matchAll(TITLE_MARKER)) {
    const title = cleanTitle(m[1] ?? '');
    if (title) found = title;
  }
  return found;
}

/** `text` without its title markers — complete, or still streaming in when `streaming`. */
export function stripTitleMarker(text: string, streaming = false): string {
  const done = text.includes('[[TITLE') ? text.replace(TITLE_MARKER, '') : text;
  if (!streaming) return done;
  const m = TITLE_PARTIAL.exec(done);
  return m ? done.slice(0, m.index) : done;
}

/** One plain line: no markdown marks, wrapping quotes or closing punctuation; cut at {@link TITLE_MAX}. */
export function cleanTitle(raw: string): string {
  let title = raw
    .replace(/\s+/g, ' ')
    .replace(/[*_`~#]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
  const quoted = /^(?:「(.*)」|『(.*)』|“(.*)”|"(.*)"|《(.*)》)$/.exec(title);
  if (quoted) title = (quoted.slice(1).find((s) => s !== undefined) ?? '').trim();
  title = title.replace(/[。．.，,；;：:！!？?、]+$/, '').trim();
  return truncateTitle(title);
}

/** Cut to {@link TITLE_MAX}, backing off to a word boundary rather than splitting a Latin word. */
export function truncateTitle(text: string): string {
  if (text.length <= TITLE_MAX) return text;
  const word = /[A-Za-z0-9_-]/;
  let cut = TITLE_MAX - 1;
  while (cut > TITLE_MAX / 2 && word.test(text[cut - 1] ?? '') && word.test(text[cut] ?? '')) cut--;
  return `${text.slice(0, cut).trimEnd()}…`;
}

/**
 * Run instruction for `messageReply: 'final-card'`: when and how to title the
 * answer. Only long or self-contained answers get a title, so a chat-like
 * reply stays a plain message without a header bar.
 */
export const FINAL_CARD_TITLE_INSTRUCTION =
  '这轮回复会以一张卡片发出，卡片顶部的标题栏只在你给了标题时出现。' +
  '回复是能单独拿出来看的内容（有表格、清单、对比、排查结论汇总），或者超过 6 行时，' +
  '在最终回复（做完工具调用之后写给用户的那段）的第一行单独写 `[[TITLE: 主题]]`。' +
  '主题写这条回复讲的是什么事：名词短语，不超过 16 个字，例如「kick-off 验证范围」「三个生产区 Pod 与发布对比」；' +
  '不写人名和称呼，不写「回复」「结果」「分析」这类空词，不用标点和 emoji，也不要重复正文第一句的结论。' +
  '普通对话、短回答、只是交代下一步的回复不写。' +
  '这一行 bridge 会去掉，它不是正文里的小标题，不要在正文里提到它；正文照常写。';
