import { maskEmails } from './mask-email';

/**
 * An answer as Feishu rich-text (post) messages. A fence inside a post's `md`
 * element becomes a native code block with a copy icon that copies it whole;
 * a card's code block has none, and a card can't write the clipboard. So
 * code meant to be copied goes out as posts.
 *
 * Built here rather than through the SDK's `markdown` send: its converter
 * puts code blocks back with `String.replace`, which reads `$$`, `$&` and
 * `$'` in the code as replacement patterns, and collapses blank lines inside
 * code blocks too.
 */

/**
 * Feishu takes a post request body of at most 30 KB; each message is kept
 * under this many bytes of body, leaving room for the fields not counted.
 */
export const POST_BODY_BUDGET = 28_000;

interface Unit {
  kind: 'code' | 'text';
  /** What goes into the `md` element: a whole fenced block, or a paragraph. */
  text: string;
  /** For code: the fence to re-wrap pieces with when one block outgrows a message. */
  fence?: { open: string; close: string; body: string };
}

/** The post holding `text` as one `md` element. */
export function postOf(text: string): object {
  return { zh_cn: { title: '', content: [[{ tag: 'md', text }]] } };
}

/**
 * Whether `markdown` holds a pipe table outside its code blocks: a line with
 * a `|` followed by a delimiter row such as `|---|:--:|`. A post can't draw
 * tables, so such an answer stays on the card.
 */
export function hasMarkdownTable(markdown: string): boolean {
  for (const unit of units(markdown)) {
    if (unit.kind === 'code') continue;
    const lines = unit.text.split('\n');
    if (lines.some((line, i) => i > 0 && lines[i - 1]!.includes('|') && isDelimiterRow(line))) return true;
  }
  return false;
}

/** Whether `markdown` holds a closed, non-empty fenced code block. */
export function hasCodeBlock(markdown: string): boolean {
  return units(markdown).some((u) => u.kind === 'code' && u.fence!.body.trim() !== '');
}

/**
 * Longest one-line code block (in characters) short enough to stay on the
 * card: selecting one line by hand is no harder than tapping a copy icon, and
 * posting it again below only shows the same command twice.
 */
export const SHORT_CODE_MAX = 120;

/** Whether every non-empty code block of `markdown` is one line of at most {@link SHORT_CODE_MAX} characters. */
export function codeBlocksAllShort(markdown: string): boolean {
  const code = units(markdown).filter((u) => u.kind === 'code' && u.fence!.body.trim() !== '');
  return (
    code.length > 0 &&
    code.every((u) => {
      const body = u.fence!.body.trim();
      return !body.includes('\n') && [...body].length <= SHORT_CODE_MAX;
    })
  );
}

/**
 * `markdown` with each closed, non-empty fenced code block (the ones
 * {@link codeOnlyPosts} sends) replaced by the line `placeholder`; everything
 * else is left exactly as it was.
 */
export function replaceCodeBlocks(markdown: string, placeholder: string): string {
  const out: string[] = [];
  let open: { char: string; len: number; raw: string[]; body: string[] } | null = null;
  for (const line of markdown.split('\n')) {
    if (!open) {
      const m = OPEN_FENCE.exec(line);
      if (m) open = { char: m[2]![0]!, len: m[2]!.length, raw: [line], body: [] };
      else out.push(line);
      continue;
    }
    open.raw.push(line);
    const close = CLOSE_FENCE.exec(line);
    if (close && close[1]![0] === open.char && close[1]!.length >= open.len) {
      out.push(...(open.body.join('\n').trim() === '' ? open.raw : [placeholder]));
      open = null;
      continue;
    }
    open.body.push(line);
  }
  if (open) out.push(...open.raw);
  return out.join('\n');
}

const OPEN_FENCE = /^( *)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const CLOSE_FENCE = /^\s*(`{3,}|~{3,})\s*$/;

function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  return t.includes('|') && /-{3,}/.test(t) && /^[|:\-\s]+$/.test(t);
}

/**
 * `markdown` as one or more posts, in order: emails masked (see
 * mask-email.ts), oversized headings demoted outside code, code blocks kept
 * verbatim. Split between paragraphs and code blocks so no message outgrows
 * {@link POST_BODY_BUDGET}; a block too big for one message is cut between
 * lines, each piece fenced again.
 */
export function answerPosts(markdown: string, budget = POST_BODY_BUDGET): object[] {
  return pack(styled(units(maskEmails(markdown))), budget).map(postOf);
}

/** Only the code blocks of `markdown`, as posts (see {@link answerPosts}). */
export function codeOnlyPosts(markdown: string, budget = POST_BODY_BUDGET): object[] {
  return pack(
    units(maskEmails(markdown)).filter((u) => u.kind === 'code' && u.fence!.body.trim() !== ''),
    budget,
  ).map(postOf);
}

/**
 * Fenced code blocks (``` or ~~~) and paragraphs, in order. A block is
 * re-fenced with backticks at the left margin (a post's renderer may not know
 * `~~~` or an indented fence), its indentation and language kept. An
 * unclosed fence stays text.
 */
