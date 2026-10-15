import { ClaudeAdapter } from '../agent/claude/adapter';
import { CodexAdapter } from '../agent/codex/adapter';
import type { LarkChannelEnvContext } from '../agent/lark-channel-env';
import { AgentPreflightError, type AgentAvailability } from '../agent/preflight';
import { agentDescriptor, DEFAULT_AGENT_KIND, isAgentKind } from '../agent/registry';
import type { AgentAdapter } from '../agent/types';
import type { AppPaths } from '../config/app-paths';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import type { AcquiredRuntimeLock } from './locks';

/**
 * Build the agent adapter for a profile, wiring its per-profile lark-channel env
 * (so spawned agent processes see this profile's LARKSUITE_CLI_CONFIG_DIR etc.).
 * Shared by the foreground run path and the supervisor so both produce an
 * identically-configured adapter. Each profile MUST get its own adapter — the
 * adapter stores bot identity on itself (see `setBotIdentity`).
 */
export function createRuntimeAgent(
  profileConfig: ProfileConfig,
  appPaths: Pick<AppPaths, 'profileDir'> &
    Partial<Pick<AppPaths, 'rootDir' | 'profile' | 'configFile' | 'larkCliConfigDir' | 'larkCliSourceConfigFile'>> & {
      configPath?: string;
    },
): AgentAdapter {
  const larkChannelConfigPath = appPaths.configPath ?? appPaths.configFile;
  const larkChannel =
    appPaths.rootDir && appPaths.profile
      ? {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          ...(larkChannelConfigPath ? { configPath: larkChannelConfigPath } : {}),
          ...(appPaths.larkCliConfigDir ? { larkCliConfigDir: appPaths.larkCliConfigDir } : {}),
          ...(appPaths.larkCliSourceConfigFile
            ? { larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile }
            : {}),
        }
      : undefined;
  return ADAPTER_FACTORIES[profileConfig.agentKind](profileConfig, { profileDir: appPaths.profileDir, larkChannel });
}

interface AdapterFactoryContext {
  profileDir: string;
  larkChannel: LarkChannelEnvContext | undefined;
}

/** One adapter constructor per agent kind; see src/agent/registry.ts for adding one. */
const ADAPTER_FACTORIES: Record<AgentKind, (profileConfig: ProfileConfig, ctx: AdapterFactoryContext) => AgentAdapter> = {
  claude: (_profileConfig, ctx) => new ClaudeAdapter({ larkChannel: ctx.larkChannel }),
  codex: (profileConfig, ctx) => {
    const codex = profileConfig.codex;
    if (!codex?.binaryPath) {
      throw new Error('codex profile requires codex.binaryPath');
    }
    return new CodexAdapter({
      binary: codex.binaryPath,
      profileStateDir: ctx.profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      inheritCodexHome: codex.inheritCodexHome === true,
      ignoreUserConfig: codex.ignoreUserConfig === true,
      ignoreRules: codex.ignoreRules !== false,
      ...(codex.transport ? { transport: codex.transport } : {}),
      ...(codex.env ? { env: codex.env } : {}),
      sandbox: profileConfig.sandbox.defaultMode,
      larkChannel: ctx.larkChannel,
    });
  },
};

export async function checkRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {
  if (agent.checkAvailability) return agent.checkAvailability();
  const ok = await agent.isAvailable();
  if (ok) return { ok: true };
  const descriptor = agentDescriptor(isAgentKind(agent.id) ? agent.id : undefined);
  const diagnostic = {
    code: 'agent-binary-not-found' as const,
    agentId: descriptor.kind,
    agentName: agent.displayName,
    command: descriptor.command,
  };
  return { ok: false, diagnostic, error: new AgentPreflightError(diagnostic) };
}

/** Guard: reconnect/restart must not switch a profile's agent kind mid-flight. */
export function assertReconnectAgentKindUnchanged(
  current: AgentKind | undefined,
  next: AgentKind | undefined,
): void {
  const currentKind = current ?? DEFAULT_AGENT_KIND;
  const nextKind = next ?? DEFAULT_AGENT_KIND;
  if (nextKind !== currentKind) {
    throw new Error(
      `agent kind cannot change during reconnect (${currentKind} -> ${nextKind}); stop/start is required`,
    );
  }
}

/** Release a set of runtime locks, swallowing individual failures. */
export async function releaseRuntimeLocks(locks: AcquiredRuntimeLock[]): Promise<void> {
  for (const lock of locks) {
    await lock.release().catch(() => undefined);
  }
}
