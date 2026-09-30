import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

type ReactionType = 'Typing' | 'DONE' | 'Get';

async function addReaction(
  channel: LarkChannel,
  messageId: string,
  type: ReactionType,
): Promise<string | undefined> {
  try {
    const id = await channel.addReaction(messageId, type);
    if (id) log.info('reaction', 'added', { messageId, reactionId: id, type });
    return id;
  } catch (err) {
    log.warn('reaction', 'add-failed', {
      messageId,
      type,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Add a "Typing" reaction (敲键盘) to a message to give an instant "I got
 * your message and I'm responding" cue while Claude is still thinking.
 * Matches the conventional Feishu UX for "the other side is replying". Fires
 * in every reply mode, card included — card mode's own footer gives the same
 * feedback *inside* the card, but the reaction is what shows up in the bare
 * chat message list.
 *
 * Returns the reaction id on success, undefined on any failure. Failures
 * are logged but never thrown — losing a decoration must not break the
 * actual reply flow.
 */
export function addWorkingReaction(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  return addReaction(channel, messageId, 'Typing');
}

/**
 * Add a "DONE" reaction to the triggering message once a run finishes
 * successfully. Unlike the Typing reaction this fires in every reply mode
 * (card included) — the point is a glance-able marker on the question
 * itself ("this got answered"), independent of whether the reply card
 * shows its own status.
 */
export function addDoneReaction(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  return addReaction(channel, messageId, 'DONE');
}

/**
 * Add a "Get" (收到) reaction to a message that was folded into the running
 * task as a supplement, so the sender can tell it was not queued as a new
 * question — and not mistake it for the DONE of a finished run.
 */
export function addSupplementReaction(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  return addReaction(channel, messageId, 'Get');
}

/** Remove a previously-added reaction. Tolerates errors silently — best
 * effort cleanup; a leftover reaction is harmless. */
export async function removeReaction(
  channel: LarkChannel,
  messageId: string,
  reactionId: string,
): Promise<void> {
  try {
    await channel.removeReaction(messageId, reactionId);
    log.info('reaction', 'removed', { messageId, reactionId });
  } catch (err) {
    log.warn('reaction', 'remove-failed', {
      messageId,
      reactionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
