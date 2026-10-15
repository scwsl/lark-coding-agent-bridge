import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = join(process.cwd(), '.github/scripts/release-notes.mjs');

function run(cwd: string, tag?: string) {
  const result = spawnSync(process.execPath, tag ? [script, tag] : [script], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('release notes script', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function fixture(version: string, changelog: string): string {
    dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
    return dir;
  }

  const changelog = [
    '# Changelog',
    '',
    '## v0.8.10 — 2026-12-01',
    '',
    '- not this one',
    '',
    '## v0.8.1 — 2026-11-01',
    '',
    '### Fixes',
    '- the right section',
    '',
    '## v0.8.0',
    '',
    '- older',
    '',
  ].join('\n');

  it('prints only the section for the tag, ignoring longer versions with the same prefix', () => {
    const result = run(fixture('0.8.1', changelog), 'v0.8.1');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('### Fixes\n- the right section\n');
  });

  it('reads the last section through the end of the file', () => {
    const result = run(fixture('0.8.0', changelog), 'v0.8.0');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('- older\n');
  });

  it('rejects a tag that does not match package.json', () => {
    const result = run(fixture('0.8.0', changelog), 'v0.8.1');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match package.json');
  });

  it('rejects a version without a changelog section', () => {
    const result = run(fixture('0.9.0', changelog), 'v0.9.0');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no "## v0.9.0" section');
  });

  it('rejects an empty section', () => {
    const result = run(fixture('0.9.0', '## v0.9.0\n\n## v0.8.0\n- older\n'), 'v0.9.0');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is empty');
  });

  it('requires a tag argument', () => {
    const result = run(fixture('0.8.0', changelog));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing tag');
  });

  it('has release notes for the version in package.json', () => {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    const result = run(process.cwd(), `v${version}`);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
