import type { NormalizedMessage } from '@larksuite/channel';

/**
 * 转发 + 备注合并开话题: Feishu delivers "forward with a note" as two
 * messages a few hundred ms apart — the merge_forward, and the note quoting
 * it — in either order. 自动开话题 would give each a topic and a run of its
 * own. Instead the note, the later message that carries the ask, opens the
 * one topic, and the message it quotes joins it.
 *
 * A message from a person that quotes another and is about to be routed into
 * a topic stakes a claim on the quoted message. When the quoted message comes
 * through intake while the claim stands, it waits for the claimer's topic and
 * runs there instead of opening its own. A merge_forward, which on its own
 * carries no ask, holds back briefly for a note that quotes it.
 */

export interface ClaimedTopic {
  threadId: string;
  scope: string;
}

interface Claim {
  senderId: string;
  topic: Promise<ClaimedTopic | undefined>;
}

/** How long a claim stands: past it the quoted message is old news. */
export const TOPIC_CLAIM_TTL_MS = 15_000;
/** How long a lone merge_forward waits for the note quoting it. */
export const FORWARD_NOTE_HOLD_MS = 1_500;

const claims = new Map<string, Claim>();
const waiters = new Map<string, (claim: Claim) => void>();

const keyOf = (chatId: string, messageId: string): string => `${chatId}:${messageId}`;

export interface TopicClaimHandle {
  /** Settle the claim with the topic the claimer runs in; undefined when it opened none. Idempotent. */
  settle(topic: ClaimedTopic | undefined): void;
}

/**
 * Stake `msg`'s claim on the message it quotes. Undefined when it quotes
 * nothing. The handle must be settled once the claimer is routed.
 */
export function claimQuotedForTopic(
  msg: Pick<NormalizedMessage, 'chatId' | 'senderId' | 'replyToMessageId'>,
  ttlMs = TOPIC_CLAIM_TTL_MS,
): TopicClaimHandle | undefined {
  const quoted = msg.replyToMessageId;
  if (!quoted) return undefined;
  let resolve!: (topic: ClaimedTopic | undefined) => void;
  let settled = false;
  const topic = new Promise<ClaimedTopic | undefined>((r) => (resolve = r));
  const key = keyOf(msg.chatId, quoted);
  const claim: Claim = { senderId: msg.senderId, topic };
  claims.set(key, claim);
  const timer = setTimeout(() => {
    if (claims.get(key) === claim) claims.delete(key);
  }, ttlMs);
  timer.unref?.();
  const waiter = waiters.get(key);
  if (waiter) {
    waiters.delete(key);
    waiter(claim);
  }
  return {
    settle(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    },
  };
}

/**
 * The topic `msg` should join because a message from its sender quoting it is
 * being routed into one; undefined when none claims it. `holdMs` > 0 waits
 * that long for a claim that has not come in yet.
 */
export async function claimedTopicFor(
  msg: Pick<NormalizedMessage, 'chatId' | 'messageId' | 'senderId'>,
  holdMs = 0,
): Promise<ClaimedTopic | undefined> {
  const key = keyOf(msg.chatId, msg.messageId);
  let claim = claims.get(key);
  if (!claim && holdMs > 0) {
    claim = await new Promise<Claim | undefined>((resolve) => {
      const done = (c: Claim): void => {
        clearTimeout(timer);
        resolve(c);
      };
      const timer = setTimeout(() => {
        if (waiters.get(key) === done) waiters.delete(key);
        resolve(undefined);
      }, holdMs);
      waiters.set(key, done);
    });
  }
  if (!claim || claim.senderId !== msg.senderId) return undefined;
  if (claims.get(key) === claim) claims.delete(key);
  return claim.topic;
}

/** Whether `msg` is a forward that waits for a note before opening a topic. */
export function holdsForNote(msg: Pick<NormalizedMessage, 'rawContentType'>): boolean {
  return msg.rawContentType === 'merge_forward';
}

/** Test hook: forget every claim and waiter. */
export function resetTopicClaims(): void {
  claims.clear();
  waiters.clear();
}
