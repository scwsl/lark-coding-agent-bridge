import { tmpdir } from 'node:os';
import { claudeAccountName } from '../../agent/claude/account';
import {
  accountRows,
  accountsReport,
  accountsTable,
  bestSwitchTarget,
  claudeAccountsPaths,
  findAccountRow,
  findPausedAccount,
  pausedNote,
  pausedRefusal,
  switchToAccount,
  ClaudeAccountPool,
  deleteAccount,
  isValidAccountId,
  reorderAccounts,
  switchBoost,
  switchRefusal,
  saveAccount,
  updateAccount,
  updateDefaultLines,
  type SwitchLines,
} from '../../agent/claude/accounts';
import { mergeProcessEnv, spawnProcess } from '../../platform/spawn';
import { promptPassword } from '../prompt';
import { resolveSecretProfilePaths } from './secrets';

/**
 * `claude-account` CLI: the extra Claude subscription accounts a profile can
 * move its runs to when the current account's quota runs out. Each one is a
 * long-lived token from `claude setup-token`, kept in the profile keystore.
 * The running bridge picks up changes before its next run — no restart.
 */

interface AccountCliOptions {
  profile?: string;
  rootDir?: string;
}

export async function runClaudeAccountList(opts: AccountCliOptions = {}): Promise<void> {
  const appPaths = await resolveSecretProfilePaths(opts);
  const pool = new ClaudeAccountPool({ paths: claudeAccountsPaths(appPaths.profileDir) });
  await pool.refresh();
  const lines = pool.defaultLines;
  console.log(
    `# profile ${appPaths.profile} 的 Claude 账户（按优先顺序；默认切换线 5 小时 ${lines.five_hour}% · 本周 ${lines.seven_day}%）\n`,
  );
  for (const line of accountsReport(pool, await claudeAccountName())) console.log(line.replace(/\*\*/g, ''));
  if (!pool.multi) {
    console.log('\n只有 CLI 自己的登录。添加备用账户：先用备用账户执行 `claude setup-token`，再运行');
    console.log(`  lark-channel-bridge claude-account add <id> --label <名字> --profile ${appPaths.profile}`);
  }
}

export async function runClaudeAccountAdd(
  id: string,
  opts: AccountCliOptions & LineOptions & { label?: string; tokenStdin?: boolean; verify?: boolean },
): Promise<void> {
  const lines = parseLineOptions(opts, true);
  if (!isValidAccountId(id) || id === 'default') {
    console.error('✗ 账号 id 只能用字母、数字、- 和 _（最长 32 位），且不能是 default');
    process.exit(1);
  }
  const appPaths = await resolveSecretProfilePaths(opts);
  const token = (
    opts.tokenStdin || !process.stdin.isTTY
      ? await readAllStdin()
      : await promptPassword('粘贴 `claude setup-token` 输出的令牌（不回显）: ')
  ).trim();
  if (!token) {
    console.error('✗ 取消（令牌为空）');
    process.exit(1);
  }
  if (!token.startsWith('sk-ant-oat')) {
    console.error('⚠️ 令牌不像 `claude setup-token` 的输出（应以 sk-ant-oat 开头），仍按原样保存。');
  }
  if (opts.verify !== false) {
    console.log('验证令牌（用 haiku 发一条极短的请求）…');
    const check = await verifyToken(token);
    if (!check.ok) {
      console.error(`✗ 令牌不可用：${check.message}`);
      console.error('  没有保存。确认令牌完整后重试；跳过验证用 --no-verify。');
      process.exit(1);
    }
    console.log(`✓ 令牌可用${check.quota ? `，当前用量：${check.quota}` : ''}`);
  }
  const config = await saveAccount(claudeAccountsPaths(appPaths.profileDir), {
    id,
    ...(opts.label ? { label: opts.label } : {}),
    ...(lines ? { lines } : {}),
    token,
  });
  console.log(`✓ 已保存账户 ${id}（令牌加密存在 profile ${appPaths.profile} 的 keystore）`);
  console.log(`  优先顺序：${config.accounts.map((a) => a.id).join(' → ')}`);
  console.log('  运行中的 bridge 会在下一次运行前自动读取，不用重启。');
}

interface LineOptions {
  /** 5-hour window line, `98` / `98%`. */
  fiveHour?: string;
  /** Weekly window line. */
  weekly?: string;
}

export async function runClaudeAccountSet(
  id: string,
  opts: AccountCliOptions & LineOptions & { label?: string },
): Promise<void> {
  const lines = parseLineOptions(opts, true);
  if (opts.label === undefined && !lines) {
    console.error('✗ 至少给一项：--label <名字>、--five-hour <百分比>、--weekly <百分比>（0 表示跟默认）');
    process.exit(1);
  }
  const appPaths = await resolveSecretProfilePaths(opts);
  await updateAccount(claudeAccountsPaths(appPaths.profileDir), id, {
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    ...(lines ? { lines } : {}),
  });
  console.log(`✓ 已更新账户 ${id}，运行中的 bridge 下一次运行前生效\n`);
  await runClaudeAccountList(opts);
}

