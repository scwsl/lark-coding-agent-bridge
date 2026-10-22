import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeLogger, configureLogger, gcOldLogs } from '../../../src/core/logger';

const dirs: string[] = [];
afterEach(async () => {
  await closeLogger();
  configureLogger({ logsDir: undefined });
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function logsWith(files: Record<string, number>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'logger-gc-'));
  dirs.push(dir);
  for (const [name, size] of Object.entries(files)) await writeFile(join(dir, name), 'x'.repeat(size));
  return dir;
}

const NOW = new Date('2026-10-22T12:00:00+08:00');

async function bridgeLogs(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((n) => n.startsWith('bridge-')).sort();
}

describe('gcOldLogs', () => {
  it('drops files past the retention window and leaves other files alone', async () => {
    const dir = await logsWith({
      'bridge-20260901.jsonl': 10,
      'bridge-20261020.jsonl': 10,
      'bridge-20261022.jsonl': 10,
      'notes.txt': 10,
    });
    configureLogger({ logsDir: dir, retentionDays: 30, maxTotalBytes: 1_000_000, now: () => NOW });

    expect(await gcOldLogs()).toBe(1);
    expect(await bridgeLogs(dir)).toEqual(['bridge-20261020.jsonl', 'bridge-20261022.jsonl']);
    expect(await readdir(dir)).toContain('notes.txt');
  });

  it('deletes the oldest files once together they exceed the size cap, but never today’s', async () => {
    const dir = await logsWith({
      'bridge-20261019.jsonl': 400,
      'bridge-20261020.jsonl': 400,
      'bridge-20261021.jsonl': 400,
      'bridge-20261022.jsonl': 900,
    });
    configureLogger({ logsDir: dir, retentionDays: 30, maxTotalBytes: 1_000, now: () => NOW });

    expect(await gcOldLogs()).toBe(3);
    // Today's file alone is over the cap, and still stays.
    expect(await bridgeLogs(dir)).toEqual(['bridge-20261022.jsonl']);
  });

  it('stops deleting as soon as the rest fits', async () => {
    const dir = await logsWith({
      'bridge-20261019.jsonl': 400,
      'bridge-20261020.jsonl': 400,
      'bridge-20261021.jsonl': 400,
      'bridge-20261022.jsonl': 100,
    });
    configureLogger({ logsDir: dir, retentionDays: 30, maxTotalBytes: 1_000, now: () => NOW });

    expect(await gcOldLogs()).toBe(1);
    expect(await bridgeLogs(dir)).toEqual([
      'bridge-20261020.jsonl',
      'bridge-20261021.jsonl',
      'bridge-20261022.jsonl',
    ]);
  });

  it('cuts an oversized daemon log back to its newest whole lines, in place', async () => {
    const dir = await logsWith({});
    await mkdir(join(dir, 'daemon'));
    const line = (i: number) => `line ${String(i).padStart(7, '0')} ${'y'.repeat(100)}\n`;
    const big = Array.from({ length: 60_000 }, (_, i) => line(i)).join(''); // ~6.6 MB
    await writeFile(join(dir, 'daemon', 'daemon-stdout.log'), big);
    await writeFile(join(dir, 'daemon', 'daemon-stderr.log'), line(1));
    configureLogger({ logsDir: dir, retentionDays: 30, maxTotalBytes: 1_000_000, now: () => NOW });

    expect(await gcOldLogs()).toBe(0);
    const out = await readFile(join(dir, 'daemon', 'daemon-stdout.log'), 'utf8');
    expect((await stat(join(dir, 'daemon', 'daemon-stdout.log'))).size).toBeLessThanOrEqual(1024 * 1024 + 200);
    const lines = out.split('\n').filter(Boolean);
    expect(lines[0]).toContain('trimmed');
    // Whole lines only, ending with the newest one.
    expect(lines.slice(1).every((l) => /^line \d{7} y+$/.test(l))).toBe(true);
    expect(lines[lines.length - 1]).toBe(line(59_999).trim());
    // A small one is left as it is.
    expect(await readFile(join(dir, 'daemon', 'daemon-stderr.log'), 'utf8')).toBe(line(1));
  });
});
