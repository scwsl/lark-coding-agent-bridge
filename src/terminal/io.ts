import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

interface Bytes { read: number; write: number }
interface Counters { disk?: Bytes; network?: Bytes }
export interface IoMetrics { disk: Bytes | null; network: Bytes | null; sampledAt: number }
const exec = promisify(execFile);

export function parseMacDisk(text: string): Bytes | undefined {
  let read = 0; let write = 0; let found = false;
  for (const line of text.split('\n')) {
    if (!line.includes('"Statistics"')) continue;
    const r = line.match(/"Bytes \(Read\)"=(\d+)/);
    const w = line.match(/"Bytes \(Write\)"=(\d+)/);
    if (!r || !w) continue;
    read += Number(r[1]); write += Number(w[1]); found = true;
  }
  return found ? { read, write } : undefined;
}
export function parseMacNetwork(text: string): Bytes | undefined {
  let read = 0; let write = 0; let found = false;
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const name = fields[0] ?? '';
    // Link-level rows only: IPv4/IPv6 rows repeat the same counters.
    // Exclude loopback, tunnels and Wi-Fi peer links to avoid double counting.
    if (!/^en\d+$/.test(name) || !fields[2]?.startsWith('<Link#') || seen.has(name)) continue;
    const link = fields.slice(3);
    // A MAC address is optional. The remaining seven fields are numeric counters.
    const counters = link.slice(-7);
    const r = Number(counters[2]); const w = Number(counters[5]);
    if (!Number.isFinite(r) || !Number.isFinite(w)) continue;
    read += r; write += w; found = true; seen.add(name);
  }
  return found ? { read, write } : undefined;
}
async function command(binary: string, args: string[]): Promise<string> {
  return (await exec(binary, args, { timeout: 1500, maxBuffer: 1024 * 1024, encoding: 'utf8' })).stdout;
}
async function readCounters(): Promise<Counters> {
  if (platform() === 'darwin') {
    const results = await Promise.allSettled([
      command('/usr/sbin/ioreg', ['-r', '-c', 'IOBlockStorageDriver']),
      command('/usr/sbin/netstat', ['-ibn']),
    ]);
    return {
      disk: results[0]?.status === 'fulfilled' ? parseMacDisk(results[0].value) : undefined,
      network: results[1]?.status === 'fulfilled' ? parseMacNetwork(results[1].value) : undefined,
    };
  }

  return {};
}
function rate(previous: { at: number; bytes: Bytes } | undefined, current: Bytes | undefined, now: number): Bytes | null {
  if (!previous || !current || now <= previous.at || current.read < previous.bytes.read || current.write < previous.bytes.write) return null;
  const seconds = (now - previous.at) / 1000;
  return { read: (current.read - previous.bytes.read) / seconds, write: (current.write - previous.bytes.write) / seconds };
}
/** At most two short native commands per five seconds on macOS; no persistent top process. */
export function createIoSampler(read = readCounters) {
  let disk: { at: number; bytes: Bytes } | undefined;
  let network: { at: number; bytes: Bytes } | undefined;
  let cached: IoMetrics | undefined;
  return async (now = Date.now()): Promise<IoMetrics> => {
    if (cached && now >= cached.sampledAt && now - cached.sampledAt < 5000) return cached;
    const current = await read().catch(() => ({} as Counters));
    cached = { disk: rate(disk, current.disk, now), network: rate(network, current.network, now), sampledAt: now };
    disk = current.disk ? { at: now, bytes: current.disk } : undefined;
    network = current.network ? { at: now, bytes: current.network } : undefined;
    return cached;
  };
}
