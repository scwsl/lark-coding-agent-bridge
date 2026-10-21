import { tmpdir } from 'node:os';
import { claudeAccountName } from '../../agent/claude/account';
import {
  accountsReport,
  claudeAccountsPaths,
  ClaudeAccountPool,
  deleteAccount,
  isValidAccountId,
  saveAccount,
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
  console.log(`# profile ${appPaths.profile} 的 Claude 账户（按优先顺序；切换阈值 ${pool.switchAtPercent}%）\n`);
  for (const line of accountsReport(pool, await claudeAccountName())) console.log(line.replace(/\*\*/g, ''));
  if (!pool.multi) {
    console.log('\n只有 CLI 自己的登录。添加备用账户：先用备用账户执行 `claude setup-token`，再运行');
    console.log(`  lark-channel-bridge claude-account add <id> --label <名字> --profile ${appPaths.profile}`);
  }
}

export async function runClaudeAccountAdd(
  id: string,
  opts: AccountCliOptions & { label?: string; tokenStdin?: boolean; verify?: boolean },
): Promise<void> {
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
    token,
  });
  console.log(`✓ 已保存账户 ${id}（令牌加密存在 profile ${appPaths.profile} 的 keystore）`);
  console.log(`  优先顺序：${config.accounts.map((a) => a.id).join(' → ')}`);
  console.log('  运行中的 bridge 会在下一次运行前自动读取，不用重启。');
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
