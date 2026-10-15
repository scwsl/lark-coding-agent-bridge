import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MARKER = Buffer.from('"type":"cost-state"');
const NL = 0x0a;
const CHUNK = 256 * 1024;

/**
 * The running total `total_cost_usd` starts from when Claude Code resumes a
 * session. It restores that total from the last `cost-state` record of the
 * session transcript, so the first result of a resumed process reports the
 * whole session's spend, not the turn's. Read here right before spawn — the
 * same record Claude is about to restore. Undefined when there is none.
 */
export function restoredSessionCost(
  sessionId: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const file = transcriptPath(sessionId, cwd, env);
  if (!file) return undefined;
  try {
    return lastCostState(file, sessionId);
  } catch {
    return undefined;
  }
}

export function transcriptPath(sessionId: string, cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
  const projects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const name = `${sessionId}.jsonl`;
  // Claude names a project dir after its cwd with every non-alphanumeric
  // character turned into `-`; long paths get shortened, so fall back to a scan.
  if (cwd) {
    const direct = join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), name);
    if (existsSync(direct)) return direct;
  }
  try {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, name);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // no projects dir
  }
  return undefined;
}

/** Scan the transcript backwards, chunk by chunk, for its last `cost-state`. */
function lastCostState(file: string, sessionId: string): number | undefined {
  const fd = openSync(file, 'r');
  try {
    let end = fstatSync(fd).size;
    // Head of the line cut by the previous chunk boundary (bytes, so a split
    // multi-byte character survives).
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const data = Buffer.concat([buf, carry]);
      const first = data.indexOf(NL);
      if (data.includes(MARKER)) {
        let lineEnd = data.length;
        for (let nl = data.lastIndexOf(NL, lineEnd - 1); nl !== -1; nl = data.lastIndexOf(NL, lineEnd - 1)) {
          const cost = costOf(data.subarray(nl + 1, lineEnd), sessionId);
          if (cost !== undefined) return cost;
          lineEnd = nl;
          if (nl === 0) break;
        }
      }
      carry = first === -1 ? data : data.subarray(0, first);
      end = start;
    }
    return costOf(carry, sessionId);
  } finally {
    closeSync(fd);
  }
}

function costOf(line: Buffer, sessionId: string): number | undefined {
  if (!line.includes(MARKER)) return undefined;
  try {
    const rec = JSON.parse(line.toString('utf8')) as { type?: unknown; sessionId?: unknown; totalCostUSD?: unknown };
    if (rec.type !== 'cost-state' || (rec.sessionId !== undefined && rec.sessionId !== sessionId)) return undefined;
    return typeof rec.totalCostUSD === 'number' && Number.isFinite(rec.totalCostUSD) ? rec.totalCostUSD : undefined;
  } catch {
    return undefined;
  }
}
