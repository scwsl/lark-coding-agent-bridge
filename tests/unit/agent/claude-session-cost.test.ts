import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { restoredSessionCost } from '../../../src/agent/claude/session-cost.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function configDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-config-'));
  dirs.push(dir);
  return dir;
}

const costState = (sessionId: string, totalCostUSD: number) =>
  JSON.stringify({ type: 'cost-state', sessionId, totalCostUSD, totalAPIDuration: 1 });
const assistant = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

async function transcript(config: string, project: string, sessionId: string, lines: string[]): Promise<void> {
  await mkdir(join(config, 'projects', project), { recursive: true });
  await writeFile(join(config, 'projects', project, `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
}

describe('restoredSessionCost', () => {
  it('reads the last cost-state of the session Claude is about to resume', async () => {
    const config = await configDir();
    await transcript(config, '-Users-me--bridge-default', 'sess-1', [
      costState('sess-1', 147.63),
      assistant('hi'),
      costState('sess-1', 155.63),
      costState('other', 999),
      assistant('later turn without a saved total'),
    ]);

    expect(restoredSessionCost('sess-1', '/Users/me/.bridge/default', { CLAUDE_CONFIG_DIR: config })).toBe(155.63);
  });

  it('finds the transcript when the project dir name does not match the cwd', async () => {
    const config = await configDir();
    await transcript(config, 'shortened-name-1234', 'sess-2', [costState('sess-2', 3.5)]);

    expect(restoredSessionCost('sess-2', '/somewhere/else', { CLAUDE_CONFIG_DIR: config })).toBe(3.5);
  });

  it('scans back across chunk boundaries and split multi-byte text', async () => {
    const config = await configDir();
    const filler = assistant('电'.repeat(200_000)); // ~600 KB, several read chunks
    await transcript(config, 'p', 'sess-3', [costState('sess-3', 42.25), filler, filler]);

    expect(restoredSessionCost('sess-3', undefined, { CLAUDE_CONFIG_DIR: config })).toBe(42.25);
  });

  it('is undefined when there is no transcript or no saved total', async () => {
    const config = await configDir();
    await transcript(config, 'p', 'sess-4', [assistant('no cost yet')]);

    expect(restoredSessionCost('sess-4', undefined, { CLAUDE_CONFIG_DIR: config })).toBeUndefined();
    expect(restoredSessionCost('missing', undefined, { CLAUDE_CONFIG_DIR: config })).toBeUndefined();
    expect(restoredSessionCost('../etc/passwd', undefined, { CLAUDE_CONFIG_DIR: config })).toBeUndefined();
  });
});
