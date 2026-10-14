#!/usr/bin/env node
// Claude Code PreToolUse hook that lark-channel-bridge installs on runs started
// by someone other than the bot owner. Two fences:
//
// 1. Owner-only areas (`rules`): the bridge CLI and launchd, the bridge's
//    source and private data, and writes into the agent's own instructions,
//    memory and skills.
// 2. File scope: inside the owner's home, only `allowedRoots` (the projects
//    opened to others, the run's workspace, skills, attachments) may be read
//    or written. Everything else under home is the owner's alone; paths
//    outside home (system dirs, /tmp) are not fenced. Read-only projects
//    (`access.guestReadOnlyRoots`) are allowed roots that also carry a
//    `write` rule: readable, but nothing may write into them.
//
// Config arrives in LARK_CHANNEL_GUARD as JSON:
//   { "home": "/Users/x",
//     "rules": [{ "path": "/abs", "bash": "any" | "write", "allow": ["regex"] }],
//     "allowedRoots": ["/abs", …], "allowPatterns": ["regex", …],
//     "deniedCommands": ["regex", …] }
// `deniedCommands` are owner-only commands of this deployment (GitHub CLI,
// Jira writes, device control …), from `access.guestDeniedCommands`.
//
// Exit 2 with a reason on stderr blocks the call; Claude shows the reason to
// the model. String matching, not a sandbox: it stops the plain ways of doing
// it, and the agent is told the same rules in its system prompt.

import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

const CONTROL = /\blark-channel-bridge\b|\blaunchctl\b|bridge-restart-when-idle|bridge_watchdog/;
const WRITE_VERB =
  /^(?:sudo\s+)?(?:\w+=\S*\s+)*(?:cp|mv|rm|rmdir|ln|chmod|chown|touch|mkdir|install|truncate|rsync|unlink|tee|patch|git|dd)\b/;
// Git subcommands that only read the repository, so read-only projects
// (`access.guestReadOnlyRoots`) can still be browsed with git.
const GIT_READ =
  /^(?:sudo\s+)?(?:\w+=\S*\s+)*git\s+(?:(?:-C|-c)\s+\S+\s+|--no-pager\s+|--(?:git-dir|work-tree)=\S+\s+)*(?:log|show|diff|grep|blame|ls-files|ls-tree|cat-file|rev-parse|rev-list|describe|shortlog|merge-base|name-rev)\b/;
