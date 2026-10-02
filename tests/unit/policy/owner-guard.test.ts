import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import {
  bridgeRoot,
  claudeGuardArgs,
  isOwnerBatch,
  ownerOnlyGuard,
} from '../../../src/policy/owner-guard';

const HOME = '/Users/someone';
const LC = `${HOME}/.lark-channel`;
const ROOT = bridgeRoot();
const guard = ownerOnlyGuard({ larkChannelHome: LC, home: HOME, root: ROOT });

/** Run the hook the way Claude does: tool call JSON on stdin, rules in env. */
function hook(command: string, toolName = 'Bash'): { code: number | null; stderr: string } {
  const res = spawnSync(process.execPath, [guard.hookScript], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    env: { ...process.env, HOME, LARK_CHANNEL_GUARD: JSON.stringify(guard.rules) },
    encoding: 'utf8',
  });
  return { code: res.status, stderr: res.stderr };
}

describe('owner-only guard: Bash hook', () => {
  it.each([
    ['restarting the bridge', 'node ~/x/bin/lark-channel-bridge.mjs restart --profile claude'],
    ['launchd', 'launchctl kickstart -k gui/501/com.bridge'],
    ['the restart helper', '~/.local/bin/bridge-restart-when-idle'],
    ['the bridge source', `git -C ${ROOT} log -1`],
    ['bridge secrets', 'cat ~/.lark-channel/config.json'],
    ['bridge logs', 'tail $HOME/.lark-channel/profiles/claude/logs/bridge.jsonl'],
    ['in-place edits of the agent instructions', 'sed -i "" s/a/b/ ~/.claude/CLAUDE.md'],
    ['appending to the agent instructions', 'echo rule >> ~/.claude/CLAUDE.md'],
    ['writing a skill', 'tee ~/.claude/skills/x/SKILL.md < /tmp/a'],
    ['deleting memory', 'rm -rf ~/.claude/projects/p/memory'],
    ['cd then write', 'cd ~/.claude/skills/x && echo hi > SKILL.md'],
    ['a launch agent', 'cp evil.plist ~/Library/LaunchAgents/'],
  ])('refuses %s', (_label, command) => {
    const res = hook(command);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('仅限主人本人');
  });

  it.each([
    ['running a skill script', 'python3 ~/.claude/skills/alphaess-tcpdump/scripts/capture.py --sn AL1 > /tmp/out.txt'],
    ['reading an attachment', 'file ~/.lark-channel/profiles/claude/media/abc.jpg'],
    ['listing memory', 'ls ~/.claude/projects'],
    ['ordinary work', 'grep -r foo /tmp/repo > /tmp/hits.txt && wc -l /tmp/hits.txt'],
    ['cd into a skill to run it', 'cd ~/.claude/skills/x && python3 run.py'],
  ])('allows %s', (_label, command) => {
    expect(hook(command).code).toBe(0);
  });

  it('ignores tools other than Bash', () => {
    expect(hook('rm -rf ~/.claude', 'Read').code).toBe(0);
  });
});

describe('owner-only guard: Claude flags', () => {
  it('denies edits to every fenced path and reads of bridge secrets', () => {
    const { args, env } = claudeGuardArgs(guard, '/usr/local/bin/node');
    expect(args[0]).toBe('--disallowedTools');
    expect(args).toContain(`Edit(/${join(HOME, '.claude', 'CLAUDE.md')})`);
    expect(args).toContain(`Edit(/${ROOT}/**)`);
    expect(args).toContain(`Read(/${LC}/config.json*)`);
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
      `"/usr/local/bin/node" "${guard.hookScript}"`,
    );
    expect(JSON.parse(env.LARK_CHANNEL_GUARD!)).toEqual(guard.rules);
  });

  it('finds the bridge package root', () => {
    expect(ROOT.endsWith('scwsl-bridge') || ROOT.length > 1).toBe(true);
    expect(guard.hookScript).toBe(join(ROOT, 'bin', 'bridge-bash-guard.mjs'));
  });
});

describe('isOwnerBatch', () => {
  const controls = { botOwnerId: 'ou_owner', ownerRefreshState: 'ok' as const };
  const msg = (senderId: string): NormalizedMessage => ({ senderId }) as NormalizedMessage;
  const notBot = (): boolean => false;

  it('is true only when every message is from the owner', () => {
    expect(isOwnerBatch(controls, [msg('ou_owner')], notBot)).toBe(true);
    expect(isOwnerBatch(controls, [msg('ou_owner'), msg('ou_other')], notBot)).toBe(false);
    expect(isOwnerBatch(controls, [msg('ou_other')], notBot)).toBe(false);
    expect(isOwnerBatch(controls, [], notBot)).toBe(false);
  });

  it('never trusts a bot, or an owner not yet known', () => {
    expect(isOwnerBatch(controls, [msg('ou_owner')], () => true)).toBe(false);
    expect(
      isOwnerBatch({ ...controls, ownerRefreshState: 'unknown' }, [msg('ou_owner')], notBot),
    ).toBe(false);
  });
});
