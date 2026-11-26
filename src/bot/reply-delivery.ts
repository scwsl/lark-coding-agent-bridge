import type { LarkChannel } from '@larksuite/channel';
import { LarkChannelError } from '@larksuite/channel';
import { answerPosts, codeOnlyPosts, hasCodeBlock, hasMarkdownTable } from '../card/answer-post';
import { CARD_BYTE_BUDGET, cardBytes, fullText } from '../card/card-budget';
import { finalCardText, renderFinalCard } from '../card/final-card';
import { runStrings, type Locale } from '../card/i18n';
import { runningToolLabel } from '../card/run-activity';
import { renderCard } from '../card/run-renderer';
import type { RunActivity, RunCardRenderOptions } from '../card/run-renderer';
import { backgroundLeft, type Block, type RunState } from '../card/run-state';
import { renderText } from '../card/text-renderer';
import type { getMessageReplyMode, ResolvedFinalCard } from '../config/schema';
import { log } from '../core/logger';
import type { RunHandle } from '../runtime/active-runs';
import { larkErrorCode } from './card-patch-health';
import { finalAnswerOnlyState } from './cot';
import { removeReaction } from './reaction';

/*
 * Getting a run's reply on screen: the lazily opened progress stream, the
 * final reply, the fallbacks and rescues when a stream or card fails, and the
 * cleanup of empty messages and the working reaction. Moved out of
 * channel.ts unchanged; `runAgentBatch` there still decides which of these a
 * run uses.
 */

const STREAM_TERMINAL_GRACE_MS = 3000;
const REACTION_CLEANUP_GRACE_MS = 1000;

/** How often a running card re-renders its clock when nothing else changes. */
export const CARD_HEARTBEAT_MS = 15_000;

export function runActivity(handle: RunHandle, state: RunState, locale: Locale): RunActivity {
  const now = Date.now();
  const toolLabel = runningToolLabel(state, locale);
  return {
    elapsedMs: now - handle.startedAt,
    idleMs: now - handle.lastActivityAt,
    ...(toolLabel ? { toolLabel } : {}),
  };
}

/** The finished card, reduced to a pointer at the message that carries the answer. */
export function pointerState(state: RunState, code: number | undefined, locale: Locale): RunState {
  return {
    ...state,
    reasoning: { content: '', active: false },
    footer: null,
    blocks: [
      {
        kind: 'text',
        content: runStrings(locale).pointer(String(code ?? '?')),
        streaming: false,
      },
    ],
  };
}

export async function deliverAnswerOutsideCard(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  reason: 'card-broken' | 'too-long';
  state: RunState;
  messageId?: string;
  pointerCard?: object;
}): Promise<void> {
  const { channel, chatId, scope, reason } = input;
  if (input.messageId && input.pointerCard) {
    try {
      await channel.updateCard(input.messageId, input.pointerCard);
    } catch (err) {
      log.warn('stream', 'pointer-card-failed', {
        scope,
        code: larkErrorCode(err) ?? null,
      });
    }
  }
  const text = fullText(input.state);
  log.info('outbound', 'answer-outside-card', { scope, reason, chars: text.length });
  if (!text) return;
  try {
    // As posts, split to fit: their code blocks copy whole, emails are masked.
    await sendPosts(channel, chatId, answerPosts(text), input.sendOpts);
  } catch (err) {
    log.fail('stream', err, { step: 'answer-outside-card', reason });
  }
}

/**
 * Posts in order, each a reply to the one before it (the way the SDK threads
 * the chunks of a long markdown message). Returns their message ids.
 */
async function sendPosts(
  channel: LarkChannel,
  chatId: string,
  posts: object[],
  sendOpts: { replyTo: string; replyInThread?: boolean },
): Promise<string[]> {
  const ids: string[] = [];
  for (const post of posts) {
    const result = await channel.send(chatId, { post }, { ...sendOpts, replyTo: ids.at(-1) ?? sendOpts.replyTo });
    requireMessageReceipt(result, 'post');
    ids.push(result.messageId);
  }
  return ids;
}

/** Index of the run's answer in `blocks`: the text blocks after the last tool call. */
function answerStart(blocks: Block[]): number {
  let i = blocks.length;
  while (i > 0 && blocks[i - 1]!.kind === 'text') i--;
  return i;
}

