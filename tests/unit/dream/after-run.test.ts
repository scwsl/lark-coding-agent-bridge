import { describe, expect, it } from 'vitest';
import { formatAfterRun, runAfterAutoCommands } from '../../../src/dream/after-run';

describe('runAfterAutoCommands', () => {
  it('reports the last output line and failures, in order', async () => {
    const results = await runAfterAutoCommands(['printf "Checking\\nUpdated to 2.1.321\\n"', 'echo boom >&2; exit 3']);
    expect(results[0]).toEqual({ command: results[0]!.command, ok: true, line: 'Updated to 2.1.321' });
    expect(results[1]!.ok).toBe(false);
    expect(results[1]!.line).toBe('boom');
    const text = formatAfterRun(results, '自动整理跑完');
    expect(text).toContain('✅');
    expect(text).toContain('❌');
  });

  it('finds commands in ~/.local/bin even with a bare PATH', async () => {
    const [r] = await runAfterAutoCommands(['echo "$PATH"'], { PATH: '/usr/bin:/bin' });
    expect(r!.line).toContain('/.local/bin');
  });
});
