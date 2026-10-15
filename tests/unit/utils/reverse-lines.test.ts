import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linesBackward } from '../../../src/utils/reverse-lines';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function file(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'reverse-lines-'));
  dirs.push(dir);
  const path = join(dir, 'f.jsonl');
  await writeFile(path, content);
  return path;
}

describe('linesBackward', () => {
  it('yields lines last-first across chunk boundaries, keeping multi-byte characters whole', async () => {
    const path = await file('第一行\n\nsecond 第二\nthird-三\n');
    const lines = [...linesBackward(path, { chunkSize: 4 })].map((b) => b.toString('utf8'));
    expect(lines).toEqual(['third-三', 'second 第二', '第一行']);
  });

  it('stops after maxBytes without yielding the cut line', async () => {
    const path = await file('aaaa\nbbbb\ncccc\n');
    const lines = [...linesBackward(path, { chunkSize: 3, maxBytes: 7 })].map((b) => b.toString('utf8'));
    expect(lines).toEqual(['cccc']);
  });
});
