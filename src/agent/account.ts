import type { ProfileConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { claudeAccountName } from './claude/account';
import {
  accountRows,
  accountsReport,
  accountsTable,
  bestSwitchTarget,
  claudeAccountPool,
  claudeAccountsPaths,
  findAccountRow,
  findPausedAccount,
  parseSwitchQuery,
  pausedNote,
  pausedRefusal,
  SWITCH_SCORE_WEIGHTS,
  switchBoost,
  switchRefusal,
  switchToAccount,
  WINDOW_KINDS,
  type ClaudeAccountEntry,
  type AccountRow,
} from './claude/accounts';
import { refreshAllQuota } from './claude/quota-probe';
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

const SCORE_NOTE = `得分 = ${SWITCH_SCORE_WEIGHTS.weekRoom} × 本周余量 + ${SWITCH_SCORE_WEIGHTS.weekExpiring} × 本周余量 × 本周重置临近度 + ${SWITCH_SCORE_WEIGHTS.fiveHourRoom} × 5 小时余量。余量 = 1 − 用量 ÷ 切换线，临近度 = 1 − 距本周重置 ÷ 7 天；已到任一切换线的账户记 0 分；没运行过的账户余量按一半算。`;

/** `5 小时 / 本周` — the windows a switch by name raised. */
function boostedWindows(boost: NonNullable<ClaudeAccountEntry['boost']>): string {
  return WINDOW_KINDS.filter((kind) => boost[kind])
    .map((kind) => (kind === 'five_hour' ? '5 小时' : '本周'))
    .join(' / ');
}

/** How `/accounts` got its figures: read just now, but for the accounts whose reading failed. */
function freshnessNote(rows: AccountRow[], failed: string[]): string {
  const how = '用量和重置时间是刚读的：CLI 登录账户读 `/usage`，备用账户的 token 读不了 `/usage`，各发一条 haiku 小请求读额度。';
  const names = rows.filter((row) => failed.includes(row.id)).map((row) => row.name);
  return names.length > 0 ? `${how}${names.join('、')} 没读到，沿用它最近一次运行的报告。` : how;
}

/**
 * `/accounts`: the profile's Claude subscription accounts as one table —
 * usage, resets and switch lines per window, each account's quota read just
 * now ({@link refreshAllQuota}). Undefined for other agents.
 */
export async function agentAccountsTable(profileConfig: AccountProfile, profileDir: string): Promise<string | undefined> {
  if (profileConfig.agentKind !== 'claude') return undefined;
  const pool = claudeAccountPool(profileDir);
  await pool.refresh();
  const failed = await refreshAllQuota(pool);
  const rows = accountRows(pool, await claudeAccountName());
  const paused = pausedNote(pool);
  return [
    '**Claude 订阅账户**（✅ 为新任务正在用的账户；到切换线后自动换到得分最高的可用账户，并设为主账户）',
    '',
    accountsTable(rows),
    ...(paused ? ['', paused] : []),
    '',
    `_${freshnessNote(rows, failed)}${SCORE_NOTE}_`,
    '',
    `\`/accounts switch\` 切到得分最高的可用账户；\`/accounts switch <名字或 id>\` 切到指定账户（它要在切换线以下）；\`/accounts switch <名字或 id> <百分比>\` 同时把它的切换线临时调到该值，到该窗口重置恢复原线。`,
  ].join('\n');
}

/**
 * `/accounts switch [name [line]]`: make an account the main one. Without a
 * name, the best-scoring account that has room, other than the current one.
 * By name, that one — only if it is below its switch lines and not refused:
 * a switch obeys the lines like every automatic move. `line` raises its lines
 * to that value until each window resets ({@link switchBoost}); that is the
 * only way past an account's own line. Returns the reply as Markdown.
 */
export async function switchAgentAccount(
  profileConfig: AccountProfile,
  profileDir: string,
  query?: string,
): Promise<string> {
  if (profileConfig.agentKind !== 'claude') return '只有 Claude profile 能切换订阅账户。';
  const parsed = parseSwitchQuery(query);
  if ('error' in parsed) return `❌ ${parsed.error}`;
  const pool = claudeAccountPool(profileDir);
  await pool.refresh();
  // Pick by what the accounts hold now, not what their last runs said.
  await refreshAllQuota(pool);
  const label = await claudeAccountName();
  const rows = accountRows(pool, label);
  if (rows.length < 2) return '只有一个账户，没有可切换的。添加备用账户见 `lark-channel-bridge claude-account add`。';
  // The main account: what a switch moves away from (new runs may already be
  // on another one if it is past a line).
  const current = rows.find((row) => row.index === 0);
  let target: AccountRow | undefined;
  let boost: ClaudeAccountEntry['boost'];
  if (parsed.name) {
    target = findAccountRow(rows, parsed.name);
    const paused = target ? undefined : findPausedAccount(pool, parsed.name);
    if (paused) return `⚠️ 没有切换：**${paused.name}** ${pausedRefusal(paused.until)}。`;
    if (!target) return `没有叫「${parsed.name}」的账户。可选：${rows.map((r) => `${r.name}（${r.id}）`).join('、')}`;
    const refusal = switchRefusal(pool, target, parsed.line);
    if (refusal) {
      const hint =
        target.refusedUntil === undefined
          ? `确需继续用它，带上临时切换线：\`/accounts switch ${parsed.name} <高于当前用量的百分比>\`，到该窗口重置恢复原线。`
          : '';
      return [`⚠️ 没有切换：**${target.name}** ${refusal}。${hint}`, '', accountsTable(rows)].join('\n');
    }
    if (parsed.line !== undefined) boost = switchBoost(pool, target.id, parsed.line);
  } else {
    target = bestSwitchTarget(rows);
    if (!target) return '其他账户都已到切换线或额度用尽，暂时没有可切换的。\n\n' + accountsTable(rows);
  }
  await switchToAccount(claudeAccountsPaths(profileDir), target.id, boost);
  log.info('claude-accounts', 'manual-switch', {
    from: current?.id ?? null,
    to: target.id,
    byName: Boolean(parsed.name),
    line: boost ? (parsed.line ?? null) : null,
  });
  await pool.refresh();
  const after = accountRows(pool, label);
  const raised = boost
    ? `切换线临时调到 ${parsed.line}%（${boostedWindows(boost)}），该窗口重置后恢复原线；自动切走时也恢复。`
    : '';
  const head =
    current?.id === target.id
      ? `✅ 继续用 **${target.name}**。${raised}`
      : `✅ 已切换到 **${target.name}**（得分 ${Math.round(target.score * 100)}），从下一条消息起新任务用它${current ? `；之前是 ${current.name}` : ''}。${raised}`;
  return [head, '', accountsTable(after), '', `_${SCORE_NOTE}_`].join('\n');
}
