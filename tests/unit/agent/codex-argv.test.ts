import compactionCapture from '../../fixtures/codex-app-server-compaction-config.json';
import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../../../src/agent/codex/argv.js';

describe('Codex argv contract', () => {
  it.each([undefined, 'thread-old'])('sets auto-compaction for fresh/resumed exec (%s)', (threadId) => {
    const args = buildCodexArgs({ cwd: '/repo', sandbox: 'read-only', threadId, compactWindowTokens: compactionCapture.response.result.config.model_auto_compact_token_limit });
    const i = args.indexOf('model_auto_compact_token_limit=300000');
    expect(i).toBeGreaterThan(0);
    expect(args[i - 1]).toBe('-c');
    if (threadId) expect(i).toBeLessThan(args.indexOf('resume'));
  });
  it.each([undefined, 0, -1, NaN, Infinity, 1.5])('leaves native compaction defaults for invalid/unset window (%s)', (compactWindowTokens) => {
    expect(buildCodexArgs({ cwd: '/repo', sandbox: 'read-only', compactWindowTokens }).join(' ')).not.toContain('model_auto_compact_token_limit');
  });
  it('builds the fresh exec argv without putting the prompt in argv', () => {
    expect(buildCodexArgs({ cwd: '/repo', sandbox: 'read-only' })).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      '-',
    ]);
  });

  it('puts global flags before resume and resume-local flags after resume', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        threadId: 'thread-123',
      }),
    ).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      'resume',
      '--json',
      'thread-123',
      '-',
    ]);
  });

  it('forwards the reasoning effort as a config override on both fresh and resumed runs', () => {
    const fresh = buildCodexArgs({ cwd: '/repo', sandbox: 'read-only', model: 'gpt-6-sol', effort: 'xhigh' });
    expect(fresh.slice(0, 8)).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--model',
      'gpt-6-sol',
      '-c',
      'model_reasoning_effort="xhigh"',
    ]);
    const resumed = buildCodexArgs({ cwd: '/repo', sandbox: 'read-only', threadId: 't-1', effort: 'ultra' });
    expect(resumed.indexOf('model_reasoning_effort="ultra"')).toBeLessThan(resumed.indexOf('resume'));
  });

  it('omits the effort override when unset, and never quotes an unexpected value into argv', () => {
    expect(buildCodexArgs({ cwd: '/repo', sandbox: 'read-only' }).join(' ')).not.toContain('model_reasoning_effort');
    expect(
      buildCodexArgs({ cwd: '/repo', sandbox: 'read-only', effort: 'high" -c x="y' }).join(' '),
    ).not.toContain('model_reasoning_effort');
  });

  it('allows danger-full-access for Claude bridge parity', () => {
    expect(buildCodexArgs({ cwd: '/repo', sandbox: 'danger-full-access' })).toContain(
      'danger-full-access',
    );
  });

  it('separates image flags from stdin prompt for fresh exec', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        images: ['/tmp/image.png'],
      }),
    ).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      '--image',
      '/tmp/image.png',
      '--',
      '-',
    ]);
  });

  it('passes resume image flags after the resume subcommand', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        threadId: 'thread-123',
        images: ['/tmp/image.png'],
      }),
    ).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      'resume',
      '--json',
      '--image',
      '/tmp/image.png',
      'thread-123',
      '-',
    ]);
  });

  it('forwards the selected model as a global --model flag before resume', () => {
    const args = buildCodexArgs({
      cwd: '/repo',
      sandbox: 'workspace-write',
      threadId: 'thread-123',
      model: 'gpt-5-codex',
    });
    expect(args).toContain('--model');
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('gpt-5-codex');
    // Global flag: must come before the `resume` subcommand.
    expect(modelIdx).toBeLessThan(args.indexOf('resume'));
  });

  it('omits --model when no model is selected', () => {
    expect(buildCodexArgs({ cwd: '/repo', sandbox: 'read-only' })).not.toContain('--model');
  });

  it('can explicitly ignore the user config when profile isolation asks for it', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'read-only',
        ignoreUserConfig: true,
      }),
    ).toContain('--ignore-user-config');
  });

});