/** The profile's default lines, for accounts without their own. */
export async function runClaudeAccountLines(opts: AccountCliOptions & LineOptions): Promise<void> {
  const lines = parseLineOptions(opts, false);
  if (!lines) {
    console.error('✗ 至少给一项：--five-hour <百分比>、--weekly <百分比>');
    process.exit(1);
  }
  const appPaths = await resolveSecretProfilePaths(opts);
  await updateDefaultLines(claudeAccountsPaths(appPaths.profileDir), lines);
  console.log('✓ 已更新默认切换线，运行中的 bridge 下一次运行前生效\n');
  await runClaudeAccountList(opts);
}

/** Preference order: the accounts named come first, in this order. */
export async function runClaudeAccountOrder(ids: string[], opts: AccountCliOptions = {}): Promise<void> {
  const appPaths = await resolveSecretProfilePaths(opts);
  await reorderAccounts(claudeAccountsPaths(appPaths.profileDir), ids);
  console.log('✓ 已调整顺序，运行中的 bridge 下一次运行前生效\n');
  await runClaudeAccountList(opts);
}

/**
 * Make an account the main one: the named one, or the best-scoring one with
 * room. A named account must be below its switch lines and not refused, as
 * for every automatic move; `line` raises its lines to that value until each
 * window resets — the only way past them.
 */
export async function runClaudeAccountSwitch(
  query: string | undefined,
  opts: AccountCliOptions & { line?: string } = {},
): Promise<void> {
  const appPaths = await resolveSecretProfilePaths(opts);
  const paths = claudeAccountsPaths(appPaths.profileDir);
  const pool = new ClaudeAccountPool({ paths });
  await pool.refresh();
  const label = await claudeAccountName();
  const rows = accountRows(pool, label);
  let line: number | undefined;
  if (opts.line !== undefined) {
    line = Number(opts.line.trim().replace(/%$/, ''));
    if (!query || !Number.isInteger(line) || line < 1 || line > 100) {
      console.error(query ? `✗ 切换线要是 1–100 的整数：${opts.line}` : '✗ --line 要和账户名一起用');
      process.exit(1);
    }
  }
  const target = query ? findAccountRow(rows, query) : bestSwitchTarget(rows);
  const paused = query && !target ? findPausedAccount(pool, query) : undefined;
  if (paused) {
    console.error(`✗ 没有切换：${paused.name}（${paused.id}）${pausedRefusal(paused.until)}；要提前恢复用 claude-account resume ${paused.id}`);
    process.exit(1);
  }
  if (!target) {
    console.error(query ? `✗ 没有叫「${query}」的账户` : '✗ 其他账户都已到切换线或额度用尽，暂时没有可切换的');
    process.exit(1);
  }
  const refusal = query ? switchRefusal(pool, target, line) : undefined;
  if (refusal) {
    console.error(
      `✗ 没有切换：${target.name}（${target.id}）${refusal}${target.refusedUntil === undefined ? '。确需继续用它，加 --line <高于当前用量的百分比> 临时调高切换线' : ''}`,
    );
    process.exit(1);
  }
  const boost = line !== undefined ? switchBoost(pool, target.id, line) : undefined;
  await switchToAccount(paths, target.id, boost);
  await pool.refresh();
  console.log(
    `✓ 已把 ${target.name}（${target.id}）设为主账户${boost ? `，切换线临时调到 ${line}%，该窗口重置后恢复` : ''}，运行中的 bridge 下一次运行前生效\n`,
  );
  console.log(accountsTable(accountRows(pool, label)).replace(/\*\*/g, ''));
  const note = pausedNote(pool);
  if (note) console.log(`\n${note}`);
}

/**
 * Take an account out of rotation until a date (`--until 2026-11-13`, local
 * midnight; or `2026-11-13T09:00`) or for some days (`--days 14`). Runs
 * already on it move at their next message; it comes back on its own.
 */
export async function runClaudeAccountPause(
  id: string,
  opts: AccountCliOptions & { until?: string; days?: string },
): Promise<void> {
  const until = parsePauseUntil(opts);
  if (typeof until === 'string') {
    console.error(`✗ ${until}`);
    process.exit(1);
  }
  const appPaths = await resolveSecretProfilePaths(opts);
  await updateAccount(claudeAccountsPaths(appPaths.profileDir), id, { pausedUntil: until });
  console.log(`✓ 已暂停账户 ${id} 到 ${new Date(until).toLocaleString('zh-CN', { hour12: false })}，到期自动恢复；运行中的 bridge 下一次运行前生效\n`);
  await runClaudeAccountList(opts);
}

/** End a pause now. */
export async function runClaudeAccountResume(id: string, opts: AccountCliOptions = {}): Promise<void> {
  const appPaths = await resolveSecretProfilePaths(opts);
  await updateAccount(claudeAccountsPaths(appPaths.profileDir), id, { pausedUntil: null });
  console.log(`✓ 已恢复账户 ${id}，运行中的 bridge 下一次运行前生效\n`);
  await runClaudeAccountList(opts);
}

