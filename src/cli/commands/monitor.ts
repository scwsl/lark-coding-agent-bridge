import { resolveAppPaths } from '../../config/app-paths';
import { createMonitorReader, renderMonitor } from '../../terminal/monitor';

export function monitorFrame(text: string): string {
  // Overwrite in place: ED2 may archive the cleared screen in iTerm scrollback.
  // Explicit CRLF also works when raw mode disables output newline translation.
  return '\x1b[H' + text.replace(/\r?\n/g, '\x1b[K\r\n') + '\x1b[K\x1b[J';
}

export async function runMonitor(opts: { profile?: string; interval?: string; once?: boolean; json?: boolean; color?: boolean }): Promise<void> {
  const seconds = Number(opts.interval ?? 2);
  if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 60) throw new Error('--interval must be between 0.5 and 60 seconds');
  const readMonitor = createMonitorReader();
  const root = resolveAppPaths().rootDir;
  if (opts.once || opts.json || !process.stdout.isTTY || !process.stdin.isTTY) {
    const snap = await readMonitor(root, opts.profile);
    console.log(opts.json ? JSON.stringify(snap, null, 2) : renderMonitor(snap, process.stdout.columns || 110, 1000, false));
    return;
  }
  let paused = false; let stopped = false; let timer: NodeJS.Timeout | undefined;
  const raw = process.stdin.isRaw;
  const restore = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    process.stdin.off('data', key); process.stdin.setRawMode(raw); process.stdin.pause();
    process.off('SIGINT', restore); process.off('SIGTERM', restore);
    process.stdout.off('resize', resize);
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  };
  let refreshing = false;
  const refresh = async () => {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      const snap = await readMonitor(root, opts.profile);
      if (!stopped) process.stdout.write(monitorFrame(renderMonitor(snap, process.stdout.columns, process.stdout.rows, opts.color !== false && !process.env.NO_COLOR) + (paused ? '\nPAUSED' : '')));
    } finally { refreshing = false; }
  };
  const tick = async () => {
    try { if (!paused) await refresh(); } catch (err) { restore(); console.error((err as Error).message); }
    if (!stopped) timer = setTimeout(() => void tick(), seconds * 1000);
  };
  const key = (data: Buffer) => { const text = data.toString(); if (text === 'q' || text === '\x03') restore(); else if (text === ' ') { paused = !paused; void refresh().catch(restore); } else if (text === 'r') void refresh().catch(restore); };
  const resize = () => { void refresh().catch(restore); };
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', key);
  process.on('SIGINT', restore); process.on('SIGTERM', restore); process.stdout.on('resize', resize);
  await tick();
}
