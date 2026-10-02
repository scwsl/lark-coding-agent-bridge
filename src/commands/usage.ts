import { tmpdir } from 'node:os';
import { spawnProcess } from '../platform/spawn';

/** One plan limit window as Claude Code's `/usage` reports it. */
export interface UsageWindow {
  label: string;
  percent: number;
  /** Reset time, `MM-DD HH:mm` when parseable, else Claude's own wording. */
  resets: string;
}

export interface ParsedUsage {
  /** e.g. "You are currently using your subscription to power …". */
  source?: string;
  windows: UsageWindow[];
  /** The "What's contributing to your limits usage?" section, verbatim. */
  details: string;
}

const WINDOW_RE = /^(Current session|Current week \(([^)]+)\)):\s*(\d+)% used\s*·\s*resets\s+(.+?)\s*$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Parse `claude -p /usage`. The output is meant for people, so anything that
 * doesn't match is kept as-is rather than dropped: an empty `windows` tells
 * the caller to show the raw text instead.
 */
export function parseClaudeUsage(text: string): ParsedUsage {
  const lines = text.split('\n').map((l) => l.trimEnd());
  const windows: UsageWindow[] = [];
  let source: string | undefined;
  let detailsStart = -1;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    const m = WINDOW_RE.exec(trimmed);
    if (m) {
      windows.push({
        label: m[2] ? `本周（${m[2] === 'all models' ? '全部模型' : m[2]}）` : '当前 5 小时窗口',
        percent: Number(m[3]),
        resets: formatReset(m[4] ?? ''),
      });
    } else if (/^You are currently using/i.test(trimmed)) {
      source = trimmed;
    } else if (detailsStart === -1 && /^What's contributing/i.test(trimmed)) {
      detailsStart = i;
    }
  });
  const details = detailsStart === -1 ? '' : lines.slice(detailsStart).join('\n').trim();
  return { ...(source ? { source } : {}), windows, details };
}

/** `Oct 6 at 8:59am (Asia/Shanghai)` → `10-06 08:59`. */
export function formatReset(raw: string): string {
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(raw.trim());
  if (!m) return raw.trim();
  const month = MONTHS.indexOf(m[1]!) + 1;
  if (month === 0) return raw.trim();
  let hour = Number(m[3]) % 12;
  if (m[5]!.toLowerCase() === 'pm') hour += 12;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(month)}-${pad(Number(m[2]))} ${pad(hour)}:${m[4] ?? '00'}`;
}

/** Markdown body for the `/usage` card. */
export function usageMarkdown(parsed: ParsedUsage, raw: string): string {
  if (parsed.windows.length === 0) {
    return ['没能解析 Claude 的用量输出，原文如下：', '```', raw.trim().slice(0, 2000), '```'].join('\n');
  }
  const lines = parsed.windows.map(
    (w) =>
      `${w.percent >= 80 ? '⚠️ ' : ''}**${w.label}**：${bar(w.percent)} **${w.percent}%** · ${w.resets} 重置`,
  );
  if (parsed.details) {
    lines.push('', '**用量构成**（本机会话估算，不含其他设备和 claude.ai）', '```', parsed.details.slice(0, 1500), '```');
  }
  return lines.join('\n');
}

function bar(percent: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return `${'▓'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

/**
 * Run Claude Code's own `/usage`. It is answered locally from the plan's
 * usage API — no model turn, so asking costs no quota — and
 * `--no-session-persistence` keeps it out of the session history.
 */
export function readClaudeUsage(binary = 'claude', timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, ['-p', '--no-session-persistence', '/usage'], {
      cwd: tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      reject(new Error(`claude /usage 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude /usage 退出码 ${code}：${(err || out).trim().slice(0, 300)}`));
    });
  });
}
