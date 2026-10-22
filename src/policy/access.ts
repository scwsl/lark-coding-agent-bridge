import type { ProfileConfig } from '../config/profile-schema';
import { getRequireMentionInGroup, type AppConfig } from '../config/schema';
export { accessPolicyDigest } from './fingerprint';

export type OwnerRefreshState = 'ok' | 'failed' | 'unknown';

export interface RuntimeControls {
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
}

export interface AccessDecision {
  ok: boolean;
  reason:
    | 'owner'
    | 'allowed-team'
    | 'allowed-user'
    | 'allowed-admin'
    | 'allowed-chat'
    | 'allowed-chat-user'
    | 'allowed-command-chat'
    | 'comment-mention'
    | 'run-initiator'
    | 'allowed-stopper'
    | 'denied-user'
    | 'denied-chat'
    | 'denied-chat-user'
    | 'denied-admin'
    | 'denied-stop';
}

export function isCreator(controls: RuntimeControls, senderId: string): boolean {
  if (controls.ownerRefreshState === 'unknown') return false;
  return Boolean(controls.botOwnerId) && controls.botOwnerId === senderId;
}

export function canUseDm(
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  // Team mode opens up *usage* to everyone — no allowlist gating. Admin
  // commands stay owner/admin-gated via canRunAdminCommand (unchanged).
  if (profile.mode === 'team') return allow('allowed-team');
  if (profile.access.allowedUsers.includes(senderId)) return allow('allowed-user');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  return deny('denied-user');
}

export function canUseGroup(
  profile: ProfileConfig,
  controls: RuntimeControls,
  chatId: string,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  if (profile.mode === 'team') return allow('allowed-team');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  if (!profile.access.allowedChats.includes(chatId)) return deny('denied-chat');
  // Presence of the chat_id key — not array length — is what puts a chat in
  // restricted mode, so a chat can be created pre-restricted with zero
  // members and never pass through an "open to everyone" window.
  const memberAllowlist = profile.access.chatAllowedUsers?.[chatId];
  if (memberAllowlist !== undefined) {
    return memberAllowlist.includes(senderId) ? allow('allowed-chat-user') : deny('denied-chat-user');
  }
  return allow('allowed-chat');
}

/**
 * Whether a group message must @-mention the bot to be handled. A per-chat
 * override (profile.access.chatRequireMention[chatId]) takes priority over the
 * global requireMentionInGroup (from cfg). p2p chats never call this.
 */
export function requireMentionForChat(
  profile: ProfileConfig,
  cfg: AppConfig,
  chatId: string,
): boolean {
  const override = profile.access.chatRequireMention?.[chatId];
  return typeof override === 'boolean' ? override : getRequireMentionInGroup(cfg);
}

export function canRunAdminCommand(
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  return deny('denied-admin');
}

/**
 * An admin command (`cmd` with its `/`) in `chatId`: the owner and admins
 * anywhere, everyone else only in the chats `access.commandChats` opens it in.
 */
export function canRunCommandInChat(
  profile: ProfileConfig,
  controls: RuntimeControls,
  cmd: string,
  chatId: string,
  senderId: string,
): AccessDecision {
  const admin = canRunAdminCommand(profile, controls, senderId);
  if (admin.ok) return admin;
  if (profile.access.commandChats?.[cmd]?.includes(chatId)) return allow('allowed-command-chat');
  return admin;
}

/**
 * Who may stop a run: the owner, admins, the people whose messages started it,
 * and the `access.stoppers` list. Everyone else in an allowed group can talk
 * to the bot but not cancel someone else's task.
 */
export function canStopRun(
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
  initiators: ReadonlySet<string> | undefined,
): AccessDecision {
  const admin = canRunAdminCommand(profile, controls, senderId);
  if (admin.ok) return admin;
  if (initiators?.has(senderId)) return allow('run-initiator');
  if (profile.access.stoppers?.includes(senderId)) return allow('allowed-stopper');
  return deny('denied-stop');
}

/**
 * Whether what this sender asks for needs an admin's approval step by step:
 * the profile has approvals on (off by default), and they are not an admin.
 */
export function runNeedsApproval(profile: ProfileConfig, controls: RuntimeControls, senderId: string): boolean {
  return profile.approvals.enabled && !canRunAdminCommand(profile, controls, senderId).ok;
}

function allow(reason: AccessDecision['reason']): AccessDecision {
  return { ok: true, reason };
}

function deny(reason: AccessDecision['reason']): AccessDecision {
  return { ok: false, reason };
}
