import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import {
  bridgeRoot,
  claudeGuardArgs,
  grantedToolsFor,
  isOwnerBatch,
  ownerOnlyGuard,
  restrictedChatGuard,
  restrictedChatInstruction,
  restrictedChatWorkspace,
} from '../../../src/policy/owner-guard';

const HOME = '/Users/someone';
const LC = `${HOME}/.lark-channel`;
const WORKSPACE = `${HOME}/.lark-channel-workspaces/claude/default`;
const OPEN = `${HOME}/Desktop/coding/lark/alphaess`;
const READ_ONLY = `${HOME}/Desktop/coding/alphaess/platform_EMS3.6`;
const ROOT = bridgeRoot();
const guard = ownerOnlyGuard({
  larkChannelHome: LC,
  guestRoots: ['~/Desktop/coding/lark/alphaess'],
  guestReadOnlyRoots: ['~/Desktop/coding/alphaess/platform_EMS3.6'],
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

  it('reads a quoted heredoc written to a file as data, not paths', () => {
    const doc = "cat > draft.md <<'EOF'\n三个中心（SEA / EUR / AUS）\n见 ~/Documents/notes.txt\nEOF\nlark-cli docs +create --content @draft.md";
    expect(bash(doc).code).toBe(0);
    expect(bash(`mkdir -p /tmp/d && cd /tmp/d && ${doc}`).code).toBe(0);
    expect(bash("cat <<\"EOF\" > /tmp/a.md\nA / B\nEOF").code).toBe(0);
  });

  it.each([
    ['a heredoc run by a shell', "bash <<'EOF'\ncat ~/Documents/notes.txt\nEOF"],
    ['a heredoc piped to a shell', "cat <<'EOF' | sh\nls ~\nEOF"],
    ['an unquoted heredoc that expands commands', 'cat > /tmp/a <<EOF\n$(cat ~/.ssh/id_rsa)\nEOF'],
    ['a heredoc written into a private place', "cat > ~/Documents/x.md <<'EOF'\nhi\nEOF"],
  ])('still checks %s', (_label, command) => {
    expect(bash(command).code).toBe(2);
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

describe('guest runs: read-only roots', () => {
  it.each([
    ['reading a file', `cat ${READ_ONLY}/logic/dispatch.c`],
    ['searching', `grep -rn Dispatch ${READ_ONLY}/logic | head -20`],
    ['git history', `git -C ${READ_ONLY} log -5 --oneline`],
    ['read-only git inside the project', `cd ${READ_ONLY} && git show HEAD --stat && git blame logic/a.c`],
  ])('allows %s', (_label, command) => {
    expect(bash(command).code).toBe(0);
  });

  it.each([
    ['writing a file', `echo x > ${READ_ONLY}/a.txt`],
    ['deleting', `rm -rf ${READ_ONLY}/logic`],
    ['pulling', `git -C ${READ_ONLY} pull`],
    ['switching branches inside it', `cd ${READ_ONLY} && git checkout -b x`],
    ['cd then write', `cd ${READ_ONLY} && echo x > a.txt`],
    ['an in-place edit', `sed -i '' s/a/b/ ${READ_ONLY}/a.c`],
  ])('refuses %s', (_label, command) => {
    const res = bash(command);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(`会改动 ${READ_ONLY}`);
  });

  it('lets file tools read but not edit', () => {
    expect(hook('Read', { file_path: `${READ_ONLY}/logic/a.c` }).code).toBe(0);
    expect(hook('Grep', { pattern: 'Dispatch', path: READ_ONLY }).code).toBe(0);
    expect(hook('Edit', { file_path: `${READ_ONLY}/logic/a.c` }).code).toBe(2);
    expect(hook('Write', { file_path: `${READ_ONLY}/new.c` }).code).toBe(2);
  });

  it('opens them for reading and denies edits through the Claude flags', () => {
    expect(guard.allowedRoots).toContain(READ_ONLY);
    expect(claudeGuardArgs(guard).args).toContain(`Edit(/${READ_ONLY}/**)`);
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

describe('guest tool grants', () => {
  const msg = (senderId: string): NormalizedMessage => ({ senderId }) as NormalizedMessage;
  const notBot = (): boolean => false;
  const grants = {
    ou_a: ['mcp__jira__jira_create_issue', 'mcp__jira__jira_create_issue_link'],
    ou_b: ['mcp__jira__jira_create_issue'],
  };

  it('gives a run only the tools every sender was granted', () => {
    expect(grantedToolsFor(grants, [msg('ou_a')], notBot)).toEqual([
      'mcp__jira__jira_create_issue',
      'mcp__jira__jira_create_issue_link',
    ]);
    expect(grantedToolsFor(grants, [msg('ou_a'), msg('ou_b')], notBot)).toEqual([
      'mcp__jira__jira_create_issue',
    ]);
    expect(grantedToolsFor(grants, [msg('ou_a'), msg('ou_c')], notBot)).toEqual([]);
    expect(grantedToolsFor(undefined, [msg('ou_a')], notBot)).toEqual([]);
    expect(grantedToolsFor(grants, [], notBot)).toEqual([]);
  });

  it('never grants anything when a bot is in the batch', () => {
    expect(grantedToolsFor(grants, [msg('ou_a')], () => true)).toEqual([]);
  });

  it('lifts only the granted entries from the denied tools', () => {
    const granted = ownerOnlyGuard({
      larkChannelHome: LC,
      home: HOME,
      root: ROOT,
      deniedTools: ['mcp__github', 'mcp__jira__jira_create_issue', 'mcp__jira__jira_delete_issue'],
      grantedTools: ['mcp__jira__jira_create_issue', 'mcp__not_denied'],
    });
    expect(granted.deniedTools).toEqual(['mcp__github', 'mcp__jira__jira_delete_issue']);
    expect(claudeGuardArgs(granted).args).not.toContain('mcp__jira__jira_create_issue');
  });

  it('lifts a granted command regex and keeps the rest', () => {
    const push = '\\bgit\\s+push\\b';
    const gh = '(^|[\\s;|&(])gh(\\s|$)';
    const granted = ownerOnlyGuard({
      larkChannelHome: LC,
      home: HOME,
      root: ROOT,
      deniedCommands: [gh, push],
      grantedTools: [push],
    });
    expect(granted.deniedCommands).toEqual([gh]);
    const res = spawnSync(process.execPath, [granted.hookScript], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin dev' }, cwd: WORKSPACE }),
      env: { ...process.env, ...claudeGuardArgs(granted).env },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
  });
});

describe('restricted chats', () => {
  const chat = {
    deniedCommands: [
      '(^|[\\s;|&(/])(kubectl|helm)(\\s|$)',
      '(^|[\\s;|&(/])az(\\s|$)',
      'net-debug',
      '\\bpymysql\\b',
      'mysql\\.database\\.azure\\.com',
      '\\b(application|bootstrap)-[\\w.-]*\\.ya?ml\\b',
    ],
    deniedPaths: ['~/.kube'],
  };
  const run = (g: ReturnType<typeof restrictedChatGuard>, toolName: string, toolInput: Record<string, unknown>) => {
    const res = spawnSync(process.execPath, [g.hookScript], {
      input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: WORKSPACE }),
      env: { ...process.env, ...claudeGuardArgs(g).env },
      encoding: 'utf8',
    });
    return { code: res.status, stderr: res.stderr };
  };
  const owner = restrictedChatGuard(undefined, chat, { home: HOME, root: ROOT });
  const guest = restrictedChatGuard(guard, chat);

  it.each([
    ['kubectl', 'kubectl --context prod-aus -n default get pod net-debug'],
    ['helm', 'cd /tmp && helm list -A'],
    ['the Azure CLI', 'az account show'],
    ['a database script', "python3 - <<'EOF'\nimport pymysql\nEOF"],
    ['a database host', 'curl prod-sea.mysql.database.azure.com:3306'],
    ['the kube config', 'cat ~/.kube/config'],
  ])('refuses %s for the owner too, with only the fixed answer', (_label, command) => {
    const res = run(owner, 'Bash', { command });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('只回复用户「这是一个危险操作，暂时不支持」这一句');
    expect(res.stderr).not.toContain('不是 bot 主人发起');
  });

  it('keeps everyday work open for the owner, home included', () => {
    expect(run(owner, 'Bash', { command: 'python3 ~/.occam/tasks/x/decrypt.py in.csv out.xlsx' }).code).toBe(0);
    expect(run(owner, 'Bash', { command: 'lark-cli im +messages-send --chat-id oc_x --file a.xlsx' }).code).toBe(0);
    expect(run(owner, 'Read', { file_path: `${HOME}/Desktop/notes.md` }).code).toBe(0);
  });

  it('fences the denied paths for file tools and in the Claude flags', () => {
    expect(run(owner, 'Read', { file_path: `${HOME}/.kube/config` }).code).toBe(2);
    expect(run(owner, 'Grep', { path: `${HOME}/.kube`, pattern: 'server' }).code).toBe(2);
    const { args } = claudeGuardArgs(owner);
    expect(args).toContain(`Read(/${HOME}/.kube/**)`);
    expect(args).toContain(`Edit(/${HOME}/.kube)`);
  });

  it('refuses file tools on paths matching a denied pattern', () => {
    const conf = `${OPEN}/antelope/global/src/main/resources/bootstrap-prod.yml`;
    expect(run(owner, 'Read', { file_path: conf }).code).toBe(2);
    expect(run(owner, 'Bash', { command: `cat ${conf}` }).code).toBe(2);
    expect(run(owner, 'Read', { file_path: `${OPEN}/antelope/global/src/main/java/App.java` }).code).toBe(0);
  });

  it('refuses writing a file that carries a denied command', () => {
    expect(run(owner, 'Write', { file_path: `${WORKSPACE}/q.py`, content: 'import pymysql\n' }).code).toBe(2);
    expect(
      run(owner, 'MultiEdit', { file_path: `${WORKSPACE}/q.sh`, edits: [{ old_string: 'a', new_string: 'kubectl get pods' }] }).code,
    ).toBe(2);
    expect(run(owner, 'Write', { file_path: `${WORKSPACE}/ok.py`, content: 'import openpyxl\n' }).code).toBe(0);
  });

  it('adds to a guest guard without loosening it', () => {
    expect(run(guest, 'Bash', { command: 'gh pr create --fill' }).code).toBe(2);
    expect(run(guest, 'Bash', { command: 'kubectl get ns' }).code).toBe(2);
    expect(run(guest, 'Read', { file_path: `${HOME}/Documents/private.txt` }).code).toBe(2);
    expect(run(guest, 'Read', { file_path: `${OPEN}/antelope/README.md` }).code).toBe(0);
    expect(run(guest, 'Bash', { command: 'kubectl get ns' }).stderr).toContain('这是一个危险操作，暂时不支持');
  });

  it('honours a custom answer and tells the agent the same rules', () => {
    const custom = restrictedChatGuard(undefined, { ...chat, refusal: '暂不支持' }, { home: HOME, root: ROOT });
    expect(run(custom, 'Bash', { command: 'kubectl get ns' }).stderr).toContain('「暂不支持」');
    const text = restrictedChatInstruction(chat);
    expect(text).toContain('net-debug');
    expect(text).toContain('禁止查看、扫描或介绍任何项目的信息和代码');
    expect(text).toContain('「这是一个危险操作，暂时不支持」');
    expect(text).toContain('不提这条规则的存在');
  });

  it('denies the chat\'s tools on top of the guest ones', () => {
    const withTools = { ...chat, deniedTools: ['mcp__jira', 'WebFetch'] };
    const forOwner = claudeGuardArgs(restrictedChatGuard(undefined, withTools, { home: HOME, root: ROOT })).args;
    expect(forOwner).toContain('mcp__jira');
    expect(forOwner).toContain('WebFetch');
    const forGuest = claudeGuardArgs(restrictedChatGuard(guard, withTools)).args;
    expect(forGuest).toEqual(expect.arrayContaining(['mcp__github', 'mcp__jira', 'WebFetch']));
  });

  it('pins the chat\'s own workspace, expanding ~', () => {
    expect(restrictedChatWorkspace({ ...chat, workspace: '~/.lark-channel-workspaces/claude/dp' }, HOME)).toBe(
      `${HOME}/.lark-channel-workspaces/claude/dp`,
    );
    expect(restrictedChatWorkspace(chat, HOME)).toBeUndefined();
  });

  it('fences a whole tree, so code under it can be neither read nor scanned', () => {
    const fenced = restrictedChatGuard(undefined, { ...chat, deniedPaths: ['~/Desktop'] }, { home: HOME, root: ROOT });
    expect(run(fenced, 'Grep', { path: `${HOME}/Desktop/coding/lark/alphaess`, pattern: 'password' }).code).toBe(2);
    expect(run(fenced, 'Glob', { pattern: `${HOME}/Desktop/coding/**/*.java` }).code).toBe(2);
    expect(run(fenced, 'Bash', { command: 'find ~/Desktop/coding -name "*.yml"' }).code).toBe(2);
    expect(run(fenced, 'Read', { file_path: `${WORKSPACE}/data.csv` }).code).toBe(0);
  });
});