function answerFrom(blocks: Block[], start: number): string {
  return blocks
    .slice(start)
    .map((b) => (b.kind === 'text' ? b.content.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
}

/** The finished card with its answer replaced by a line pointing down at the message holding it. */
export function answerMovedState(state: RunState, locale: Locale): RunState {
  const start = answerStart(state.blocks);
  return {
    ...state,
    blocks: [
      ...state.blocks.slice(0, start),
      { kind: 'text', content: runStrings(locale).answerBelow, streaming: false },
    ],
  };
}

/**
 * Make the code in a finished answer copyable. A code block on a card has no
 * copy icon (and a card can't write the clipboard); one in a rich-text (post)
 * message does, and copies the block whole. So an answer holding code goes
 * out as posts of its own, and the card keeps the process with a line
 * pointing down at them. A post can't draw tables, so an answer with one
 * stays on the card and only its code blocks follow as a post; so does every
 * answer when there is no card to point from (`updateCard` absent).
 *
 * `state` is the finished run as the user sees it (`filterForPrefs`-projected).
 * Nothing is sent for an answer without code, or a run that didn't finish
 * cleanly. When sending fails the card keeps the answer.
 */
export async function deliverCodeNatively(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  state: RunState;
  locale: Locale;
  updateCard?: (state: RunState) => Promise<void>;
}): Promise<'answer' | 'code' | 'none'> {
  const { state, scope } = input;
  if (state.terminal !== 'done') return 'none';
  const answer = answerFrom(state.blocks, answerStart(state.blocks));
  if (!hasCodeBlock(answer)) return 'none';
  const as = input.updateCard && !hasMarkdownTable(answer) ? 'answer' : 'code';
  try {
    const ids = await sendPosts(
      input.channel,
      input.chatId,
      as === 'answer' ? answerPosts(answer) : codeOnlyPosts(answer),
      input.sendOpts,
    );
    log.info('outbound', 'answer-post', { scope, as, posts: ids.length, chars: answer.length, messageId: ids[0] });
  } catch (err) {
    log.fail('stream', err, { step: 'answer-post', as });
    return 'none';
  }
  if (as === 'answer') {
    try {
      await input.updateCard!(answerMovedState(state, input.locale));
    } catch (err) {
      log.warn('stream', 'answer-pointer-failed', { scope, code: larkErrorCode(err) ?? null });
    }
  }
  return as;
}

export { answerTextOf } from '../card/run-state';

export interface LazyProgressStream {
  /**
   * Mirrors the underlying `channel.stream(...)` promise, and stays pending
   * forever while no stream has been opened — so callers can race it against
   * the render loop exactly as if the stream had been created up front.
   */
  readonly settled: Promise<unknown>;
  opened(): boolean;
  ensureOpen(): void;
  /**
   * True once the reply went out without this stream. A producer that starts
   * after that must render nothing, or the user gets the same answer twice.
   */
  abandoned(): boolean;
  abandon(): void;
}

/**
 * Wrap a progress stream so the user-visible message is only created once the
 * run has something worth showing (see `shouldOpenProgressStream`).
 *
 * The SDK starts a stream eagerly: `channel.stream(...)` sends a card before
 * the producer runs, and finishes it with a "(no content)" placeholder when the
 * producer never supplied any text. A Codex round that only produces a final
 * answer (delivered separately by `sendFinalReply`) used to hit exactly that:
 * an empty card sat in the chat for seconds until `recall-empty` cleaned it up.
 */
export function createLazyProgressStream(
  scope: string,
  mode: 'card' | 'markdown',
  open: () => Promise<unknown>,
): LazyProgressStream {
  let stream: Promise<unknown> | undefined;
  let givenUp = false;
  let settle!: (result: Promise<unknown>) => void;
  const settled = new Promise<unknown>((resolve, reject) => {
    settle = (result) => {
      result.then(resolve, reject);
    };
  });
  return {
    settled,
    opened: () => stream !== undefined,
    ensureOpen: () => {
      if (stream) return;
      log.info('outbound', 'progress-stream-open', { scope, mode });
      stream = open();
      settle(stream);
    },
    abandoned: () => givenUp,
    abandon: () => {
      givenUp = true;
    },
  };
}

/**
 * Is there anything in this state that will still be on screen when the run
 * ends? Footer status lines ("正在思考…") don't count: the terminal event drops
 * them, so a stream opened for a footer alone can still finish empty — which is
 * the placeholder-then-recall churn we're avoiding.
 *
 * Terminal states don't count either. By then the stream has nothing left to
 * stream, and whatever the run produced goes out as a normal reply
 * (`sendFinalReply`, or the stream fallback) instead of a card that would be
 * created only to be finished a moment later.
 *
 * `state` must already be `filterForPrefs`-projected, and emptiness is measured
 * with `renderText` in both reply modes so it matches the rule
 * `recallIfEmptyStreamedReply` applies: a stream we open is one that survives.
 */
/**
 * Agents that stream their whole answer into the progress message (Claude)
 * open it as soon as the run starts. Waiting for visible text left runs that
 * go straight to tool calls (hidden when `showToolCalls` is off) with no card
 * and no stop button for a minute or more — only the Typing reaction showed
 * anything was happening. Agents that post the answer separately (Codex) keep
 * the lazy open: their final-only rounds would otherwise leave an empty
 * placeholder card behind (see `createLazyProgressStream`).
 */
export function opensProgressEagerly(separateFinalReply: boolean): boolean {
  return !separateFinalReply;
}

export function shouldOpenProgressStream(state: RunState): boolean {
  if (state.terminal !== 'running') return false;
  return renderText({ ...state, footer: null }).trim() !== '';
}

/**
 * What Codex's dedicated final reply may carry, given what the progress stream
 * already put on screen.
 *
 * `finalAnswerOnlyState` falls back to the run's text blocks when Codex held
 * nothing back for the end — correct where nothing was streamed (CoT, text
 * mode, a stream we gave up on), but those blocks are already visible once a
 * stream rendered them, and repeating them posts the same words a second time.
 * Codex leaves the answer in `blocks` more often than it looks: any abnormal
 * turn end (`turn.failed`, or the process exiting before `turn.completed`)
 * flushes the pending message as text instead of `final_text`.
 *
 * Terminal notices are dropped for the same reason — the stream rendered them.
 */
export function finalReplyState(progress: LazyProgressStream, state: RunState): RunState {
  if (!progress.opened() || progress.abandoned()) return finalAnswerOnlyState(state);
  return {
    ...state,
    blocks: state.finalText ? [{ kind: 'text', content: state.finalText, streaming: false }] : [],
    reasoning: { content: '', active: false },
    footer: null,
    terminal: 'done',
    errorMsg: undefined,
  };
}

/**
 * Backstop for a progress stream that was opened on real content and still
 * ended up empty — e.g. `/config` hiding tool calls mid-run, which retroactively
 * empties a tool-only render. The SDK fills such a card with its "(no content)"
 * placeholder, so recall it instead of leaving noise in the chat.
 *
 * `finalState` must already be `filterForPrefs`-projected (what the user sees).
 */
export async function recallIfEmptyStreamedReply(
  channel: LarkChannel,
  progress: LazyProgressStream,
  finalState: RunState,
  scope: string,
): Promise<void> {
  if (!progress.opened()) return;
  // An abandoned stream renders nothing, so whatever message it eventually
  // posts is empty by construction. It is still in flight (that is why we gave
  // up on it), so clean up in the background instead of blocking the run on it.
  if (progress.abandoned()) {
    void progress.settled.then(
      (result) => recallStreamedMessage(channel, result, scope),
      () => {},
    );
    return;
  }
  // The 「后台任务还在跑」 note alone is no answer.
  if (renderText({ ...finalState, background: 0 }).trim() !== '') return;
  const result = await progress.settled.catch(() => undefined);
  await recallStreamedMessage(channel, result, scope);
}

async function recallStreamedMessage(
  channel: LarkChannel,
  streamResult: unknown,
  scope: string,
): Promise<void> {
  const { messageId, emptyCard } = (streamResult ?? {}) as { messageId?: string; emptyCard?: object };
  if (!messageId) return;
  try {
    if (emptyCard) {
      await channel.updateCard(messageId, emptyCard);
      log.info('outbound', 'empty-opener-restored', { scope, messageId });
      return;
    }
    await channel.recallMessage(messageId);
    log.info('outbound', 'recall-empty', { scope, messageId });
  } catch (err) {
    log.warn('outbound', 'recall-empty-failed', {
      scope,
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function sendFinalReply(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  state: RunState;
  replyMode: ReturnType<typeof getMessageReplyMode>;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  cardRenderOptions: RunCardRenderOptions;
  /** `final-card` appearance (`preferences.finalCard`); defaults when absent. */
  finalCard?: ResolvedFinalCard;
}): Promise<void> {
  const body = renderText(input.state, input.cardRenderOptions.locale);

  // Nothing deliverable to send (agent produced no text on a clean finish;
  // error/interrupt/timeout keep `body` non-empty via their notices). Skip
  // rather than post an empty card that renders as "(no content)".
  if (!body.trim()) {
    log.info('outbound', 'skip-empty', { scope: input.scope, mode: input.replyMode });
    return;
  }

  if (input.replyMode === 'final-card') {
    await sendFinalCard(input, body);
  } else if (input.replyMode === 'card') {
    // An answer with code goes out as posts instead, so its code blocks copy
    // whole (see deliverCodeNatively) — unless the card has more to say than
    // the answer, or the answer holds a table a post can't draw.
    const answer = answerFrom(input.state.blocks, 0);
    const code = input.state.terminal === 'done' && hasCodeBlock(answer);
    if (code && !hasMarkdownTable(answer) && backgroundLeft(input.state) === 0) {
      try {
        const ids = await sendPosts(input.channel, input.chatId, answerPosts(answer), input.sendOpts);
        log.info('outbound', 'sent', { ...outboundLogFields(input, 'post', body, { messageId: ids[0] }), posts: ids.length });
        return;
      } catch (err) {
        log.fail('stream', err, { step: 'answer-post', as: 'answer' });
      }
    }
    const result = await input.channel.send(
      input.chatId,
      { card: renderCard(input.state, input.cardRenderOptions) },
      input.sendOpts,
    );
    requireMessageReceipt(result, 'card');
    log.info('outbound', 'sent', outboundLogFields(input, 'card', body, result));
    if (code) {
      await deliverCodeNatively({
        channel: input.channel,
        chatId: input.chatId,
        scope: input.scope,
        sendOpts: input.sendOpts,
        state: input.state,
        locale: input.cardRenderOptions.locale ?? 'zh',
      });
    }
  } else if (input.replyMode === 'markdown') {
    if (body.trim()) {
      const result = await input.channel.send(
        input.chatId,
        { markdown: body },
        input.sendOpts,
      );
      requireMessageReceipt(result, 'markdown');
      log.info('outbound', 'sent', outboundLogFields(input, 'markdown', body, result));
    }
  } else if (body.trim()) {
    const result = await input.channel.send(
      input.chatId,
      { markdown: body },
      input.sendOpts,
    );
    requireMessageReceipt(result, 'text');
    log.info('outbound', 'sent', outboundLogFields(input, 'text', body, result));
  }
}

/**
 * `final-card`: one non-streaming card holding the answer. A card Feishu would
 * refuse (past the size budget) or did refuse (e.g. 230099, too many tables)
 * goes out as a plain markdown post instead, so the answer always lands. A
 * send that returned without a receipt is not retried — the card may be out.
 */
async function sendFinalCard(
  input: Parameters<typeof sendFinalReply>[0],
  body: string,
): Promise<void> {
  const pref: ResolvedFinalCard = input.finalCard ?? { headerTemplate: 'violet', footer: false };
  const meta = input.cardRenderOptions.meta;
  const locale = input.cardRenderOptions.locale;
  const card = renderFinalCard(input.state, {
    headerTemplate: pref.headerTemplate,
    ...(pref.headerIcon ? { headerIcon: pref.headerIcon } : {}),
    ...(pref.footer && meta?.model ? { footerModel: meta.model } : {}),
    ...(locale ? { locale } : {}),
  });
  if (!card) {
    log.info('outbound', 'skip-empty', { scope: input.scope, mode: input.replyMode });
    return;
  }
  if (cardBytes(card) <= CARD_BYTE_BUDGET) {
    let result: { messageId?: string } | undefined;
    try {
      result = await input.channel.send(input.chatId, { card }, input.sendOpts);
    } catch (err) {
      log.warn('outbound', 'final-card-failed', {
        scope: input.scope,
        code: larkErrorCode(err),
        err: err instanceof Error ? err.message : String(err),
      });
    }
    if (result) {
      requireMessageReceipt(result, 'final-card');
      log.info('outbound', 'sent', outboundLogFields(input, 'final-card', body, result));
      return;
    }
  } else {
    log.info('outbound', 'final-card-too-large', { scope: input.scope, bytes: cardBytes(card) });
  }
  const markdown = finalCardText(input.state, locale);
  const result = await input.channel.send(input.chatId, { markdown }, input.sendOpts);
  requireMessageReceipt(result, 'final-card-fallback');
  log.info('outbound', 'sent', outboundLogFields(input, 'final-card-fallback', markdown, result));
}

export function requireMessageReceipt(result: { messageId?: string }, type: string): void {
  if (!result.messageId?.trim()) {
    throw new Error(`final ${type} reply missing message receipt`);
  }
}

export async function sendCotDegradedNotice(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  reason: string;
}): Promise<void> {
  log.warn('cot', 'degraded', {
    scope: input.scope,
    reason: input.reason,
    replyInThread: input.sendOpts.replyInThread === true,
  });
  try {
    await input.channel.send(
      input.chatId,
      { markdown: 'COT 过程消息更新失败，已停止展示过程；最终答案仍会继续发送。' },
      input.sendOpts,
    );
  } catch (err) {
    log.warn('cot', 'degraded-notice-failed', {
      scope: input.scope,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function outboundLogFields(
  input: {
    scope?: string;
    replyMode: ReturnType<typeof getMessageReplyMode>;
    sendOpts?: { replyTo?: string; replyInThread?: boolean };
  },
  type: string,
  body: string,
  result?: { messageId?: string },
): Record<string, unknown> {
  return {
    type,
    scope: input.scope,
    mode: input.replyMode,
    chars: body.length,
    messageId: result?.messageId,
    replyTo: input.sendOpts?.replyTo,
    replyInThread: input.sendOpts?.replyInThread === true,
  };
}

export async function awaitRenderAwareStream(input: {
  mode: 'card' | 'markdown';
  progress: LazyProgressStream;
  renderDone: Promise<RunState>;
  producerStarted: () => boolean;
  fallback: (state: RunState) => Promise<void>;
  /**
   * Delivers the answer when a stream that already showed part of the run
   * fails to take its final update. Without one, that failure is rethrown
   * (Codex: its answer goes out separately anyway).
   */
  rescue?: (state: RunState) => Promise<void>;
  /**
   * Runs once a stream that outlived the grace window finally completes. Its
   * last update may have failed only then — after the run already checked —
   * so the caller re-checks here and delivers the answer if the card is stuck.
   */
  lateStreamEnd?: () => Promise<void>;
}): Promise<void> {
  const streamResult = input.progress.settled.then(
    () => ({ kind: 'stream' as const, ok: true as const }),
    (err) => ({ kind: 'stream' as const, ok: false as const, err }),
  );
  const renderResult = input.renderDone.then(
    (state) => ({ kind: 'render' as const, ok: true as const, state }),
    (err) => ({ kind: 'render' as const, ok: false as const, err }),
  );
  const first = await Promise.race([streamResult, renderResult]);
  if (!first.ok) {
    if (first.kind === 'stream') {
      log.fail('stream', first.err, { mode: input.mode, step: 'stream' });
      const rendered = await renderResult;
      if (!rendered.ok) throw rendered.err;
      await runFallbackReply(input.mode, rendered.state, input.fallback);
      return;
    }
    throw first.err;
  }

  if (first.kind === 'stream') {
    const rendered = await renderResult;
    if (!rendered.ok) throw rendered.err;
    return;
  }

  // Nothing durable ever showed up, so no progress message was opened at all
  // (the common Codex final-only round). Whatever the run ended with still has
  // to reach the user as a standalone reply.
  if (!input.progress.opened()) {
    log.info('outbound', 'progress-stream-skipped', { mode: input.mode });
    await runFallbackReply(input.mode, first.state, input.fallback);
    return;
  }

  // The run ended before the stream did. A producer that hasn't started yet is
  // usually just a card still being created (two API round trips), so give the
  // stream its grace window rather than replying immediately — an immediate
  // fallback would post the same answer twice once the stream catches up.
  const terminal = await Promise.race([
    streamResult,
    delay(STREAM_TERMINAL_GRACE_MS).then(() => undefined),
  ]);

  if (!terminal) {
    if (input.producerStarted()) {
      log.warn('stream', 'terminal-grace-expired', {
        mode: input.mode,
        graceMs: STREAM_TERMINAL_GRACE_MS,
      });
      const { rescue, lateStreamEnd } = input;
      void streamResult.then(async (result) => {
        if (!result.ok) {
          log.fail('stream', result.err, { mode: input.mode, step: 'stream-terminal-late' });
          if (rescue && !isTargetRevoked(result.err)) await runFallbackReply(input.mode, first.state, rescue, 'rescue');
          return;
        }
        if (lateStreamEnd) {
          await lateStreamEnd().catch((err) => log.fail('stream', err, { step: 'stream-late-end' }));
        }
      });
      return;
    }
    // Still nothing on screen after the grace window: give up on the stream and
    // reply without it. `abandon()` keeps a late producer from rendering the
    // same answer again; the empty message it leaves is recalled in cleanup.
    input.progress.abandon();
    log.warn('stream', 'producer-not-started-before-agent-terminal', { mode: input.mode });
    await runFallbackReply(input.mode, first.state, input.fallback);
    return;
  }

  if (!terminal.ok) {
    // A stream that failed before producing anything delivered nothing, so the
    // reply still has to go out as a whole. One that failed later showed part
    // of the run, but not necessarily its end: the failed update can be the
    // last one, carrying the answer (Feishu rejects a long run's finished card
    // over content limits), so the answer still has to reach the user.
    if (input.producerStarted()) {
      if (!input.rescue || isTargetRevoked(terminal.err)) throw terminal.err;
      log.fail('stream', terminal.err, { mode: input.mode, step: 'stream-final' });
      await runFallbackReply(input.mode, first.state, input.rescue, 'rescue');
      return;
    }
    log.fail('stream', terminal.err, { mode: input.mode, step: 'stream' });
    await runFallbackReply(input.mode, first.state, input.fallback);
  }
}

/** The message being answered (or the reply itself) was recalled: nothing to deliver to. */
function isTargetRevoked(err: unknown): boolean {
  return err instanceof LarkChannelError && err.code === 'target_revoked';
}

async function runFallbackReply(
  mode: 'card' | 'markdown',
  state: RunState,
  fallback: (state: RunState) => Promise<void>,
  step: 'fallback' | 'rescue' = 'fallback',
): Promise<void> {
  try {
    await fallback(state);
  } catch (err) {
    log.fail('stream', err, { mode, step });
  }
}

/**
 * Put a run's answer on screen after its streamed card failed to take the
 * final update. That card can't be trusted with the full run again (tool
 * panels are what usually push it over Feishu's limits), so send the answer
 * alone, trying what is least likely to be rejected last: in place of the
 * stuck card, then as a new card, then as a plain post.
 */
export async function rescueCardReply(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  cardRenderOptions: RunCardRenderOptions;
  streamedMessageId: string | undefined;
  state: RunState;
}): Promise<void> {
  const answer = finalAnswerOnlyState(input.state);
  const body = renderText(answer);
  if (!body.trim()) return;
  const card = renderCard(answer, input.cardRenderOptions);
  const stepFailed = (via: string, err: unknown): void => {
    log.warn('outbound', 'rescue-step-failed', {
      scope: input.scope,
      via,
      err: err instanceof Error ? err.message : String(err),
    });
  };

  if (input.streamedMessageId) {
    try {
      await input.channel.updateCard(input.streamedMessageId, card);
      log.info('outbound', 'rescue-sent', { scope: input.scope, via: 'update-card', messageId: input.streamedMessageId });
      return;
    } catch (err) {
      stepFailed('update-card', err);
    }
  }
  try {
    const result = await input.channel.send(input.chatId, { card }, input.sendOpts);
    requireMessageReceipt(result, 'card');
    log.info('outbound', 'rescue-sent', { scope: input.scope, via: 'card', messageId: result.messageId });
    return;
  } catch (err) {
    stepFailed('card', err);
  }
  const result = await input.channel.send(input.chatId, { markdown: body }, input.sendOpts);
  requireMessageReceipt(result, 'markdown');
  log.info('outbound', 'rescue-sent', { scope: input.scope, via: 'markdown', messageId: result.messageId });
}

export function scheduleWorkingReactionCleanup(
  channel: LarkChannel,
  messageId: string,
  reactionPromise: Promise<string | undefined> | undefined,
): void {
  if (!reactionPromise) return;

  void (async () => {
    const reactionResult = reactionPromise.then(
      (reactionId) => ({ ok: true as const, reactionId }),
      (err) => ({ ok: false as const, err }),
    );
    const settled = await Promise.race([
      reactionResult,
      delay(REACTION_CLEANUP_GRACE_MS).then(() => undefined),
    ]);

    if (!settled) {
      log.warn('reaction', 'cleanup-deferred', {
        messageId,
        graceMs: REACTION_CLEANUP_GRACE_MS,
      });
      void reactionResult.then((result) => {
        if (!result.ok || !result.reactionId) return;
        void removeReaction(channel, messageId, result.reactionId);
      });
      return;
    }

    if (!settled.ok || !settled.reactionId) return;
    await removeReaction(channel, messageId, settled.reactionId);
  })();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
