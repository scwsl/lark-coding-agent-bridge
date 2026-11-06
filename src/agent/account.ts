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
  expiringFirstNote,
  findAccountRow,
  findPausedAccount,
  GRACE_LINE,
  parseSwitchQuery,
  pausedNote,
  pausedRefusal,
  SWITCH_SCORE_WEIGHTS,
  switchBoost,
  switchRefusal,
  switchToAccount,
  WINDOW_KINDS,
  WORTH_MOVING_ROOM,
  type ClaudeAccountEntry,
  type AccountRow,
  type AccountNameView,
} from './claude/accounts';
import { refreshAllQuota } from './claude/quota-probe';
import { currentStaggerPlan, FIVE_HOUR_MS, startWindowStagger, type StaggerSlot } from './claude/window-stagger';
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

const ACCOUNT_REPORTS: Record<AgentKind, (profileDir: string, view: AccountNameView) => Promise<string[] | undefined>> = {
  claude: async (profileDir, view) => {
    const pool = claudeAccountPool(profileDir);
    await pool.refresh();
    if (!pool.multi) return undefined;
    const lines = pool.defaultLines;
    return [
      `**订阅账户**（▶ 为新任务使用的账户。主账户没到切换线就一直用它，到线后换到没到线的账户里得分最高的一个，并把它设为主账户；都到线后同样按得分把各账户用到额度耗尽；全部耗尽才暂停，到最早恢复的账户重置时自动续跑。默认切换线：5 小时 ${lines.five_hour}% · 本周 ${lines.seven_day}%）`,
      ...accountsReport(pool, await claudeAccountName(), Date.now(), view),
    ];
  },
  codex: () => Promise.resolve(undefined),
};

/**
 * The profile's subscription accounts and how full each is, as Markdown lines
 * for `/usage`. Undefined when the profile has only one account.
 */
export function agentAccountsReport(
  profileConfig: AccountProfile,
  profileDir: string,
  view: AccountNameView = {},
): Promise<string[] | undefined> {
  return (ACCOUNT_REPORTS[profileConfig.agentKind]?.(profileDir, view) ?? Promise.resolve(undefined)).catch(() => undefined);
}

/**
 * Keep the profile's Claude accounts' 5-hour windows evenly staggered while
 * the bridge runs (see `window-stagger.ts`). Undefined for other agents.
 */
