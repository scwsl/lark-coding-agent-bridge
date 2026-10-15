import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { platform } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export function parseTemperature(text: string): number | null {
  const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*°C$/);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value > 0 && value <= 125 ? value : null;
}
async function findSensor(): Promise<string | undefined> {
  if (platform() !== 'darwin') return undefined;
  for (const path of ['/opt/homebrew/bin/osx-cpu-temp', '/usr/local/bin/osx-cpu-temp']) {
    try { await access(path, constants.X_OK); return path; } catch { /* Optional local sensor. */ }
  }
  return undefined;
}
/** Optional macOS sensor; no sudo, automatic installation or persistent child process. */
export function createTemperatureSampler(read?: () => Promise<number | null>) {
  const sensor = read ? undefined : findSensor();
  const sample = read ?? (async () => {
    const binary = await sensor;
    if (!binary) return null;
    return parseTemperature((await exec(binary, [], { timeout: 1500, maxBuffer: 4096, encoding: 'utf8' })).stdout);
  });
  let at = -Infinity;
  let value: number | null = null;
  return async (now = Date.now()): Promise<number | null> => {
    if (now >= at && now - at < 5000) return value;
    at = now;
    value = await sample().catch(() => null);
    return value;
  };
}
