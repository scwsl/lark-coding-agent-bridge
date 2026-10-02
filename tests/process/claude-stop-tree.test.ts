import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import { isAlive, listDescendants } from '../../src/agent/process-tree.js';

const dirs: string[] = [];

describe.skipIf(process.platform === 'win32')('stopping a Claude run', () => {
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('also ends the commands the agent started, even ones ignoring SIGTERM', async () => {
    const fake = await createHangingClaude();
    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-tree',
      prompt: 'hang',
      cwd: fake.dir,
      stopGraceMs: 300,
    });
    const shellPid = await readPid(fake.shellPidFile);
    const sleepPid = await readPid(fake.sleepPidFile);
    expect(run.pid).toBeDefined();
    expect(listDescendants(run.pid!)).toEqual(expect.arrayContaining([shellPid, sleepPid]));

    await run.stop();

    await expectGone(shellPid);
    await expectGone(sleepPid);
    expect(await run.waitForExit(1_000)).toBe(true);
  });
});

/**
 * A "claude" that starts a shell which starts `sleep`, both ignoring SIGTERM
 * — a stand-in for a hung tool command — and then never finishes.
 */
async function createHangingClaude(): Promise<{
  path: string;
  dir: string;
  shellPidFile: string;
  sleepPidFile: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-stop-tree-'));
  dirs.push(dir);
  const path = join(dir, 'fake-claude.mjs');
  const shellPidFile = join(dir, 'shell.pid');
  const sleepPidFile = join(dir, 'sleep.pid');
  const script = `trap '' TERM; sleep 300 & echo $! > ${sleepPidFile}; wait`;
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const child = spawn("/bin/sh", ["-c", ${JSON.stringify(script)}], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(shellPidFile)}, String(child.pid));`,
      'process.stdin.resume();',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, shellPidFile, sleepPidFile };
}

async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const text = await readFile(file, 'utf8').catch(() => '');
    const pid = Number(text.trim());
    if (pid > 0) return pid;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no pid in ${file}`);
}

/** Killed processes linger as zombies until reaped; give init a moment. */
async function expectGone(pid: number): Promise<void> {
  for (let i = 0; i < 100 && isAlive(pid); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(isAlive(pid), `pid ${pid} still alive`).toBe(false);
}
