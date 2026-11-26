import { describe, expect, it } from 'vitest';
import {
  answerPosts,
  codeBlocksAllShort,
  codeOnlyPosts,
  hasCodeBlock,
  hasMarkdownTable,
  POST_BODY_BUDGET,
  postOf,
  replaceCodeBlocks,
  SHORT_CODE_MAX,
} from '../../../src/card/answer-post.js';

/** The `md` text of each post. */
function texts(posts: object[]): string[] {
  return posts.map((p) => {
    const body = (p as { zh_cn: { title: string; content: Array<Array<{ tag: string; text: string }>> } }).zh_cn;
    expect(body.title).toBe('');
    expect(body.content).toHaveLength(1);
    expect(body.content[0]).toHaveLength(1);
    expect(body.content[0]![0]!.tag).toBe('md');
    return body.content[0]![0]!.text;
  });
}

/** Request body bytes of a post, as the SDK sends it. */
function bodyBytes(post: object): number {
  return Buffer.byteLength(
    JSON.stringify({ receive_id: `oc_${'0'.repeat(32)}`, msg_type: 'post', content: JSON.stringify(post) }),
  );
}

describe('answerPosts', () => {
  it('keeps code verbatim — replacement patterns, blank lines and all', () => {
    const code = "SELECT '$$ $& $` $\\' x' AS b;\n\n\n\n-- end";
    expect(texts(answerPosts(`结论：\n\n\`\`\`sql\n${code}\n\`\`\``))).toEqual([`结论：\n\n\`\`\`sql\n${code}\n\`\`\``]);
  });

  it('masks emails in text and code alike', () => {
    const [text] = texts(answerPosts('发给 a.b@example.com：\n```sql\nWHERE u = \'c@example.com\'\n```'));
    expect(text).not.toMatch(/@example\.com/);
    expect(text).toContain('a.b[at]example.com');
    expect(text).toContain("WHERE u = 'c[at]example.com'");
  });

  it('demotes big headings outside code only, and squeezes runs of blank lines in text', () => {
    const md = '# 标题\n\n\n\n## 小节\n\n```bash\n# 注释\n\n\n\necho hi\n```';
    expect(texts(answerPosts(md))).toEqual(['#### 标题\n\n##### 小节\n\n```bash\n# 注释\n\n\n\necho hi\n```']);
  });

  it('re-fences tilde and indented blocks with backticks at the margin', () => {
    expect(texts(answerPosts('1. 先执行：\n   ~~~sql\n   SELECT 1;\n     -- 缩进保留\n   ~~~\n2. 再看结果'))).toEqual([
      '1. 先执行：\n\n```sql\nSELECT 1;\n  -- 缩进保留\n```\n\n2. 再看结果',
    ]);
  });

  it('uses a longer fence when the code itself holds one', () => {
    const [text] = texts(answerPosts('````md\n```js\nx()\n```\n````'));
    expect(text).toBe('````md\n```js\nx()\n```\n````');
  });

  it('leaves an unclosed fence as text', () => {
    expect(texts(answerPosts('看这里\n```sql\nSELECT 1'))).toEqual(['看这里\n\n```sql\nSELECT 1']);
  });

  it('splits between paragraphs and blocks to fit, cutting an oversized block between lines', () => {
    const big = Array.from({ length: 400 }, (_, i) => `INSERT INTO t VALUES (${i}, '中文内容 "quoted" \\ ${i}');`).join('\n');
    const md = `开头说明\n\n\`\`\`sql\n${big}\n\`\`\`\n\n结尾说明`;
    const budget = 6_000;
    const posts = answerPosts(md, budget);
    expect(posts.length).toBeGreaterThan(2);
    for (const post of posts) expect(bodyBytes(post)).toBeLessThanOrEqual(budget);
    const all = texts(posts);
    expect(all[0]!.startsWith('开头说明')).toBe(true);
    expect(all.at(-1)!.endsWith('结尾说明')).toBe(true);
    // Every piece of the block is a block of its own, and together they are the whole code.
    const pieces = all.join('\n\n').match(/```sql\n[\s\S]*?\n```/g)!;
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map((p) => p.slice('```sql\n'.length, -'\n```'.length)).join('\n')).toBe(big);
  });

  it('fits a whole normal answer in one message', () => {
    const posts = answerPosts('短答复\n\n```sql\nSELECT 1;\n```');
    expect(posts).toHaveLength(1);
    expect(bodyBytes(posts[0]!)).toBeLessThan(POST_BODY_BUDGET);
  });
});

