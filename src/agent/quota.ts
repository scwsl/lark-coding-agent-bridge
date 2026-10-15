import type { ProfileConfig } from '../config/profile-schema';
import { readClaudeQuota } from './claude/quota';
import { readCodexQuota } from './codex/quota';
import type { AgentKind } from './registry';

/**
 * How full the agent account's subscription windows are, for work the bridge
 * starts on its own (自动整理) and must not let eat into the owner's quota.
 * Read-only: nothing here starts a model turn or consumes a reset credit.
 */
export interface QuotaWindow {
  /** `5 小时窗口`, `本周`… */
  label: string;
  /** 0–100. */
  usedPercent: number;
  /** Reset time as the CLI words it (Claude) or epoch ms (Codex), for display only. */
  resets?: string;
}

export interface QuotaReading {
  windows: QuotaWindow[];
  /** The account is already cut off, whatever the percentages say. */
  blocked?: boolean;
}

export interface QuotaReadOptions {
  /** Where to start the CLI: an empty scratch directory. */
  cwd: string;
  /** The profile's state directory (profile-local CODEX_HOME). */
  profileDir?: string;
  timeoutMs?: number;
}

const QUOTA_READERS: Record<AgentKind, (profileConfig: ProfileConfig, opts: QuotaReadOptions) => Promise<QuotaReading | undefined>> = {
  claude: (_profileConfig, opts) => readClaudeQuota(opts),
  codex: (profileConfig, opts) => readCodexQuota(profileConfig.codex, opts),
};

/** Undefined when the CLI cannot say — callers must treat that as "unknown", never as 0%. Never throws. */
export async function readAgentQuota(profileConfig: ProfileConfig, opts: QuotaReadOptions): Promise<QuotaReading | undefined> {
  try {
    const reading = await QUOTA_READERS[profileConfig.agentKind]?.(profileConfig, opts);
    return reading && (reading.windows.length > 0 || reading.blocked) ? reading : undefined;
  } catch {
    return undefined;
  }
}

/** The fullest window, or 100% for a blocked account. */
export function fullestQuotaWindow(reading: QuotaReading): QuotaWindow | undefined {
  if (reading.blocked) return { label: '额度已用尽', usedPercent: 100 };
  return [...reading.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
}
