import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/** One fenced code block found in an answer. */
export interface CodeBlock {
  /** Info string after the opening fence, e.g. `sql`; empty when none. */
  lang: string;
  code: string;
}

/**
 * Fenced code blocks (``` or ~~~) in `markdown`, in order. An unclosed fence
 * (a streaming answer cut mid-block) is ignored, and so is an empty block.
 */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let open: { char: string; len: number; lang: string; body: string[] } | null = null;
  for (const line of markdown.split('\n')) {
    if (!open) {
      const m = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
      if (m) open = { char: m[1]![0]!, len: m[1]!.length, lang: m[2] ?? '', body: [] };
      continue;
    }
    const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
    if (close && close[1]![0] === open.char && close[1]!.length >= open.len) {
      const code = open.body.join('\n');
      if (code.trim()) blocks.push({ lang: open.lang, code });
      open = null;
      continue;
    }
    open.body.push(line);
  }
  return blocks;
}

/** Short, stable key for a snippet: the same code always gets the same key. */
export function snippetKey(code: string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 16);
}

/**
 * Code blocks from finished answers, kept so the card's 「复制代码」 button
 * can carry just a key: putting the code itself on the button would double
 * the card's size against Feishu's 30 KB limit. Oldest entries go first once
 * the store holds {@link cap} of them; on disk so a restart keeps old cards
 * working.
 */
export class CodeSnippetStore {
  private readonly snippets = new Map<string, string>();
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly cap = 500,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return;
      this.snippets.clear();
      for (const [key, code] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof code === 'string') this.snippets.set(key, code);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.fail('code-snippets', err, { step: 'load' });
    }
  }

  /** Remember `code` and return its key. Re-putting known code only refreshes its age. */
  put(code: string): string {
    const key = snippetKey(code);
    const known = this.snippets.get(key) === code;
    this.snippets.delete(key);
    this.snippets.set(key, code);
    while (this.snippets.size > this.cap) {
      const oldest = this.snippets.keys().next().value;
      if (oldest === undefined) break;
      this.snippets.delete(oldest);
    }
    // A card re-renders many times while it fits itself to the size budget;
    // only new code is worth a write.
    if (!known) this.schedulePersist();
    return key;
  }

  get(key: string): string | undefined {
    return this.snippets.get(key);
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(
          this.path,
          `${JSON.stringify(Object.fromEntries(this.snippets))}\n`,
          { mode: 0o600 },
        );
      })
      .catch((err: unknown) => {
        log.fail('code-snippets', err, { step: 'persist' });
      });
  }
}
