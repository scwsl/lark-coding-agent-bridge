import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalSocketServer } from '../../../src/runtime/approval-socket';
import { ApprovalBroker, type ApprovalAllowlist, type PendingApproval } from '../../../src/runtime/approvals';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

/** Run the hook exactly as Claude Code does: a shell command, event JSON on stdin. */
function runHook(command: string, event: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('error', reject);
    child.on('exit', () => {
      try {
        resolve(JSON.parse(out));
      } catch (err) {
        reject(new Error(`hook printed ${JSON.stringify(out)}: ${String(err)}`));
      }
    });
    child.stdin.end(JSON.stringify(event));
  });
}

async function harness(allowlist?: ApprovalAllowlist) {
  const dir = await mkdtemp(join(tmpdir(), 'approval-sock-'));
  const announced: PendingApproval[] = [];
  const broker: ApprovalBroker = new ApprovalBroker({
    notifier: {
      async announce(p) {
        announced.push(p);
        // An admin answers right away: allow unless the command looks destructive.
        setTimeout(() => broker.decide(p.id, 'ou_boss', p.request.summary.includes('rm ') ? 'deny' : 'allow', true), 5);
      },
      async settled() {},
    },
    ...(allowlist ? { allowlist: () => allowlist } : {}),
  });
  const server = await ApprovalSocketServer.listen(broker, dir, 'test');
  cleanups.push(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const gate = broker.openGate({ actor: { id: 'ou_colleague' }, source: 'im', scopeId: 'c', agent: 'claude' });
  return { broker, server, gate, announced, dir };
}

const decisionOf = (out: Record<string, any>) => out.hookSpecificOutput?.permissionDecision;

// Runs the hook through /bin/sh like Claude Code does on POSIX; Windows uses a named pipe and cmd.
describe.skipIf(process.platform === 'win32')('Claude approval hook over the bridge socket', () => {
  it('allows what an admin allows and denies what an admin denies', async () => {
    const h = await harness();
    const command = h.server.hookCommand(h.gate.token);

    expect(decisionOf(await runHook(command, { tool_name: 'Bash', tool_input: { command: 'touch ok' } }))).toBe('allow');
    const denied = await runHook(command, { tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } });
    expect(decisionOf(denied)).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain('管理员拒绝');
    expect(h.announced.map((p) => p.request.summary)).toEqual(['touch ok', 'rm -rf /tmp/x']);
  });

  it('lets read-only tools through without bothering an admin', async () => {
    const h = await harness();
    const command = h.server.hookCommand(h.gate.token);
    expect(decisionOf(await runHook(command, { tool_name: 'Grep', tool_input: { pattern: 'x' } }))).toBe('allow');
    expect(decisionOf(await runHook(command, { tool_name: 'Bash', tool_input: { command: 'git log -3' } }))).toBe('allow');
    expect(h.announced).toEqual([]);
  });

  it("lets the profile's allowlisted commands through, and nothing riding along with them", async () => {
    const h = await harness({ allowCommands: ['python3 ~/.claude/skills/remote-tcpdump/scripts/tcpdump_client.py'], allowTools: [] });
    const command = h.server.hookCommand(h.gate.token);
    const capture = 'python3 ~/.claude/skills/remote-tcpdump/scripts/tcpdump_client.py capture --cluster eur --sn ALB1 --seconds 60';
    expect(decisionOf(await runHook(command, { tool_name: 'Bash', tool_input: { command: capture } }))).toBe('allow');
    expect(h.announced).toEqual([]);
    await runHook(command, { tool_name: 'Bash', tool_input: { command: `${capture}; touch x` } });
    expect(h.announced.map((p) => p.request.summary)).toEqual([`${capture}; touch x`]);
  });

  it('fails closed: a forged token or an unreachable bridge means deny', async () => {
    const h = await harness();
    expect(decisionOf(await runHook(h.server.hookCommand('forged'), { tool_name: 'Bash', tool_input: { command: 'ls' } }))).toBe('deny');
    const unreachable = h.server.hookCommand(h.gate.token).replace(h.server.path, join(h.dir, 'missing.sock'));
    expect(decisionOf(await runHook(unreachable, { tool_name: 'Bash', tool_input: { command: 'ls' } }))).toBe('deny');
  });
});
