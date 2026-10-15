import { createHostSampler, type HostMetrics } from './host';
import { open, readdir } from 'node:fs/promises';
import { cpus, hostname, loadavg } from 'node:os';
import { join } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { isAlive, readAndPrune, type ProcessEntry } from '../runtime/registry';
import { readRunRecords, RUN_STALE_AFTER_MS, type RunRecord } from '../runtime/run-registry';

interface Activity { ts: number; event: string; phase: string; tool?: string; traceId?: string; runId?: string; scope?: string }
export interface MonitorBot { profile: string; name: string; agent: string; pid?: number; online: boolean; activity?: Activity; runs: Array<RunRecord & { orphan: boolean; activity?: Activity }> }
export interface MonitorSnapshot { now: number; host: string; cores: number; load: number; bots: MonitorBot[]; metrics?: HostMetrics }

/** Bounded log read: never load a growing multi-gigabyte log into memory. */
interface LogCache { name: string; size: number; mtime: number; events: Activity[] }
async function recentActivity(dir: string, cache: Map<string, LogCache>): Promise<Activity[]> {
  try {
    const names = (await readdir(dir)).filter(n => /^bridge-\d{8}\.jsonl$/.test(n)).sort();
    const name = names.at(-1);
    if (!name) return [];
    const file = await open(join(dir, name), 'r');
    try {
      const info = await file.stat();
      const size = info.size;
      const cached = cache.get(dir);
      if (cached?.name === name && cached.size === size && cached.mtime === info.mtimeMs) return cached.events;
      const start = Math.max(0, size - 256 * 1024);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      if (start) lines.shift();
      const out: Activity[] = [];
      for (const line of lines) {
        try {
          const r = JSON.parse(line) as Record<string, unknown>;
          const ts = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
          if (!Number.isFinite(ts) || typeof r.event !== 'string' || typeof r.phase !== 'string') continue;
          out.push({ ts, event: r.event, phase: r.phase,
            tool: typeof r.tool === 'string' ? r.tool : undefined,
            traceId: typeof r.traceId === 'string' ? r.traceId : undefined,
            runId: typeof r.runId === 'string' ? r.runId : undefined,
            scope: typeof r.scope === 'string' ? r.scope : undefined });
        } catch { /* partial writes and malformed lines are skipped */ }
      }
      cache.set(dir, { name, size, mtime: info.mtimeMs, events: out });
      return out;
    } finally { await file.close(); }
  } catch { return []; }
}

