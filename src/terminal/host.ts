import { createTemperatureSampler } from './temperature';
import { createIoSampler, type IoMetrics } from './io';
import { statfs } from 'node:fs/promises';
import { cpus, freemem, homedir, totalmem, uptime } from 'node:os';

export interface CpuTicks { idle: number; total: number }
export interface HostMetrics {
  cpuPercent: number | null;
  temperatureC?: number | null;
  io?: IoMetrics;
  memoryTotal: number;
  memoryNonFree: number;
  uptimeSeconds: number;
  disk?: { total: number; used: number; available: number; sampledAt: number };
}
export function cpuPercent(previous: CpuTicks, current: CpuTicks): number | null {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0 || idle < 0) return null;
  return Math.max(0, Math.min(100, (1 - idle / total) * 100));
}
/** OS counters only; disk stats are cached for 30s. Never spawn top/ps per frame. */
export function createHostSampler() {
  const sampleIo = createIoSampler();
  const sampleTemperature = createTemperatureSampler();
  let previous: CpuTicks | undefined;
  let disk: HostMetrics['disk'];
  let diskAttempt = -Infinity;
  return async (now = Date.now()): Promise<HostMetrics> => {
    const ticks = cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
    const percent = previous ? cpuPercent(previous, ticks) : null;
    previous = ticks;
    if (now - diskAttempt >= 30_000) {
      diskAttempt = now;
      try {
        const fs = await statfs(homedir());
        disk = { total: fs.blocks * fs.bsize, used: (fs.blocks - fs.bfree) * fs.bsize,
          available: fs.bavail * fs.bsize, sampledAt: now };
      } catch { /* Disk metrics may be unavailable; retain the previous timestamped sample. */ }
    }
    const memoryTotal = totalmem();
    const [io, temperatureC] = await Promise.all([sampleIo(now), sampleTemperature(now)]);
    return { io, temperatureC, cpuPercent: percent, memoryTotal, memoryNonFree: memoryTotal - freemem(), uptimeSeconds: uptime(), disk };
  };
}
