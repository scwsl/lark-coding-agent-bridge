import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readThreadUsageBaseline, subtractBaseline } from '../../../src/agent/codex/thread-usage';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const tokenCount = (input: number) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 1 } } } });

describe('Codex thread usage baseline', () => {
  it('takes the last complete totals from the thread rollout, wherever it is filed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-home-'));
    dirs.push(home);
    const day = join(home, 'sessions', '2026', '09', '28');
    await mkdir(day, { recursive: true });
    await writeFile(join(day, 'rollout-x-other-thread.jsonl'), tokenCount(999));
    // A torn final line (Codex mid-write) is skipped, not fatal.
    await writeFile(join(day, 'rollout-2026-09-28T10-00-00-t-1.jsonl'), [tokenCount(100), tokenCount(250), '{"type":"event_msg","payload":{"type":"token_cou'].join('\n'));

    expect(await readThreadUsageBaseline(home, 't-1')).toEqual({
      inputTokens: 250,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
    });
    expect(await readThreadUsageBaseline(home, 'missing')).toBeUndefined();
    expect(await readThreadUsageBaseline(join(home, 'nope'), 't-1')).toBeUndefined();
  });

  it('never reports negative usage', () => {
    expect(
      subtractBaseline(
        { type: 'usage', inputTokens: 10, outputTokens: 5 },
        { inputTokens: 20, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      ),
    ).toEqual({ type: 'usage', inputTokens: 0, outputTokens: 3, cachedInputTokens: undefined, reasoningOutputTokens: undefined });
  });
});