export function startAgentWindowStagger(
  profileConfig: Pick<ProfileConfig, 'agentKind'>,
  profileDir: string,
): { stop(): Promise<void> } | undefined {
  if (profileConfig.agentKind !== 'claude') return undefined;
  return startWindowStagger({ pool: claudeAccountPool(profileDir) });
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** `/accounts`: when each account's next 5-hour window opens, in that order. */
export function staggerNote(plan: StaggerSlot[], rows: AccountRow[]): string | undefined {
  if (plan.length < 2) return undefined;
  const name = (id: string): string => rows.find((row) => row.id === id)?.name ?? id;
  const step = Math.round(FIVE_HOUR_MS / plan.length / 60_000);
  const order = [...plan].sort((a, b) => a.warmAt - b.warmAt);
  const held = order.filter((slot) => slot.delayMs > 0).map((slot) => name(slot.id));
  return [
    `**5 小时窗口错峰**：${plan.length} 个账户每 ${step} 分钟错开一个重置；对齐以后，大任务把几个账户用光时，每隔约 ${step} 分钟就有一个账户的 5 小时额度恢复。`,
    `下一轮开窗：${order.map((slot) => `${name(slot.id)} ${clock(slot.warmAt)}`).join(' → ')}（各自 5 小时后重置）。`,
    ...(held.length > 0
      ? [`${held.join('、')} 的窗口要往后挪才能错开：重置后先空着（额度是满的，照常能用），到点才发一条 haiku 小请求开窗；查额度也不再顺手把它的窗口打开。`]
      : []),
  ].join('\n');
}

const SCORE_NOTE = `选号按「先到期先用」：本周额度先重置的账户先用，用到切换线再换下一个，到期没用掉的额度就白费了，晚重置的账户之后还能用。得分 = ${SWITCH_SCORE_WEIGHTS.weekExpiring} × 本周重置临近度 × 足额系数 + ${SWITCH_SCORE_WEIGHTS.weekRoom} × 本周余量 + ${SWITCH_SCORE_WEIGHTS.fiveHourRoom} × 5 小时余量。余量 = 1 − 用量 ÷ 切换线，临近度 = 1 − 距本周重置 ÷ 7 天，足额系数 = min(1, 本周余量 ÷ ${WORTH_MOVING_ROOM})（剩不到切换线一成的不值得专门换号）；窗口临近重置时（5 小时窗口：8–21 点剩不到 30 分钟、其他时间不到 1 小时；本周：8–20 点剩不到 4 小时、其他时间不到 6 小时）切换线放宽到 ${GRACE_LINE}%，5 小时余量还按 1 − 距重置 ÷ 临近时长 向满额靠拢，表里写成「原线→${GRACE_LINE}%」，反正重置后额度就回来了。已到任一切换线的账户记 0 分；没运行过的账户余量按一半算。`;

/** `5 小时 / 本周` — the windows a switch by name raised. */
function boostedWindows(boost: NonNullable<ClaudeAccountEntry['boost']>): string {
  return WINDOW_KINDS.filter((kind) => boost[kind])
    .map((kind) => (kind === 'five_hour' ? '5 小时' : '本周'))
    .join(' / ');
}

/** How `/accounts` got its figures: read just now, but for the accounts whose reading failed. */
function freshnessNote(rows: AccountRow[], failed: string[]): string {
  const how = '用量和重置时间是刚读的：CLI 登录账户读 `/usage`，备用账户的 token 读不了 `/usage`，各发一条 haiku 小请求读额度（5 小时窗口已重置、等错峰开窗的备用账户不读，沿用上次读数）。';
  const names = rows.filter((row) => failed.includes(row.id)).map((row) => row.name);
  return names.length > 0 ? `${how}${names.join('、')} 没读到，沿用它最近一次运行的报告。` : how;
}

/**
 * `/accounts`: the profile's Claude subscription accounts as one table —
 * usage, resets and switch lines per window, each account's quota read just
 * now ({@link refreshAllQuota}). Undefined for other agents.
 */
export async function agentAccountsTable(
  profileConfig: AccountProfile,
  profileDir: string,
  view: AccountNameView = {},
): Promise<string | undefined> {
  if (profileConfig.agentKind !== 'claude') return undefined;
  const pool = claudeAccountPool(profileDir);
  await pool.refresh();
  const failed = await refreshAllQuota(pool);
  const rows = accountRows(pool, await claudeAccountName(), Date.now(), view);
  const paused = pausedNote(pool, view);
  const expiring = expiringFirstNote(rows);
  const stagger = staggerNote(currentStaggerPlan(pool), rows);
  return [
    '**Claude 订阅账户**（✅ 为新任务正在用的账户；到切换线后自动换到得分最高的可用账户，并设为主账户）',
    '',
    accountsTable(rows),
    ...(expiring ? ['', expiring] : []),
    ...(stagger ? ['', stagger] : []),
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
  view: AccountNameView = {},
): Promise<string> {
  if (profileConfig.agentKind !== 'claude') return '只有 Claude profile 能切换订阅账户。';
  const parsed = parseSwitchQuery(query);
  if ('error' in parsed) return `❌ ${parsed.error}`;
  const pool = claudeAccountPool(profileDir);
  await pool.refresh();
  // Pick by what the accounts hold now, not what their last runs said.
  await refreshAllQuota(pool);
  const label = await claudeAccountName();
  const rows = accountRows(pool, label, Date.now(), view);
  if (rows.length < 2) return '只有一个账户，没有可切换的。添加备用账户见 `lark-channel-bridge claude-account add`。';
  // The main account: what a switch moves away from (new runs may already be
  // on another one if it is past a line).
  const current = rows.find((row) => row.index === 0);
  let target: AccountRow | undefined;
  let boost: ClaudeAccountEntry['boost'];
  if (parsed.name) {
    target = findAccountRow(rows, parsed.name);
    const paused = target ? undefined : findPausedAccount(pool, parsed.name, view);
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
  const after = accountRows(pool, label, Date.now(), view);
  const raised = boost
    ? `切换线临时调到 ${parsed.line}%（${boostedWindows(boost)}），该窗口重置后恢复原线；自动切走时也恢复。`
    : '';
  const head =
    current?.id === target.id
      ? `✅ 继续用 **${target.name}**。${raised}`
      : `✅ 已切换到 **${target.name}**（得分 ${Math.round(target.score * 100)}），从下一条消息起新任务用它${current ? `；之前是 ${current.name}` : ''}。${raised}`;
  return [head, '', accountsTable(after), '', `_${SCORE_NOTE}_`].join('\n');
}
