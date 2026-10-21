import type { ProfileConfig } from '../config/profile-schema';
import { claudeAccountName } from './claude/account';
import { accountsReport, claudeAccountPool } from './claude/accounts';
import { codexAccountName, effectiveCodexHome } from './codex/account';
import type { AgentKind } from './registry';

type AccountProfile = Pick<ProfileConfig, 'agentKind' | 'codex'>;

const ACCOUNT_NAMES: Record<AgentKind, (profileConfig: AccountProfile) => Promise<string | undefined>> = {
  claude: () => claudeAccountName(),
  codex: (profileConfig) => codexAccountName(effectiveCodexHome(profileConfig.codex)),
};

/**
 * The account paying for a profile's runs, for the reply card's `Sponsor:`
 * line — the Claude CLI's claude.ai login, or the Codex CLI's ChatGPT login.
 * Undefined when the agent is on an API key or the account can't be read.
 * Shared bot / scheduler code goes through here so it never imports an
 * agent's internals directly.
 */
export function agentAccountName(profileConfig: AccountProfile): Promise<string | undefined> {
  return ACCOUNT_NAMES[profileConfig.agentKind]?.(profileConfig) ?? Promise.resolve(undefined);
}

const ACCOUNT_REPORTS: Record<AgentKind, (profileDir: string) => Promise<string[] | undefined>> = {
  claude: async (profileDir) => {
    const pool = claudeAccountPool(profileDir);
    await pool.refresh();
    if (!pool.multi) return undefined;
    const lines = pool.defaultLines;
    return [
      `**订阅账户**（▶ 为新任务使用的账户。先按顺序用还没到切换线的账户；都到线后再按顺序把各账户用到额度耗尽；全部耗尽才暂停，到最早恢复的账户重置时自动续跑。默认切换线：5 小时 ${lines.five_hour}% · 本周 ${lines.seven_day}%）`,
      ...accountsReport(pool, await claudeAccountName()),
    ];
  },
  codex: () => Promise.resolve(undefined),
};

/**
 * The profile's subscription accounts and how full each is, as Markdown lines
 * for `/usage`. Undefined when the profile has only one account.
 */
export function agentAccountsReport(profileConfig: AccountProfile, profileDir: string): Promise<string[] | undefined> {
  return (ACCOUNT_REPORTS[profileConfig.agentKind]?.(profileDir) ?? Promise.resolve(undefined)).catch(() => undefined);
}
