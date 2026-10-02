#!/usr/bin/env node
// Claude Code PreToolUse hook that lark-channel-bridge installs on runs started
// by someone other than the bot owner. It refuses Bash commands that would
// change the bridge or the agent's own setup: the bridge CLI and launchd, any
// use of the bridge's source tree or private data, and writes into the agent's
// instructions, memory and skills. File-editing tools are fenced separately
// with `Edit(...)` deny rules; this covers the shell.
//
// Rules arrive in LARK_CHANNEL_GUARD as JSON:
//   [{ "path": "/abs/dir", "bash": "any" | "write", "allow": ["regex", …] }]
// `any` refuses every mention of the path, `write` only writing into it.
// `allow` lists sub-paths (regex, anchored at the mention) that stay usable.
//
// Exit 2 with a reason on stderr blocks the call; Claude shows the reason to
// the model. String matching, not a sandbox: it stops the plain ways of doing
// it, and the agent is told the same rule in its system prompt.

import { homedir } from 'node:os';

const CONTROL = /\blark-channel-bridge\b|\blaunchctl\b|bridge-restart-when-idle|bridge_watchdog/;
const WRITE_VERB =
  /^(?:sudo\s+)?(?:\w+=\S*\s+)*(?:cp|mv|rm|rmdir|ln|chmod|chown|touch|mkdir|install|truncate|rsync|unlink|tee|patch|git|dd)\b/;
const IN_PLACE = /\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i/;
const RELATIVE_REDIRECT = /(?:^|[^<>&\d])>{1,2}\s*(?!\/|&|\$|~)\S/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(command, home) {
  return command
    .replace(/\$\{HOME\}|\$HOME\b/g, home)
    .replace(/(^|[\s'"=:(])~(?=\/|$|\s)/g, `$1${home}`);
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

function writesInto(segment, rule) {
  const trimmed = segment.trim();
  if (WRITE_VERB.test(trimmed) || IN_PLACE.test(trimmed)) return true;
  return new RegExp(`>{1,2}\\s*['"]?${escapeRe(rule.path)}`).test(segment);
}

/** Why `command` is refused, or null when it may run. */
export function decide(command, rules, home = homedir()) {
  const cmd = normalize(String(command ?? ''), home);
  if (CONTROL.test(cmd)) return '这条命令会控制 bridge 进程（启停、重启或 launchd）';
  let cdInto = null;
  for (const segment of cmd.split(/&&|\|\||;|\||\n/)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    // `cd <protected> && echo x > file` writes there without naming it again.
    if (cdInto && (WRITE_VERB.test(trimmed) || IN_PLACE.test(trimmed) || RELATIVE_REDIRECT.test(trimmed))) {
      return `这条命令会改动 ${cdInto.path}`;
    }
    for (const rule of rules) {
      if (!mentions(segment, rule)) continue;
      if (rule.bash === 'any') return `这条命令会读取或改动 ${rule.path}`;
      if (/^cd\s/.test(trimmed)) cdInto = rule;
      else if (writesInto(segment, rule)) return `这条命令会改动 ${rule.path}`;
    }
  }
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
  if (input?.tool_name !== 'Bash') return 0;
  let rules = [];
  try {
    rules = JSON.parse(process.env.LARK_CHANNEL_GUARD ?? '[]');
  } catch {
    rules = [];
  }
  const reason = decide(input?.tool_input?.command, rules);
  if (!reason) return 0;
  process.stderr.write(
    `${reason}。本次任务不是 bot 主人发起的，这类操作仅限主人本人。请拒绝这一步，并告诉用户这项操作仅限 bot 主人发起。\n`,
  );
  return 2;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().then((code) => process.exit(code));
}
