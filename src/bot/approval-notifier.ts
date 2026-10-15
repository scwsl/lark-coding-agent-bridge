import type { LarkChannel } from '@larksuite/channel';
import { approverCard, requesterCard, settledCard, type ApprovalCardContext } from '../card/approval-cards';
import type { Controls } from '../commands';
import { log } from '../core/logger';
import type { ApprovalNotifier, ApprovalOutcome, PendingApproval } from '../runtime/approvals';

/**
 * Puts approvals in front of people over IM: a card with allow / deny in
 * every approver's private chat (owner + admins), and a waiting card the
 * requester can cancel from in the chat the request came from. Once settled,
 * every card is rewritten with the outcome.
 */
export function createApprovalNotifier(deps: {
  /** Late-bound: the broker exists before the channel connects. */
  channel: () => LarkChannel;
  controls: Controls;
  timeoutMinutes: () => number;
}): ApprovalNotifier {
  const context = (p: PendingApproval): ApprovalCardContext => ({
    requester: p.gate.actor.name ?? `…${p.gate.actor.id.slice(-6)}`,
    where: p.gate.where ?? (p.gate.chatId ? '群聊' : p.gate.source),
    botName: deps.channel().botIdentity?.name ?? deps.controls.profile,
    timeoutMinutes: deps.timeoutMinutes(),
  });

  return {
    async announce(p) {
      const approvers = [
        ...new Set([deps.controls.botOwnerId, ...deps.controls.profileConfig.access.admins].filter((id): id is string => Boolean(id))),
      ];
      if (approvers.length === 0) throw new Error('no owner or admin to approve');
      const ctx = context(p);
      for (const approver of approvers) {
        try {
          const sent = await deps.channel().send(approver, { card: approverCard(p, ctx) });
          if (sent.messageId) p.notices.push({ messageId: sent.messageId, audience: 'approver' });
        } catch (err) {
          log.warn('approvals', 'approver-card-failed', { approver: approver.slice(-6), err: String(err) });
        }
      }
      if (!p.notices.some((n) => n.audience === 'approver')) throw new Error('approval card reached no approver');
      if (p.gate.chatId) {
        try {
          const sent = await deps.channel().send(
            p.gate.chatId,
            { card: requesterCard(p, ctx) },
            {
              ...(p.gate.originMessageId ? { replyTo: p.gate.originMessageId } : {}),
              ...(p.gate.threadId ? { replyInThread: true } : {}),
            },
          );
          if (sent.messageId) p.notices.push({ messageId: sent.messageId, audience: 'requester' });
        } catch (err) {
          // The approvers have it; the requester just doesn't see the wait.
          log.warn('approvals', 'requester-card-failed', { err: String(err) });
        }
      }
    },

    async settled(p: PendingApproval, outcome: ApprovalOutcome) {
      const ctx = context(p);
      await Promise.allSettled(
        p.notices.map((n) => deps.channel().updateCard(n.messageId, settledCard(p, outcome, ctx))),
      );
    },
  };
}
