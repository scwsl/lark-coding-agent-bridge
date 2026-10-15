#!/usr/bin/env node
// Claude Code PreToolUse hook installed by lark-channel-bridge on runs that
// need approval (a non-admin is driving the agent). Forwards the tool call to
// the bridge over its local approval socket and blocks until the bridge
// answers allow / deny. Usage: approval-hook.mjs <socketPath> <gateToken>
//
// Fails closed: if the bridge can't be reached or answers garbage, the tool
// call is denied.
import { createConnection } from 'node:net';

const [socketPath, token] = process.argv.slice(2);

function answer(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return answer('deny', 'lark-channel-bridge: unreadable hook input');
  }
  if (!socketPath || !token) return answer('deny', 'lark-channel-bridge: approval hook misconfigured');
  const socket = createConnection(socketPath);
  let reply = '';
  socket.setEncoding('utf8');
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ token, tool: event.tool_name, input: event.tool_input ?? {} })}\n`);
  });
  socket.on('data', (chunk) => {
    reply += chunk;
    const nl = reply.indexOf('\n');
    if (nl === -1) return;
    try {
      const { decision, reason } = JSON.parse(reply.slice(0, nl));
      answer(decision === 'allow' ? 'allow' : 'deny', String(reason ?? ''));
    } catch {
      answer('deny', 'lark-channel-bridge: unreadable approval answer');
    }
  });
  socket.on('error', (err) => answer('deny', `lark-channel-bridge unreachable: ${err.message}`));
  socket.on('close', () => answer('deny', 'lark-channel-bridge closed the approval request'));
});
