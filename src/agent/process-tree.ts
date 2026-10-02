import { execFileSync } from 'node:child_process';

/**
 * Every live descendant of `rootPid` (children, grandchildren, …), deepest
 * first is not guaranteed — callers signal them all anyway.
 *
 * Stopping the agent used to signal only its own process. Whatever it had
 * started kept running: a hung `curl`, a blocking `lark-cli auth login`, a
 * container client, background shells. Snapshot the tree *before* signalling,
 * because once the agent dies its children are reparented to init and no
 * longer trace back to it.
 *
 * Empty on Windows or if `ps` fails — the caller still signals the root.
 */
export function listDescendants(rootPid: number): number[] {
  if (process.platform === 'win32') return [];
  let out: string;
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }
  const found: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>(queue);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** Send `signal` to each pid, ignoring ones that already exited. */
export function signalAll(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
