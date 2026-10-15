import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';
import { agentDescriptor, type AgentDescriptor, type AgentKind, type PromptInjectionMode } from './registry';

export type { PromptInjectionMode } from './registry';

export type AgentCapabilityId = AgentKind;

export interface AgentCapability {
  agentId: AgentCapabilityId;
  /** Static facts about the agent CLI; shared code branches on these, not on `agentId`. */
  descriptor: AgentDescriptor;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

/** The run capability for a profile's agent, capped by the profile's access ceiling. */
export function agentCapability(
  profile: Pick<ProfileConfig, 'agentKind'> & Partial<Pick<ProfileConfig, 'permissions'>>,
): AgentCapability {
  const descriptor = agentDescriptor(profile.agentKind);
  return {
    agentId: descriptor.kind,
    descriptor,
    promptInjection: descriptor.promptInjection,
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [...descriptor.legacyCallbackMarkers],
    },
    permissions: {
      maxAccess: profile.permissions?.maxAccess ?? 'full',
    },
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return agentCapability({ agentKind: 'claude', ...(profile ? { permissions: profile.permissions } : {}) });
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return agentCapability({ agentKind: 'codex', permissions: profile.permissions });
}