const IN_PLACE = /\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i/;
const RELATIVE_REDIRECT = /(?:^|[^<>&\d])>{1,2}\s*(?!\/|&|\$|~)\S/;
const BARE_CD = /(?:^|[;&|]\s*)cd\s*(?:$|[;&|])/;
const FILE_TOOLS = {
  Read: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path', 'pattern'],
  Grep: ['path', 'glob'],
};
const WRITING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(command, home) {
  return command
    .replace(/\$\{HOME\}|\$HOME\b/g, home)
    .replace(/(^|[\s'"=:(])~(?=\/|$|\s)/g, `$1${home}`);
}

function within(path, root) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Is `path` (absolute, resolved) open to a run the owner didn't start? */
function inScope(path, cfg) {
  const home = cfg.home;
  // Outside home: system dirs, /tmp, mounted volumes — not the owner's files.
  // Home itself and its ancestors ("/", "/Users") would expose all of it.
  if (!within(path, home) && !within(home, path)) return true;
  if ((cfg.allowedRoots ?? []).some((root) => within(path, root))) return true;
  return (cfg.allowPatterns ?? []).some((re) => new RegExp(`^${re}`).test(path));
}

/** Path-like words of a shell command, resolved against `cwd`. */
function commandPaths(cmd, cwd) {
  const out = [];
  for (const raw of cmd.split(/[\s;|&<>()'"`=,]+/)) {
    const token = raw.replace(/^[{[]+|[}\],:]+$/g, '');
    if (!token || /^[a-z][a-z0-9+.-]*:\/\//i.test(token)) continue;
    if (!(token.startsWith('/') || token.startsWith('.') || token.includes('/'))) continue;
    if (token.startsWith('-')) continue;
    out.push(isAbsolute(token) ? resolve(token) : resolve(cwd, token));
  }
  return out;
}

/** Does `segment` mention `rule.path` outside its allowed sub-paths? */
function mentions(segment, rule) {
  let from = 0;
  for (;;) {
    const at = segment.indexOf(rule.path, from);
    if (at === -1) return false;
    const rest = segment.slice(at);
    const allowed = (rule.allow ?? []).some((re) => new RegExp(`^${re}`).test(rest));
    if (!allowed) return true;
    from = at + rule.path.length;
  }
}

function isWriteVerb(trimmed) {
  return (WRITE_VERB.test(trimmed) && !GIT_READ.test(trimmed)) || IN_PLACE.test(trimmed);
}

function writesInto(segment, rule) {
  const trimmed = segment.trim();
  if (isWriteVerb(trimmed)) return true;
  return new RegExp(`>{1,2}\\s*['"]?${escapeRe(rule.path)}`).test(segment);
}

// `cat > notes.md <<'EOF' … EOF` only writes its body to a file: the quoted
// delimiter turns off expansion and nothing runs it, so prose such as
// "SEA / EUR" in there is not a path. Bodies fed to anything else
// (`bash <<'EOF'`, `cat <<'EOF' | sh`) or left unquoted (`$(…)` expands) stay checked.
const HEREDOC = /^([^\n]*<<-?[ \t]*(['"])([A-Za-z_][\w-]*)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*$/gm;

function isDataSink(header) {
  const segment = header.split(/&&|\|\||;/).find((s) => s.includes('<<')) ?? '';
  return /^\s*(?:cat|tee)\b/.test(segment) && !segment.includes('|');
}

function stripDataHeredocs(cmd) {
  return cmd.replace(HEREDOC, (whole, header) => (isDataSink(header) ? header : whole));
}

function decideBash(command, cfg, cwd) {
  const full = normalize(String(command ?? ''), cfg.home);
  if (CONTROL.test(full)) return '这条命令会控制 bridge 进程（启停、重启或 launchd）';
  for (const re of cfg.deniedCommands ?? []) {
    if (new RegExp(re).test(full)) return '这条命令属于仅限主人的操作';
  }
  const cmd = stripDataHeredocs(full);
  let cdInto = null;
  for (const segment of cmd.split(/&&|\|\||;|\||\n/)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    // `cd <protected> && echo x > file` writes there without naming it again.
    if (cdInto && (isWriteVerb(trimmed) || RELATIVE_REDIRECT.test(trimmed))) {
      return `这条命令会改动 ${cdInto.path}`;
    }
    for (const rule of cfg.rules ?? []) {
      if (!mentions(segment, rule)) continue;
      if (rule.bash === 'any') return `这条命令会读取或改动 ${rule.path}`;
      if (/^cd\s/.test(trimmed)) cdInto = rule;
      else if (writesInto(segment, rule)) return `这条命令会改动 ${rule.path}`;
    }
  }
  if (BARE_CD.test(cmd)) return '这条命令会进入主人的主目录';
  for (const path of commandPaths(cmd, cwd)) {
    if (!inScope(path, cfg)) return `这条命令会访问未对外开放的位置 ${path}`;
  }
  return null;
}

function decideFile(toolName, input, cfg, cwd) {
  for (const key of FILE_TOOLS[toolName] ?? []) {
    const value = input?.[key];
    if (typeof value !== 'string' || !value) continue;
    const expanded = normalize(value, cfg.home);
    // A glob pattern is only a location when it is absolute.
    if (key === 'pattern' || key === 'glob') {
      if (!isAbsolute(expanded)) continue;
    }
    const path = resolve(cwd, expanded);
    if (!inScope(path, cfg)) return `访问的位置未对外开放：${path}`;
    if (WRITING_TOOLS.has(toolName)) {
      for (const rule of cfg.rules ?? []) {
        if (within(path, rule.path)) return `这个位置不能改动：${rule.path}`;
      }
    }
  }
  return null;
}

/** Why the tool call is refused, or null when it may run. */
export function decide(toolName, input, cfg, cwd = process.cwd()) {
  const config = { ...cfg, home: cfg.home ?? homedir() };
  if (toolName === 'Bash') return decideBash(input?.command, config, cwd);
  if (toolName in FILE_TOOLS) return decideFile(toolName, input, config, cwd);
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return 0;
  }
  let cfg = {};
  try {
    cfg = JSON.parse(process.env.LARK_CHANNEL_GUARD ?? '{}');
  } catch {
    cfg = {};
  }
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const reason = decide(input?.tool_name, input?.tool_input, cfg, cwd);
  if (!reason) return 0;
  process.stderr.write(
    `${reason}。本次任务不是 bot 主人发起的，这部分仅限主人本人。请停止这一步，并告诉用户这部分内容不对外开放。\n`,
  );
  return 2;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().then((code) => process.exit(code));
}