export function createMonitorReader() {
  const cache = new Map<string, LogCache>();
  const sampleHost = createHostSampler();
  return async (rootDir: string, profile?: string, now = Date.now()): Promise<MonitorSnapshot> => {
  const entries = readAndPrune(join(rootDir, 'registry', 'processes.json'));
  let dirs: string[] = [];
  try { dirs = (await readdir(join(rootDir, 'profiles'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); } catch { /* no profiles yet */ }
  const names = [...new Set([...dirs, ...entries.map(e => e.profileName)])].filter(n => !profile || n === profile).sort();
  const bots = await Promise.all(names.map(async name => {
    const paths = resolveAppPaths({ rootDir, profile: name });
    const records = await readRunRecords(paths.runsFile);
    const events = await recentActivity(paths.logsDir, cache);
    const entry: ProcessEntry | undefined = entries.find(e => e.profileName === name && isAlive(e.pid));
    const activity = events.at(-1);
    return { profile: name, name: entry?.botName ?? name, agent: entry?.agentKind ?? 'unknown', pid: entry?.pid,
      online: Boolean(entry), activity,
      runs: records.map(rec => {
        const trace = events.find(e => e.runId === rec.runId)?.traceId;
        const activity = events.filter(e => e.ts >= rec.startedAt && (e.runId === rec.runId || (trace && e.traceId === trace) || (!e.traceId && !e.runId && e.scope === rec.scope))).at(-1);
        return { ...rec, orphan: !isAlive(rec.ownerPid) || now - rec.startedAt > RUN_STALE_AFTER_MS, activity };
      }).sort((a, b) => Number(a.orphan) - Number(b.orphan) || a.startedAt - b.startedAt) };
  }));
  return { now, host: hostname(), cores: cpus().length, load: loadavg()[0] ?? 0, bots, metrics: await sampleHost(now) };
  };
}
export async function readMonitor(rootDir: string, profile?: string, now = Date.now()): Promise<MonitorSnapshot> {
  return createMonitorReader()(rootDir, profile, now);
}

/** Remove terminal control sequences from all untrusted labels and prompts. */
export function clean(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}
function width(char: string): number { const c = char.codePointAt(0) ?? 0; return c >= 0x1100 && (c <= 0x115f || c >= 0x2e80) ? 2 : 1; }
export function fit(text: string, cells: number): string {
  let out = ''; let used = 0;
  for (const ch of clean(text)) { const w = width(ch); if (used + w > cells) break; out += ch; used += w; }
  return out + ' '.repeat(Math.max(0, cells - used));
}
function age(ms: number): string { const s = Math.floor(Math.max(0, ms) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`; }
function activityLabel(a?: Activity): string {
  if (a?.event === 'tool-in-flight') return a.tool ?? '工具执行';
  return '处理中';
}
/** Wrap by terminal cells, preserving readable task summaries in narrow windows. */
function summary(text: string, cells: number): string[] {
  const compact = clean(text).replace(/https?:\/\/[^\s]+/g, url => {
    try { const u = new URL(url); return `[${u.pathname.split('/').filter(Boolean).at(-1) ?? u.hostname}]`; } catch { return url; }
  }).trim();
  const lines: string[] = []; let row = ''; let used = 0;
  for (const ch of compact) {
    const size = width(ch);
    if (used + size > cells) {
      lines.push(row); row = ''; used = 0;
      if (lines.length === 2) { lines[1] = fit(lines[1]!, cells - 1).trimEnd() + '…'; return lines; }
    }
    row += ch; used += size;
  }
  if (row) lines.push(row);
  return lines;
}
export function renderMonitor(s: MonitorSnapshot, columns = 110, rows = 36, color = true): string {
  // Leave the last terminal cell and row unused to avoid automatic wrap/scroll.
  const usable = Math.max(1, columns - 1);
  const indent = columns >= 40 ? '  ' : '';
  const w = Math.max(1, usable - indent.length);
  const height = Math.max(1, rows - 1);
  const paint = (text: string, code: number) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const cells = (text: string) => [...clean(text)].reduce((n, c) => n + width(c), 0);
  const line = (text = '', code = 37, size = w) => paint(fit(text, size), code);
  const pair = (left: string, right: string, code = 37, size = w) => {
    if (size < 8) return line(left, code, size);
    const rightCells = Math.min(Math.floor(size / 2), cells(right));
    return line(left, code, size - rightCells - 2) + '  ' + line(right, 90, rightCells);
  };
  const rule = () => line('─'.repeat(w), 90);
  const ordered = [...s.bots].filter(b => b.online || b.runs.length || b.agent !== 'unknown')
    .sort((a, b) => Number(b.runs.some(r => !r.orphan)) - Number(a.runs.some(r => !r.orphan)) || Number(b.online) - Number(a.online));
  const online = s.bots.filter(b => b.online).length;
  const running = s.bots.flatMap(b => b.runs).filter(r => !r.orphan).length;
  const out = [line(), pair('LARK  /  CONTROL', new Date(s.now).toLocaleTimeString(), 36),
    pair(`${s.host.replace(/\.local$/, '')}  ·  ${online} bots online  ·  ${running} tasks`, 'LIVE', 90), line()];
  const m = s.metrics;
  if (m) {
    const gib = (n: number) => (n / 1024 ** 3).toFixed(1);
    const up = Math.floor(m.uptimeSeconds / 86400) + 'd ' + Math.floor(m.uptimeSeconds % 86400 / 3600) + 'h';
    const metrics = [`CPU ${m.cpuPercent === null ? '—' : m.cpuPercent.toFixed(0) + '%'}`, `RAM ${gib(m.memoryNonFree)}/${gib(m.memoryTotal)}G*`,
      `DISK ${m.disk ? gib(m.disk.available) + 'G free' : '—'}`, `UP ${up}`];
    const speed = (n: number) => n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + 'M/s' : (n / 1024).toFixed(1) + 'K/s';
    const io = m.io;
    const traffic = [`TEMP ${m.temperatureC == null ? '—' : m.temperatureC.toFixed(1) + '°C'}`, io?.disk ? `IO R ${speed(io.disk.read)} W ${speed(io.disk.write)}` : 'IO —',
      io?.network ? `NET ↓ ${speed(io.network.read)} ↑ ${speed(io.network.write)}` : 'NET —'];
    const perRow = w >= 72 ? 4 : w >= 40 ? 2 : 1;
    for (let i = 0; i < metrics.length; i += perRow) out.push(line(metrics.slice(i, i + perRow).join('    ')));
    if (cells(traffic.join('    ')) <= w) out.push(line(traffic.join('    ')));
    else out.push(...traffic.map(text => line(text)));
  }
  out.push(line(), rule());
  const footer = [line(), rule(), line('q 退出  ·  空格暂停  ·  r 刷新' + (m ? '    *RAM 含系统缓存' : ''), 90)];
  const slots = w >= 146 && ordered.length > 1 ? 2 : 1;
  const gap = 4;
  const cardWidth = Math.floor((w - (slots - 1) * gap) / slots);
  const bodyHeight = Math.max(0, height - out.length - footer.length);
  const origin = (run: RunRecord, size: number): string => {
    if (!run.chatType && !run.actorName) return fit('来源待同步', size).trimEnd();
    const place = run.chatType === 'p2p' ? '私聊' : run.chatName || '群名待同步';
    const person = run.actorName ? '@' + run.actorName : '发起人待同步';
    const personSize = Math.min(Math.floor((size - 3) / 2), cells(person));
    return fit(place, Math.max(0, size - personSize - 3)).trimEnd() + ' · ' + fit(person, Math.max(0, personSize)).trimEnd();
  };
  const block = (bot: MonitorBot, budget: number): string[] => {
    const active = bot.runs.filter(r => !r.orphan).length;
    const state = !bot.online ? 'OFFLINE' : active ? 'WORKING' : 'IDLE';
    const result = [line('', 37, cardWidth), pair(`${bot.online ? '●' : '○'} ${bot.name} / ${bot.agent}`, state, bot.online ? 36 : 90, cardWidth)];
    let shown = 0;
    for (const run of bot.runs) {
      const side = cardWidth >= 70;
      const sourceWidth = side ? Math.min(40, Math.floor(cardWidth / 2)) : Math.max(1, cardWidth - 4);
      const source = origin(run, sourceWidth);
      const previews = summary(run.promptPreview || '任务执行中', Math.max(1, cardWidth - 4 - (side ? cells(source) + 2 : 0)));
      const sourceRows = side ? 0 : 1;
      // Keep one row available for the hidden-task count.
      if (result.length + 1 + previews.length + sourceRows + Number(shown + 1 < bot.runs.length) > budget) break;
      result.push(pair('    ' + (run.orphan ? '已中断 / 过期' : activityLabel(run.activity)), age(s.now - run.startedAt), run.orphan ? 33 : 90, cardWidth));
      result.push(...previews.map((text, i) => side
        ? pair('    ' + text, i === 0 ? source : '', 37, cardWidth)
        : line('    ' + text, 37, cardWidth)));
      if (!side) result.push(line('    ' + source, 90, cardWidth));
      shown++;
    }
    if (!bot.runs.length && result.length < budget) result.push(line('    等待新任务', 90, cardWidth));
    if (shown < bot.runs.length && result.length < budget) result.push(line(`    +${bot.runs.length - shown} more tasks`, 90, cardWidth));
    return result.slice(0, budget);
  };
  let hidden = 0; let used = 0;
  for (let i = 0; i < ordered.length; i += slots) {
    const remaining = bodyHeight - used;
    if (remaining < 3) { hidden += ordered.length - i; break; }
    const group = ordered.slice(i, i + slots);
    const later = ordered.length > i + slots;
    // Distribute height between bot rows, letting a sole row use all remaining space.
    const budget = later ? Math.min(remaining - 1, Math.max(5, Math.floor((remaining - 1) / Math.ceil((ordered.length - i) / slots)))) : remaining;
    const blocks = group.map(bot => block(bot, budget));
    const groupHeight = Math.max(...blocks.map(b => b.length));
    for (let r = 0; r < groupHeight; r++) {
      out.push(blocks.map(b => {
        const text = b[r] ?? '';
        return text + ' '.repeat(Math.max(0, cardWidth - cells(text)));
      }).join(' '.repeat(gap)));
    }
    used += groupHeight;
  }
  if (!ordered.length && bodyHeight) out.push(line('等待 bot 上线', 90));
  if (hidden && out.length < height - footer.length) out.push(line(`+${hidden} bots · enlarge window or use --profile`, 90));
  out.push(...footer);
  return out.slice(0, height).map(text => indent + text).join('\n');
}
