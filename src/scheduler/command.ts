import { CronParseError, describeCron, nextCronTime, parseCron } from './cron';
import { formatTime } from './runner';
import type { JobSchedule, ScheduledJob } from './types';

export const CRON_USAGE = [
  '**定时任务**',
  '',
  '`/cron add <时间> | <要做的事>` — 新建任务',
  '`/cron list` — 本会话的任务列表',
  '`/cron show <id>` — 任务详情',
  '`/cron run <id>` — 立刻跑一次（不影响排期）',
  '`/cron pause <id>` / `/cron resume <id>` — 暂停 / 恢复',
  '`/cron remove <id>` — 删除',
  '',
  '**时间写法**',
  '`0 9 * * 1-5`（标准 cron：分 时 日 月 周）、`@daily`、`@hourly`、`*/30 * * * *`',
  '`in 30m` / `in 2h` — 一次性，相对现在',
  '`at 09:30` / `at 2026-10-01 09:30` — 一次性，指定时刻',
  '',
  '加 `--continue` 让每次运行复用同一个会话（默认每次都是新会话）。',
  '',
  '例：`/cron add 0 9 * * 1-5 | 看一下昨天 CI 的失败并总结`',
].join('\n');

export interface ParsedAdd {
  schedule: JobSchedule;
  prompt: string;
  session: 'fresh' | 'continue';
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parse the argument string of `/cron add`.
 *
 * A `|` separates schedule from prompt and is the documented form. Without it
 * we still try to peel a schedule off the front, because typing the pipe is
 * easy to forget and "`/cron add @daily 看一下昨天的日志`" obviously means one
 * thing.
 */
export function parseAdd(raw: string, now: number = Date.now()): ParseResult<ParsedAdd> {
  let rest = raw.trim();
  let session: 'fresh' | 'continue' = 'fresh';
  for (;;) {
    const flag = /^(--continue|--fresh)\b\s*/.exec(rest);
    if (!flag) break;
    session = flag[1] === '--continue' ? 'continue' : 'fresh';
    rest = rest.slice(flag[0].length);
  }
  if (!rest) return { ok: false, error: '缺少时间与任务内容。' };

  const pipe = rest.indexOf('|');
  const split =
    pipe >= 0
      ? { spec: rest.slice(0, pipe).trim(), prompt: rest.slice(pipe + 1).trim() }
      : splitLeadingSpec(rest);
  if (!split) return { ok: false, error: '看不懂时间部分，用 `|` 把时间和任务内容分开会更稳妥。' };
  if (!split.spec) return { ok: false, error: '缺少时间部分。' };
  if (!split.prompt) return { ok: false, error: '缺少任务内容。' };

  const schedule = parseSchedule(split.spec, now);
  if (!schedule.ok) return schedule;
  return { ok: true, value: { schedule: schedule.value, prompt: split.prompt, session } };
}

/** Turn a schedule expression into a {@link JobSchedule}, validating it fires at all. */
export function parseSchedule(spec: string, now: number = Date.now()): ParseResult<JobSchedule> {
  const trimmed = spec.trim();
  const relative = /^in\s+(.+)$/i.exec(trimmed);
  if (relative) {
    const ms = parseDuration(relative[1]!);
    if (ms === undefined) return { ok: false, error: `看不懂的时长：${relative[1]}（试试 \`30m\`、\`2h\`）` };
    if (ms <= 0) return { ok: false, error: '时长要大于 0。' };
    return { ok: true, value: { kind: 'once', at: now + ms } };
  }

  const absolute = /^at\s+(.+)$/i.exec(trimmed);
  if (absolute) {
    const at = parseAbsoluteTime(absolute[1]!, now);
    if (at === undefined) return { ok: false, error: `看不懂的时刻：${absolute[1]}（试试 \`09:30\` 或 \`2026-10-01 09:30\`）` };
    if (at <= now) return { ok: false, error: '指定的时刻已经过去了。' };
    return { ok: true, value: { kind: 'once', at } };
  }

  try {
    const fields = parseCron(trimmed);
    if (!nextCronTime(fields, new Date(now))) {
      return { ok: false, error: `这个 cron 永远不会触发：${trimmed}` };
    }
    return { ok: true, value: { kind: 'cron', expr: trimmed } };
  } catch (err) {
    if (err instanceof CronParseError) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * Peel a schedule off the front of "`<spec> <prompt>`". Only the shapes that
 * cannot be confused with prose are accepted: an `@alias`, `in <duration>`,
 * `at <time>`, or exactly five cron fields.
 */
function splitLeadingSpec(input: string): { spec: string; prompt: string } | undefined {
  const tokens = input.split(/\s+/);
  const head = tokens[0] ?? '';
  if (head.startsWith('@')) {
    return { spec: head, prompt: tokens.slice(1).join(' ') };
  }
  if (/^in$/i.test(head)) {
    return { spec: tokens.slice(0, 2).join(' '), prompt: tokens.slice(2).join(' ') };
  }
  if (/^at$/i.test(head)) {
    // `at 2026-10-01 09:30` takes three tokens, `at 09:30` takes two.
    const size = /^\d{4}-\d{2}-\d{2}$/.test(tokens[1] ?? '') ? 3 : 2;
    return { spec: tokens.slice(0, size).join(' '), prompt: tokens.slice(size).join(' ') };
  }
  if (tokens.length > 5 && tokens.slice(0, 5).every(isCronField)) {
    return { spec: tokens.slice(0, 5).join(' '), prompt: tokens.slice(5).join(' ') };
  }
  return undefined;
}

function isCronField(token: string): boolean {
  return /^[\d*,\-/a-z]+$/i.test(token);
}

/** `90s`, `30m`, `2h`, `1d`, and concatenations like `1h30m`. */
export function parseDuration(input: string): number | undefined {
  const text = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return undefined;
  const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const pattern = /(\d+)([smhd])/g;
  let total = 0;
  let consumed = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    total += Number(match[1]) * unitMs[match[2]!]!;
    consumed += match[0].length;
  }
  if (consumed !== text.length || total === 0) return undefined;
  return total;
}

/** `09:30` (today, else tomorrow) or `2026-10-01 09:30` (exact, local time). */
export function parseAbsoluteTime(input: string, now: number): number | undefined {
  const text = input.trim();
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})[\sT]+(\d{1,2}):(\d{2})$/.exec(text);
  if (full) {
    const [, y, mo, d, h, mi] = full;
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0);
    return Number.isNaN(date.getTime()) ? undefined : date.getTime();
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!clock) return undefined;
  const [, h, mi] = clock;
  if (Number(h) > 23 || Number(mi) > 59) return undefined;
  const base = new Date(now);
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Number(h), Number(mi), 0, 0);
  // A time that already passed today means the next one — nobody schedules
  // something for a moment in the past.
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}

export function scheduleSummary(job: ScheduledJob): string {
  return job.schedule.kind === 'cron'
    ? `${describeCron(job.schedule.expr)}（\`${job.schedule.expr}\`）`
    : `单次 ${formatTime(job.schedule.at)}`;
}

/** {@link scheduleSummary} without markdown, for plain_text card fields. */
export function scheduleSummaryPlain(job: ScheduledJob): string {
  return job.schedule.kind === 'cron'
    ? `${describeCron(job.schedule.expr)}（${job.schedule.expr}）`
    : `单次 ${formatTime(job.schedule.at)}`;
}

/** One-line status used in the list card. */
export function jobStatusLine(job: ScheduledJob): string {
  if (!job.enabled) return '⏸ 已暂停';
  if (job.nextRunAt === undefined) return '⚠️ 未排期';
  return `下次 ${formatTime(job.nextRunAt)}`;
}

export function lastRunLine(job: ScheduledJob): string | undefined {
  if (!job.lastRun) return undefined;
  const { ok, finishedAt, error } = job.lastRun;
  return ok
    ? `上次 ${formatTime(finishedAt)} ✅`
    : `上次 ${formatTime(finishedAt)} ❌ ${error ?? ''}`.trim();
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
