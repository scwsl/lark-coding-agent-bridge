import type { ProfileConfig } from '../config/profile-schema';
import { claudeAccountName } from './claude/account';
import {
  accountRows,
  accountsReport,
  accountsTable,
  bestSwitchTarget,
  claudeAccountPool,
  claudeAccountsPaths,
  findAccountRow,
  SWITCH_SCORE_WEIGHTS,
  switchToAccount,
  type AccountRow,
} from './claude/accounts';
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
      `**订阅账户**（▶ 为新任务使用的账户。主账户没到切换线就一直用它，到线后换到没到线的账户里得分最高的一个，并把它设为主账户；都到线后同样按得分把各账户用到额度耗尽；全部耗尽才暂停，到最早恢复的账户重置时自动续跑。默认切换线：5 小时 ${lines.five_hour}% · 本周 ${lines.seven_day}%）`,
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

const SCORE_NOTE = `得分 = ${SWITCH_SCORE_WEIGHTS.room} × 余量 + ${SWITCH_SCORE_WEIGHTS.reset} × 重置临近度：余量看两个窗口里离切换线更近的那个，临近度看这个窗口还有多久重置；没运行过的账户余量按一半算。`;

/**
 * `/accounts`: the profile's Claude subscription accounts as one table —
 * usage, resets and switch lines per window. Undefined for other agents.
 */
export async function agentAccountsTable(profileConfig: AccountProfile, profileDir: string): Promise<string | undefined> {
  if (profileConfig.agentKind !== 'claude') return undefined;
  const pool = claudeAccountPool(profileDir);
  await pool.refresh();
  const rows = accountRows(pool, await claudeAccountName());
  return [
    '**Claude 订阅账户**（✅ 为新任务正在用的账户；到切换线后自动换到得分最高的可用账户，并设为主账户）',
    '',
    accountsTable(rows),
    '',
    `_用量和重置时间取自各账户最近一次运行的报告。${SCORE_NOTE}_`,
    '',
    '`/accounts switch` 切到得分最高的可用账户；`/accounts switch <名字或 id>` 切到指定账户。',
  ].join('\n');
}

/**
 * `/accounts switch [name]`: make an account the main one. Without a name,
 * the best-scoring account that has room, other than the current one.
 * Returns the reply as Markdown.
 */
export async function switchAgentAccount(
  profileConfig: AccountProfile,
  profileDir: string,
  query?: string,
): Promise<string> {
  if (profileConfig.agentKind !== 'claude') return '只有 Claude profile 能切换订阅账户。';
  const pool = claudeAccountPool(profileDir);
  await pool.refresh();
  const label = await claudeAccountName();
  const rows = accountRows(pool, label);
  if (rows.length < 2) return '只有一个账户，没有可切换的。添加备用账户见 `lark-channel-bridge claude-account add`。';
  const current = rows.find((row) => row.next);
  let target: AccountRow | undefined;
  if (query?.trim()) {
    target = findAccountRow(rows, query);
    if (!target) return `没有叫「${query.trim()}」的账户。可选：${rows.map((r) => `${r.name}（${r.id}）`).join('、')}`;
    if (target.next) return `已经在用 **${target.name}** 了。`;
  } else {
    target = bestSwitchTarget(rows);
    if (!target) return '其他账户都已到切换线或额度用尽，暂时没有可切换的。\n\n' + accountsTable(rows);
  }
  await switchToAccount(claudeAccountsPaths(profileDir), target.id);
  await pool.refresh();
  const after = accountRows(pool, label);
  const now = after.find((row) => row.next);
  const head =
    now?.id === target.id
      ? `✅ 已切换到 **${target.name}**（得分 ${Math.round(target.score * 100)}），从下一条消息起新任务用它${current ? `；之前是 ${current.name}` : ''}。`
      : `⚠️ 已把 **${target.name}** 排到第一，但它${target.refusedUntil !== undefined ? '额度用尽' : '已过切换线'}，恢复前新任务仍会用 **${now?.name ?? '下一个可用账户'}**。`;
  return [head, '', accountsTable(after), '', `_${SCORE_NOTE}_`].join('\n');
}
