import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveChangelogLines, archiveNotes, observeNotes } from '../../../src/dream/archive.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lcb-archive-'));
  for (const [path, body] of [
    ['notes/oc_1/build.md', '- [a1] 构建用 mvnd'],
    ['notes/oc_1/dream-review.md', '- [r1] 待确认'],
    ['notes/oc_1/Weird Name.md', '- [w1] 读不到的名字'],
    ['notes/external/kube.md', '- [k1] 集群在 aus'],
  ] as const) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), body);
  }
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('observeNotes / archiveNotes', () => {
  it('hashes the notes recall can count, leaving review notes out', async () => {
    const notes = await observeNotes(dir);
    expect(notes.map((note) => note.key)).toEqual(['note:external/kube', 'note:oc_1/build']);
    expect(notes[1]?.hash).toMatch(/^[0-9a-f]{16}$/);
    await writeFile(join(dir, 'notes/oc_1/build.md'), '- [a1] 构建用 mvnd -T 10');
    expect((await observeNotes(dir))[1]?.hash).not.toBe(notes[1]?.hash);
  });

  it('moves notes under archive/notes/ and skips what is not a note', async () => {
    const result = await archiveNotes(dir, ['note:oc_1/build', 'note:oc_1/dream-review', 'note:oc_1/missing', 'note:../x']);
    expect(result).toEqual({ files: ['notes/oc_1/build.md', 'archive/notes/oc_1/build.md'], moved: ['oc_1/build'] });
    expect(await readFile(join(dir, 'archive/notes/oc_1/build.md'), 'utf8')).toContain('构建用 mvnd');
    expect(archiveChangelogLines(result.moved)).toEqual(['- 归档 `notes/oc_1/build.md` → `archive/notes/oc_1/build.md`（30 天没被读过、没改过）']);
  });
});
