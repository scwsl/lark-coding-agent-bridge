import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseClaudeUsage, readClaudeQuota } from '../../../src/agent/claude/quota.js';
import { parseCodexRateLimits, readCodexQuota } from '../../../src/agent/codex/quota.js';
import { fullestQuotaWindow } from '../../../src/agent/quota.js';

const FIXTURES = join(__dirname, '..', '..', 'fixtures');
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lcb-quota-'));
  dirs.push(dir);
  return dir;
}

async function script(dir: string, name: string, body: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

describe('Claude quota', () => {
  it('reads the session and all-model weekly windows from a real /usage sample', async () => {
    const windows = parseClaudeUsage(await readFile(join(FIXTURES, 'claude-usage.txt'), 'utf8'));
    expect(windows).toEqual([
      { label: '5 小时窗口', usedPercent: 4, resets: 'Oct 14, 3:19am (Asia/Shanghai)' },
      { label: '本周', usedPercent: 50, resets: 'Oct 18, 2:59pm (Asia/Shanghai)' },
    ]);
    expect(fullestQuotaWindow({ windows })).toMatchObject({ label: '本周', usedPercent: 50 });
  });

  it('runs `claude -p /usage` and says nothing when the CLI cannot answer', { skip: process.platform === 'win32', timeout: 20_000 }, async () => {
    const dir = await tmp();
    const sample = await readFile(join(FIXTURES, 'claude-usage.txt'), 'utf8');
    const ok = await script(
      dir,
      'claude-ok',
      `const args = process.argv.slice(2);\nif (args.join(' ') !== '-p /usage') process.exit(3);\nprocess.stdout.write(${JSON.stringify(sample)});\n`,
    );
    expect((await readClaudeQuota({ cwd: dir }, ok))?.windows).toHaveLength(2);
    const broken = await script(dir, 'claude-broken', 'console.log("Not logged in"); process.exit(1);\n');
    expect(await readClaudeQuota({ cwd: dir }, broken)).toBeUndefined();
  });
});

describe('Codex quota', () => {
  it('reads the 5-hour and weekly windows from a real account/rateLimits/read result', async () => {
    const reading = parseCodexRateLimits(JSON.parse(await readFile(join(FIXTURES, 'codex-rate-limits.json'), 'utf8')));
    expect(reading).toEqual({
      windows: [
        { label: '5 小时窗口', usedPercent: 0, resets: expect.any(String) },
        { label: '本周', usedPercent: 0, resets: expect.any(String) },
      ],
    });
  });

  it('treats a reached limit as a full account', () => {
    const reading = parseCodexRateLimits({
      ordinaryUsageAllowed: true,
      rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 }, rateLimitReachedType: 'primary' },
    });
    expect(reading?.blocked).toBe(true);
    expect(fullestQuotaWindow(reading!)).toMatchObject({ usedPercent: 100 });
    expect(parseCodexRateLimits(null)).toBeUndefined();
  });

  it('asks app-server for the limits only — never a reset credit — in the profile CODEX_HOME', { skip: process.platform === 'win32', timeout: 20_000 }, async () => {
    const dir = await tmp();
    const log = join(dir, 'calls.jsonl');
    const result = await readFile(join(FIXTURES, 'codex-rate-limits.json'), 'utf8');
    const codex = await script(
      dir,
      'codex',
      `const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME }) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: msg.method }) + '\\n');
  if (msg.method === 'initialize') console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.method === 'account/rateLimits/read') console.log(JSON.stringify({ id: msg.id, result: ${result.trim()} }));
});
`,
    );
    const reading = await readCodexQuota({ binaryPath: codex }, { cwd: dir, profileDir: join(dir, 'profile') });
    expect(reading?.windows).toHaveLength(2);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(calls[0]).toEqual({ args: ['app-server', '--listen', 'stdio://'], home: join(dir, 'profile', 'codex-home') });
    expect(calls.slice(1).map((call) => call.method)).toEqual(['initialize', 'initialized', 'account/rateLimits/read']);
  });
});
