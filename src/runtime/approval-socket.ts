import { existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../core/logger';
import { callNeedsApproval, summarizeToolCall, type ApprovalBroker } from './approvals';

/**
 * Local endpoint the Claude PreToolUse hook (`bin/approval-hook.mjs`) talks
 * to: one JSON line in (`{token, tool, input}`), one JSON line out
 * (`{decision, reason}`) once the broker has an answer. Unix socket in the
 * profile dir (0600 by umask of the owner's directory), named pipe on Windows.
 */
export class ApprovalSocketServer {
  readonly path: string;
  private readonly server: Server;

  private constructor(path: string, server: Server) {
    this.path = path;
    this.server = server;
  }

  static async listen(broker: ApprovalBroker, profileDir: string, name: string): Promise<ApprovalSocketServer> {
    const path = socketPathFor(profileDir, name);
    if (process.platform !== 'win32' && existsSync(path)) unlinkSync(path);
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      let buffered = '';
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        const nl = buffered.indexOf('\n');
        if (nl === -1) return;
        const line = buffered.slice(0, nl);
        buffered = '';
        void handle(line).then((answer) => {
          if (!socket.destroyed) socket.end(`${JSON.stringify(answer)}\n`);
        });
      });
      socket.on('error', () => socket.destroy());
    });
    const handle = async (line: string) => {
      try {
        const msg = JSON.parse(line) as { token?: unknown; tool?: unknown; input?: unknown };
        if (typeof msg.token !== 'string' || typeof msg.tool !== 'string') {
          return { decision: 'deny', reason: 'malformed approval request' };
        }
        const input = msg.input && typeof msg.input === 'object' ? (msg.input as Record<string, unknown>) : {};
        return await broker.request(msg.token, {
          tool: msg.tool,
          summary: summarizeToolCall(msg.tool, input),
          readOnly: !callNeedsApproval(msg.tool, input),
          ...(msg.tool === 'Bash' && typeof input.command === 'string' ? { command: input.command } : {}),
        });
      } catch (err) {
        log.warn('approvals', 'socket-request-failed', { err: err instanceof Error ? err.message : String(err) });
        return { decision: 'deny', reason: 'approval request failed' };
      }
    };
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return new ApprovalSocketServer(path, server);
  }

  /** Shell command Claude runs for the PreToolUse hook of one gated run. */
  hookCommand(token: string): string {
    return [process.execPath, hookScriptPath(), this.path, token].map(shellQuote).join(' ');
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (process.platform !== 'win32' && existsSync(this.path)) {
      try {
        unlinkSync(this.path);
      } catch {
        // already gone
      }
    }
  }
}

function socketPathFor(profileDir: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '_');
  if (process.platform === 'win32') return `\\\\.\\pipe\\lark-channel-bridge-${safe}-${process.pid}`;
  const inProfile = join(profileDir, 'approval.sock');
  // Unix socket paths are capped near 104 bytes on macOS.
  return inProfile.length < 100 ? inProfile : join(tmpdir(), `lcb-${safe}-${process.pid}.sock`);
}

/** `bin/approval-hook.mjs` next to this package's `dist/` (or `src/` under tests). */
export function hookScriptPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'bin', 'approval-hook.mjs');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('approval hook script (bin/approval-hook.mjs) not found');
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`;
  return /^[A-Za-z0-9_\-./:=@+]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
