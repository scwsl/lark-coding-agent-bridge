import { isAlive } from '../agent/process-tree';
import { formatAgo, formatClock, STALL_WARN_MS } from '../card/run-renderer';
import type { RunHandle } from './active-runs';

/**
 * One line on what a live run is doing, for `/status`. Answered by the bridge
 * itself, so it still comes back while the agent is stuck inside a tool call —
 * and silence means the bridge itself is down.
 */
export function describeActiveRun(handle: RunHandle, now: number = Date.now()): string {
  const idleMs = now - handle.lastActivityAt;
  const parts = [`已运行 ${formatClock(now - handle.startedAt)}`];
  parts.push(
    idleMs >= STALL_WARN_MS
      ? `⚠️ 已 ${Math.floor(idleMs / 60_000)} 分钟没有新动静`
      : `上次动静 ${formatAgo(idleMs)}`,
  );
  if (handle.toolLabel) parts.push(`当前：${handle.toolLabel}`);
  const pid = handle.run.pid;
  if (pid) parts.push(`agent 进程 ${pid} ${isAlive(pid) ? '存活' : '已退出'}`);
  if (handle.interrupted) parts.push('正在终止');
  return parts.join(' · ');
}