/** `--until 2026-11-13` (local midnight) / `2026-11-13T09:00`, or `--days 14`: epoch ms in the future, else why not. */
export function parsePauseUntil(opts: { until?: string; days?: string }, now = Date.now()): number | string {
  if ((opts.until === undefined) === (opts.days === undefined)) return '--until <日期> 和 --days <天数> 二选一';
  let until: number;
  if (opts.days !== undefined) {
    const days = Number(opts.days.trim());
    if (!Number.isFinite(days) || days <= 0) return `天数要是正数：${opts.days}`;
    until = now + days * 86_400_000;
  } else {
    const raw = opts.until!.trim();
    // A bare date is local midnight, not UTC midnight as Date.parse reads it.
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    until = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() : Date.parse(raw);
    if (!Number.isFinite(until)) return `日期看不懂：${opts.until}（例：2026-11-13 或 2026-11-13T09:00）`;
  }
  if (until <= now) return '暂停截止时间要在将来';
  return until;
}

/** `--five-hour 98` / `--weekly 90%`; `0` (when allowed) drops an account's own line. Anything else exits. */
function parseLineOptions(opts: LineOptions, allowZero: boolean): Partial<SwitchLines> | undefined {
  const lines: Partial<SwitchLines> = {};
  for (const [kind, raw] of [
    ['five_hour', opts.fiveHour],
    ['seven_day', opts.weekly],
  ] as const) {
    if (raw === undefined) continue;
    const value = Number(raw.trim().replace(/%$/, ''));
    if (!Number.isInteger(value) || value > 100 || value < (allowZero ? 0 : 1)) {
      console.error(`✗ 切换线要是 ${allowZero ? '0' : '1'}–100 的整数${allowZero ? '（0 表示跟默认）' : ''}：${raw}`);
      process.exit(1);
    }
    lines[kind] = value;
  }
  return Object.keys(lines).length > 0 ? lines : undefined;
}

export async function runClaudeAccountRemove(id: string, opts: AccountCliOptions = {}): Promise<void> {
  const appPaths = await resolveSecretProfilePaths(opts);
  const removed = await deleteAccount(claudeAccountsPaths(appPaths.profileDir), id);
  if (!removed) {
    console.error(`✗ 没有账户 ${id}`);
    process.exit(1);
  }
  console.log(`✓ 已删除账户 ${id} 及其令牌`);
}

/**
 * One tiny haiku request on the token, outside any session. Reads back the
 * quota windows the API reports with it.
 */
function verifyToken(token: string, timeoutMs = 120_000): Promise<{ ok: boolean; message: string; quota?: string }> {
  return new Promise((resolve) => {
    const child = spawnProcess(
      'claude',
      ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--no-session-persistence'],
      {
        cwd: tmpdir(),
        env: mergeProcessEnv(process.env, { CLAUDE_CODE_OAUTH_TOKEN: token }),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, message: `${Math.round(timeoutMs / 1000)} 秒内没有返回` });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, message: e.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(readVerification(out, err));
    });
    child.stdin?.end('Reply with exactly: OK');
  });
}

export function readVerification(stdout: string, stderr = ''): { ok: boolean; message: string; quota?: string } {
  let quota: string | undefined;
  let failure: string | undefined;
  let succeeded = false;
  for (const line of stdout.split('\n')) {
    let evt: {
      type?: string;
      error?: string;
      is_error?: boolean;
      result?: unknown;
      rate_limit_info?: { status?: string; unifiedWindows?: Record<string, { utilization?: number } | undefined> };
    };
    try {
      evt = JSON.parse(line) as typeof evt;
    } catch {
      continue;
    }
    if (evt.type === 'rate_limit_event' && evt.rate_limit_info) {
      const w = evt.rate_limit_info.unifiedWindows ?? {};
      const pct = (u: number | undefined): string => (typeof u === 'number' ? `${Math.round(u * 100)}%` : '?');
      quota = `5 小时窗口 ${pct(w.five_hour?.utilization)} · 本周 ${pct(w.seven_day?.utilization)}`;
      if (evt.rate_limit_info.status === 'rejected') failure = '额度已用尽（令牌本身有效）';
    }
    if (evt.type === 'assistant' && evt.error) failure ??= evt.error;
    if (evt.type === 'result') {
      if (evt.is_error) failure ??= typeof evt.result === 'string' ? evt.result : 'result is_error';
      else succeeded = true;
    }
  }
  if (succeeded && !failure) return { ok: true, message: 'ok', ...(quota ? { quota } : {}) };
  // A spent account still has a valid token: keep it, it is good again after the reset.
  if (failure === '额度已用尽（令牌本身有效）') return { ok: true, message: failure, quota: `${quota ?? ''}（已用尽）` };
  return { ok: false, message: failure ?? (stderr.trim().slice(0, 300) || '没有得到回复') };
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
