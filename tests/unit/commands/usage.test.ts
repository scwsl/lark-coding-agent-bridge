import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatReset,
  parseClaudeUsage,
  readClaudeUsage,
  usageMarkdown,
} from '../../../src/commands/usage.js';

// Real `claude -p /usage` output (Claude Code 2.1.286), trimmed.
const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 14% used · resets Oct 2 at 11:39pm (Asia/Shanghai)
Current week (all models): 85% used · resets Oct 6 at 8:59am (Asia/Shanghai)
Current week (Fable): 0% used · resets Oct 6 at 9am (Asia/Shanghai)

What's contributing to your limits usage?
Last 24h · 558 requests · 2 sessions
  67% of your usage was at >150k context
`;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('/usage', () => {
  it('parses the limit windows and keeps the breakdown verbatim', () => {
    const parsed = parseClaudeUsage(SAMPLE);
    expect(parsed.windows).toEqual([
      { label: '当前 5 小时窗口', percent: 14, resets: '10-02 23:39' },
      { label: '本周（全部模型）', percent: 85, resets: '10-06 08:59' },
      { label: '本周（Fable）', percent: 0, resets: '10-06 09:00' },
    ]);
    expect(parsed.details).toContain('558 requests');
  });

  it('renders bars, flags windows close to the limit', () => {
    const md = usageMarkdown(parseClaudeUsage(SAMPLE), SAMPLE);
    expect(md).toContain('**当前 5 小时窗口**：▓░░░░░░░░░ **14%** · 10-02 23:39 重置');
    expect(md).toContain('⚠️ **本周（全部模型）**：▓▓▓▓▓▓▓▓▓░ **85%**');
  });

  it('falls back to the raw text when the format changes', () => {
    const md = usageMarkdown(parseClaudeUsage('Something new'), 'Something new');
    expect(md).toContain('没能解析');
    expect(md).toContain('Something new');
  });

  it('formats reset times, keeping unknown wording as-is', () => {
    expect(formatReset('Dec 31 at 12am (UTC)')).toBe('12-31 00:00');
    expect(formatReset('Jan 1 at 12:05pm')).toBe('01-01 12:05');
    expect(formatReset('in 3 hours')).toBe('in 3 hours');
  });

  it('runs claude -p /usage without saving a session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-test-'));
    dirs.push(dir);
    const fake = join(dir, 'claude');
    await writeFile(
      fake,
      `#!/bin/sh\n[ "$*" = "-p --no-session-persistence /usage" ] || { echo "bad args: $*" >&2; exit 2; }\ncat <<'__END__'\n${SAMPLE}__END__\n`,
      'utf8',
    );
    await chmod(fake, 0o755);
    await expect(readClaudeUsage(fake)).resolves.toBe(SAMPLE);
  });

  it('reports a failing claude with its message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-test-'));
    dirs.push(dir);
    const fake = join(dir, 'claude');
    await writeFile(fake, '#!/bin/sh\necho "Not logged in" >&2\nexit 1\n', 'utf8');
    await chmod(fake, 0o755);
    await expect(readClaudeUsage(fake)).rejects.toThrow('Not logged in');
  });
});
