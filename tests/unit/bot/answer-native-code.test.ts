import type { LarkChannel } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { answerMovedState, codeMovedState, deliverCodeNatively, sendFinalReply } from '../../../src/bot/reply-delivery.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce(reduce, initialState);
}

const SQL = "SELECT *\nFROM t\nWHERE note = '$$ $&';";
const SHORT = 'ssh -i ~/.ssh/k.pem alpha@1.2.3.4';
const CODE_ANSWER = `查到了，执行：\n\n\`\`\`sql\n${SQL}\n\`\`\``;
const TABLE_ANSWER = `| 表 | 行数 |\n|---|---|\n| a | 1 |\n\n\`\`\`sql\n${SQL}\n\`\`\``;
const SHORT_TABLE_ANSWER = `| 表 | 行数 |\n|---|---|\n| a | 1 |\n\n\`\`\`\n${SHORT}\n\`\`\``;

/** Tool call, then an answer; finished cleanly unless told otherwise. */
function run(answer: string, end: AgentEvent = { type: 'done', terminationReason: 'normal' }): RunState {
  return stateFrom([
    { type: 'text', delta: '先查一下。' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', id: 't1', output: 'ok', isError: false },
    { type: 'text', delta: answer },
    end,
  ]);
}

function fakeChannel(fail = false): {
  channel: LarkChannel;
  sent: Array<{ content: Record<string, unknown>; opts: unknown }>;
  updated: Array<{ messageId: string; card: object }>;
} {
  const sent: Array<{ content: Record<string, unknown>; opts: unknown }> = [];
  const updated: Array<{ messageId: string; card: object }> = [];
  const channel = {
    send: vi.fn(async (_chatId: string, content: Record<string, unknown>, opts: unknown) => {
      if (fail) throw new Error('send failed');
      sent.push({ content, opts });
      return { messageId: `om_${sent.length}` };
    }),
    updateCard: vi.fn(async (messageId: string, card: object) => {
      updated.push({ messageId, card });
    }),
  } as unknown as LarkChannel;
  return { channel, sent, updated };
}

/** The `md` text of a sent post. */
function postText(content: Record<string, unknown>): string {
  const post = content.post as { zh_cn: { content: Array<Array<{ text: string }>> } };
  return post.zh_cn.content[0]![0]!.text;
}

const base = { chatId: 'oc_x', scope: 'oc_x', sendOpts: { replyTo: 'om_q' }, locale: 'zh' as const };

describe('deliverCodeNatively', () => {
  it('posts an answer holding code, then points the card at it', async () => {
    const { channel, sent } = fakeChannel();
    const updateCard = vi.fn(async (_state: RunState) => {});
    const state = run(CODE_ANSWER);

    await expect(deliverCodeNatively({ ...base, channel, state, updateCard })).resolves.toBe('answer');

    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.content)).toEqual(['post']);
    expect(postText(sent[0]!.content)).toBe(CODE_ANSWER);
    expect(sent[0]!.opts).toEqual({ replyTo: 'om_q' });
    // The card keeps the process and loses only the answer.
    const card = updateCard.mock.calls[0]![0];
    expect(card.blocks.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
    expect(card.blocks[0]).toMatchObject({ content: '先查一下。' });
    expect(JSON.stringify(card.blocks[2])).toContain('答复见下一条消息');
    expect(JSON.stringify(card)).not.toContain('SELECT');
  });

  it('keeps an answer with a table on the card, posts only its code, and points the card at it', async () => {
    const { channel, sent } = fakeChannel();
    const updateCard = vi.fn(async (_state: RunState) => {});

    await expect(deliverCodeNatively({ ...base, channel, state: run(TABLE_ANSWER), updateCard })).resolves.toBe('code');

    expect(sent.map((s) => postText(s.content))).toEqual([`\`\`\`sql\n${SQL}\n\`\`\``]);
    // The card keeps the table but not a second copy of the code.
    const card = JSON.stringify(updateCard.mock.calls[0]![0]);
    expect(card).toContain('| a | 1 |');
    expect(card).toContain('代码见下一条消息');
    expect(card).not.toContain('SELECT');
  });

  it('leaves short one-line code on the card instead of posting it again', async () => {
    const { channel, sent } = fakeChannel();
    const updateCard = vi.fn(async () => {});
    await expect(deliverCodeNatively({ ...base, channel, state: run(SHORT_TABLE_ANSWER), updateCard })).resolves.toBe(
      'none',
    );
    await expect(deliverCodeNatively({ ...base, channel, state: run(`执行：\n\n\`\`\`\n${SHORT}\n\`\`\``) })).resolves.toBe(
      'none',
    );
    expect(sent).toEqual([]);
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('still moves short code out with the whole answer when the answer has no table', async () => {
    const { channel, sent } = fakeChannel();
    const updateCard = vi.fn(async () => {});
    const answer = `执行：\n\n\`\`\`\n${SHORT}\n\`\`\``;
    await expect(deliverCodeNatively({ ...base, channel, state: run(answer), updateCard })).resolves.toBe('answer');
    expect(sent.map((s) => postText(s.content))).toEqual([answer]);
  });

  it('posts only the code when there is no card to point from', async () => {
    const { channel, sent } = fakeChannel();
    await expect(deliverCodeNatively({ ...base, channel, state: run(CODE_ANSWER) })).resolves.toBe('code');
    expect(sent.map((s) => postText(s.content))).toEqual([`\`\`\`sql\n${SQL}\n\`\`\``]);
  });

  it('sends nothing for an answer without code, or a run that did not finish cleanly', async () => {
    const { channel, sent } = fakeChannel();
    const updateCard = vi.fn(async () => {});
    await expect(deliverCodeNatively({ ...base, channel, state: run('没有代码'), updateCard })).resolves.toBe('none');
    const failed = run(CODE_ANSWER, { type: 'error', message: 'boom', terminationReason: 'failed' });
    await expect(deliverCodeNatively({ ...base, channel, state: failed, updateCard })).resolves.toBe('none');
    // Code in an earlier note is not the answer.
    const toolLast = stateFrom([
      { type: 'text', delta: CODE_ANSWER },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);
    await expect(deliverCodeNatively({ ...base, channel, state: toolLast, updateCard })).resolves.toBe('none');
    expect(sent).toEqual([]);
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('leaves the card alone when the post cannot be sent', async () => {
    const { channel } = fakeChannel(true);
    const updateCard = vi.fn(async () => {});
    await expect(deliverCodeNatively({ ...base, channel, state: run(CODE_ANSWER), updateCard })).resolves.toBe('none');
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('still counts the answer as delivered when only the pointer update fails', async () => {
    const { channel, sent } = fakeChannel();
    const updateCard = vi.fn(async () => {
      throw new Error('patch failed');
    });
    await expect(deliverCodeNatively({ ...base, channel, state: run(CODE_ANSWER), updateCard })).resolves.toBe('answer');
    expect(sent).toHaveLength(1);
  });
});

describe('codeMovedState', () => {
  it('replaces only the code blocks of the answer, keeping earlier notes and the rest of the text', () => {
    const state = stateFrom([
      { type: 'text', delta: `先看：\n\n\`\`\`\nls\n\`\`\`` },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
      { type: 'text', delta: `${TABLE_ANSWER}\n\n收尾一句。` },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const moved = codeMovedState(state, 'en');
    expect(moved.blocks[0]).toMatchObject({ content: state.blocks[0]!.kind === 'text' ? state.blocks[0]!.content : '' });
    const last = moved.blocks.at(-1)!;
    expect(last.kind).toBe('text');
    const text = last.kind === 'text' ? last.content : '';
    expect(text).toBe(`| 表 | 行数 |\n|---|---|\n| a | 1 |\n\n${'👇 _The code is in the next message, ready to copy in one click._'}\n\n收尾一句。`);
  });
});

describe('answerMovedState', () => {
  it('replaces every trailing answer block with one English pointer line', () => {
    const moved = answerMovedState(run(CODE_ANSWER), 'en');
    expect(moved.blocks.at(-1)).toMatchObject({ kind: 'text', streaming: false });
    expect(JSON.stringify(moved.blocks.at(-1))).toContain('next message');
  });
});

describe('sendFinalReply in card mode', () => {
  const finalState = (answer: string): RunState => ({
    ...initialState,
    blocks: [{ kind: 'text', content: answer, streaming: false }],
    finalText: answer,
    terminal: 'done',
  });
  const send = (channel: LarkChannel, state: RunState) =>
    sendFinalReply({
      channel,
      chatId: 'oc_x',
      scope: 'oc_x',
      state,
      replyMode: 'card',
      sendOpts: { replyTo: 'om_q' },
      cardRenderOptions: {},
    });

  it('sends an answer holding code as a post instead of a card', async () => {
    const { channel, sent } = fakeChannel();
    await send(channel, finalState(CODE_ANSWER));
    expect(sent.map((s) => Object.keys(s.content))).toEqual([['post']]);
    expect(postText(sent[0]!.content)).toBe(CODE_ANSWER);
  });

  it('sends a card, then the code, when the answer has a table, and points the card at it', async () => {
    const { channel, sent, updated } = fakeChannel();
    await send(channel, finalState(TABLE_ANSWER));
    expect(sent.map((s) => Object.keys(s.content)[0])).toEqual(['card', 'post']);
    expect(postText(sent[1]!.content)).toBe(`\`\`\`sql\n${SQL}\n\`\`\``);
    expect(sent[1]!.opts).toEqual({ replyTo: 'om_q' });
    expect(updated.map((u) => u.messageId)).toEqual(['om_1']);
    expect(JSON.stringify(updated[0]!.card)).not.toContain('SELECT');
    expect(JSON.stringify(updated[0]!.card)).toContain('代码见下一条消息');
  });

  it('sends just the card when the answer has a table and only short code', async () => {
    const { channel, sent, updated } = fakeChannel();
    await send(channel, finalState(SHORT_TABLE_ANSWER));
    expect(sent.map((s) => Object.keys(s.content)[0])).toEqual(['card']);
    expect(updated).toEqual([]);
  });

  it('sends just the card for an answer without code', async () => {
    const { channel, sent } = fakeChannel();
    await send(channel, finalState('没有代码'));
    expect(sent.map((s) => Object.keys(s.content)[0])).toEqual(['card']);
  });
});