describe('codeOnlyPosts', () => {
  it('keeps just the code blocks, skipping empty ones', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\n```sql\nSELECT 1;\n```\n\n```\n\n```\n\n~~~bash\nls\n~~~';
    expect(texts(codeOnlyPosts(md))).toEqual(['```sql\nSELECT 1;\n```\n\n```bash\nls\n```']);
  });
});

describe('hasMarkdownTable / hasCodeBlock', () => {
  it('spots a pipe table outside code, not a rule or a table inside a block', () => {
    expect(hasMarkdownTable('| a | b |\n|---|:--:|\n| 1 | 2 |')).toBe(true);
    expect(hasMarkdownTable('a | b\n--- | ---\n1 | 2')).toBe(true);
    expect(hasMarkdownTable('上文\n\n---\n\n下文')).toBe(false);
    expect(hasMarkdownTable('```\n| a | b |\n|---|---|\n```')).toBe(false);
    expect(hasMarkdownTable('a | b\n\n|---|---|')).toBe(false);
  });

  it('counts closed, non-empty blocks only', () => {
    expect(hasCodeBlock('x\n```sql\nSELECT 1;\n```')).toBe(true);
    expect(hasCodeBlock('```sql\nSELECT 1;')).toBe(false);
    expect(hasCodeBlock('```\n\n```')).toBe(false);
    expect(hasCodeBlock('用 ```inline``` 写')).toBe(false);
    expect(hasCodeBlock('没有代码')).toBe(false);
  });
});

describe('codeBlocksAllShort', () => {
  const fence = (body: string, lang = '') => `\`\`\`${lang}\n${body}\n\`\`\``;
  it('is true only when every non-empty block is one line within the limit', () => {
    expect(codeBlocksAllShort(`跑：\n\n${fence('ssh -i k.pem alpha@1.2.3.4', 'bash')}`)).toBe(true);
    expect(codeBlocksAllShort(`${fence('ls')}\n\n${fence('pwd')}\n\n${fence('  ')}`)).toBe(true);
    expect(codeBlocksAllShort(fence('x'.repeat(SHORT_CODE_MAX)))).toBe(true);
    expect(codeBlocksAllShort(fence('中'.repeat(SHORT_CODE_MAX)))).toBe(true);
    expect(codeBlocksAllShort(fence('x'.repeat(SHORT_CODE_MAX + 1)))).toBe(false);
    expect(codeBlocksAllShort(fence('ls\npwd'))).toBe(false);
    expect(codeBlocksAllShort(`${fence('ls')}\n\n${fence('a\nb')}`)).toBe(false);
    expect(codeBlocksAllShort('没有代码')).toBe(false);
  });
});

describe('replaceCodeBlocks', () => {
  it('swaps closed non-empty blocks for the placeholder and keeps everything else verbatim', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\n  ~~~sql\n  SELECT 1;\n\n  ~~~\n中间\n```\n\n```\n````md\n```\ninner\n```\n````\n```\nunclosed';
    expect(replaceCodeBlocks(md, 'P')).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n\nP\n中间\n```\n\n```\nP\n```\nunclosed');
  });

  it('leaves text without code unchanged', () => {
    expect(replaceCodeBlocks('a\n\nb', 'P')).toBe('a\n\nb');
  });
});

describe('postOf', () => {
  it('is one md element with no title', () => {
    expect(postOf('x')).toEqual({ zh_cn: { title: '', content: [[{ tag: 'md', text: 'x' }]] } });
  });
});
