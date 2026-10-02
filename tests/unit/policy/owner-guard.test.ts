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
const WORKSPACE = `${HOME}/.lark-channel-workspaces/claude/default`;
const OPEN = `${HOME}/Desktop/coding/lark/alphaess`;
const ROOT = bridgeRoot();
const guard = ownerOnlyGuard({
  larkChannelHome: LC,
  guestRoots: ['~/Desktop/coding/lark/alphaess'],
  workspace: WORKSPACE,
  home: HOME,
  root: ROOT,
  deniedTools: ['mcp__github', 'mcp__jira__jira_create_issue'],
  deniedCommands: [
    '(^|[\\s;|&(])gh(\\s|$)',
    '\\bgit\\s+push\\b',
    'alphaq-tool\\b[\\s\\S]*--tool[=\\s]+[\'"]?(restart_device|set_site_work_mode)\\b',
  ],
});
const { env } = claudeGuardArgs(guard);

/** Run the hook the way Claude does: the tool call on stdin, config in env. */
function hook(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd = WORKSPACE,
): { code: number | null; stderr: string } {
  const res = spawnSync(process.execPath, [guard.hookScript], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: res.status, stderr: res.stderr };
}
const bash = (command: string, cwd?: string) => hook('Bash', { command }, cwd);

describe('guest runs: owner-only areas', () => {
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
  ])('refuses %s', (_label, command) => {
    const res = bash(command);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('仅限主人本人');
  });

  it('refuses editing a skill with a file tool', () => {
    expect(hook('Edit', { file_path: `${HOME}/.claude/skills/x/SKILL.md` }).code).toBe(2);
  });
});

describe('guest runs: file scope', () => {
  it.each([
    ['the owner-only project', 'cat ~/Desktop/coding/lark/thing-hub/CLAUDE.md'],
    ['other desktop files', 'ls ~/Desktop/coding/alphaess/antelope'],
    ['personal files', 'head ~/Documents/notes.txt'],
    ['the home directory itself', 'ls ~'],
    ['a bare cd home', 'cd && ls'],
    ['the whole disk', 'find / -name "*.pem"'],
    ['a relative escape from the workspace', 'cat ../../../Desktop/coding/lark/thing-hub/README.md'],
    ['a script reading private files', `python3 -c "print(open('${HOME}/.ssh/id_rsa').read())"`],
  ])('refuses %s', (_label, command) => {
    const res = bash(command);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('不对外开放');
  });

  it.each([
    ['reading an opened project', 'cat ~/Desktop/coding/lark/alphaess/antelope/README.md'],
    ['working in an opened project', `cd ${OPEN}/antelope && git status && mvn -q test`],
    ['running a skill script', 'python3 ~/.claude/skills/alphaess-tcpdump/scripts/capture.py --sn AL1 > /tmp/out.txt'],
    ['reading an attachment', 'file ~/.lark-channel/profiles/claude/media/abc.jpg'],
    ['a tool on PATH dir', '~/.local/bin/alphaq-tool diagnose AL1'],
    ['ordinary work in tmp', 'grep -r foo /tmp/repo > /tmp/hits.txt && wc -l /tmp/hits.txt'],
    ['relative paths in the workspace', 'mkdir -p out/logs && ls ./out'],
    ['querying EFK', 'curl -s -u elastic:x "http://efk-prod-aus.alphaess.com:5601/api/console/proxy?path=logs-*/_search&method=POST"'],
  ])('allows %s', (_label, command) => {
    expect(bash(command).code).toBe(0);
  });

  it('applies the same scope to file tools', () => {
    expect(hook('Read', { file_path: `${HOME}/Desktop/coding/lark/thing-hub/CLAUDE.md` }).code).toBe(2);
    expect(hook('Grep', { pattern: 'x', path: `${HOME}/Desktop` }).code).toBe(2);
    expect(hook('Glob', { pattern: `${HOME}/Documents/**/*.md` }).code).toBe(2);
    expect(hook('Read', { file_path: `${OPEN}/antelope/pom.xml` }).code).toBe(0);
    expect(hook('Edit', { file_path: `${OPEN}/antelope/pom.xml` }).code).toBe(0);
    expect(hook('Read', { file_path: 'notes.md' }).code).toBe(0);
    expect(hook('Glob', { pattern: '**/*.java' }).code).toBe(0);
    expect(hook('Read', { file_path: '/tmp/x.log' }).code).toBe(0);
  });

  it('ignores tools that touch no files', () => {
    expect(hook('WebSearch', { query: 'rm -rf ~' }).code).toBe(0);
  });
});

describe('guest runs: owner-only commands of this deployment', () => {
  it.each([
    ['the GitHub CLI', 'gh pr create --fill'],
    ['pushing code', `cd ${OPEN}/antelope && git push origin dev`],
    ['controlling a device', '~/.local/bin/alphaq-tool --region aus --json --tool restart_device --sn AL1'],
  ])('refuses %s', (_label, command) => {
    const res = bash(command);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('仅限主人的操作');
  });

  it('still allows read-only diagnosis and local git', () => {
    expect(bash('~/.local/bin/alphaq-tool --region aus --json --tool ess_running_data --sn AL1').code).toBe(0);
    expect(bash(`cd ${OPEN}/antelope && git log -3`).code).toBe(0);
  });

  it('denies the configured tools outright', () => {
    const { args } = claudeGuardArgs(guard);
    expect(args).toContain('mcp__github');
    expect(args).toContain('mcp__jira__jira_create_issue');
  });
});

describe('guest runs: Claude flags', () => {
  it('denies edits to owner-only areas, reads of bridge secrets, and hooks every file tool', () => {
    const { args } = claudeGuardArgs(guard, '/usr/local/bin/node');
    expect(args[0]).toBe('--disallowedTools');
    expect(args).toContain(`Edit(/${join(HOME, '.claude', 'CLAUDE.md')})`);
    expect(args).toContain(`Edit(/${ROOT}/**)`);
    expect(args).toContain(`Read(/${LC}/config.json*)`);
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    expect(settings.hooks.PreToolUse[0].matcher).toBe(
      'Bash|Read|Edit|MultiEdit|Write|NotebookEdit|Glob|Grep',
    );
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
      `"/usr/local/bin/node" "${guard.hookScript}"`,
    );
  });

  it('opens the guest roots and the workspace, expanding ~', () => {
    expect(guard.allowedRoots).toContain(OPEN);
    expect(guard.allowedRoots).toContain(WORKSPACE);
    expect(guard.hookScript).toBe(join(ROOT, 'bin', 'bridge-guard.mjs'));
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