function units(markdown: string): Unit[] {
  const out: Unit[] = [];
  let para: string[] = [];
  const endPara = (): void => {
    const text = para.join('\n').replace(/^\n+|\n+$/g, '');
    if (text.trim()) out.push({ kind: 'text', text });
    para = [];
  };
  let open: { char: string; len: number; indent: number; lang: string; raw: string[]; body: string[] } | null = null;
  for (const line of markdown.split('\n')) {
    if (!open) {
      const m = OPEN_FENCE.exec(line);
      if (m) {
        endPara();
        open = { char: m[2]![0]!, len: m[2]!.length, indent: m[1]!.length, lang: m[3] ?? '', raw: [line], body: [] };
      } else if (line.trim() === '') {
        endPara();
      } else {
        para.push(line);
      }
      continue;
    }
    open.raw.push(line);
    const close = CLOSE_FENCE.exec(line);
    if (close && close[1]![0] === open.char && close[1]!.length >= open.len) {
      const indent = open.indent;
      const body = open.body.map((l) => l.replace(new RegExp(`^ {0,${indent}}`), '')).join('\n');
      out.push(codeUnit(body, open.lang));
      open = null;
      continue;
    }
    open.body.push(line);
  }
  if (open) para.push(...open.raw);
  endPara();
  return out;
}

function codeUnit(body: string, lang: string): Unit {
  // A fence must be longer than any backtick run opening a line of the body.
  const longest = Math.max(2, ...[...body.matchAll(/^\s*(`{3,})/gm)].map((m) => m[1]!.length));
  const ticks = '`'.repeat(longest + 1);
  const open = `${ticks}${/^[\w+#.-]{1,30}$/.test(lang) ? lang : ''}`;
  return { kind: 'code', text: `${open}\n${body}\n${ticks}`, fence: { open, close: ticks, body } };
}

/**
 * Headings demoted the way the SDK's own converter does (a post draws `#` far
 * too large), only outside code.
 */
function styled(list: Unit[]): Unit[] {
  const big = list.some((u) => u.kind === 'text' && /^#{1,3} /m.test(u.text));
  if (!big) return list;
  return list.map((u) =>
    u.kind === 'text'
      ? { ...u, text: u.text.replace(/^#{2,6} /gm, () => '##### ').replace(/^# /gm, () => '#### ') }
      : u,
  );
}

/** Bytes `s` adds to a post's request body: JSON-escaped twice (post JSON, then the body). */
function cost(s: string): number {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(s))) - 6;
}

const ENVELOPE = Buffer.byteLength(
  JSON.stringify({ receive_id: `oc_${'0'.repeat(32)}`, msg_type: 'post', content: JSON.stringify(postOf('')) }),
);
const JOIN = '\n\n';

/** Units joined into as few message texts as fit the budget. */
function pack(list: Unit[], budget: number): string[] {
  const room = Math.max(1, budget - ENVELOPE);
  const pieces = list.flatMap((u) => (cost(u.text) <= room ? [u.text] : split(u, room)));
  const out: string[] = [];
  let cur = '';
  let used = 0;
  for (const piece of pieces) {
    const add = cost(piece) + (cur ? cost(JOIN) : 0);
    if (cur && used + add > room) {
      out.push(cur);
      cur = '';
      used = 0;
    }
    used += cost(piece) + (cur ? cost(JOIN) : 0);
    cur = cur ? `${cur}${JOIN}${piece}` : piece;
  }
  if (cur) out.push(cur);
  return out;
}

/** A unit too big for one message, cut between lines (and inside a line as a last resort). */
function split(unit: Unit, room: number): string[] {
  const wrap = unit.fence ? (body: string) => `${unit.fence!.open}\n${body}\n${unit.fence!.close}` : (s: string) => s;
  const lineRoom = room - (unit.fence ? cost(wrap('')) : 0);
  const lines = (unit.fence ? unit.fence.body : unit.text)
    .split('\n')
    .flatMap((line) => (cost(line) <= lineRoom ? [line] : chop(line, lineRoom)));
  const out: string[] = [];
  let cur: string[] = [];
  let used = 0;
  for (const line of lines) {
    const add = cost(line) + (cur.length ? cost('\n') : 0);
    if (cur.length && used + add > lineRoom) {
      out.push(wrap(cur.join('\n')));
      cur = [];
      used = 0;
    }
    used += cost(line) + (cur.length ? cost('\n') : 0);
    cur.push(line);
  }
  if (cur.length) out.push(wrap(cur.join('\n')));
  return out;
}

/** A single line longer than a message, in pieces that each fit. */
function chop(line: string, room: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (cur && cost(cur + ch) > room) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
