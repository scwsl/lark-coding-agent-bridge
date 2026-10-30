import { mkdir, readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import { mergeProcessEnv, spawnProcess } from '../platform/spawn';
import { EFFORT_LEVELS, type AutoEffortPreference, type EffortLevel } from '../config/schema';

/**
 * 自动分级: before each chat run, a quick model call rates how hard the
 * message is, and the run's model / effort climb or drop one rung at a time
 * on a ladder (opus·medium → opus·high → opus·xhigh → fable·xhigh by
 * default). Rules come first and skip the call:
 *  - a `/<rung>` prefix (`/high`, `/fable`, …) pins that rung;
 *  - a short follow-up ("继续", "好的") keeps the current rung, and on a new
 *    conversation starts at the bottom.
 * A new conversation starts wherever the rating says, but never on a rung
 * with a different model than the first (Fable is only reached by climbing):
 * switching models voids the conversation's prompt cache, so it should only
 * happen when the cheaper rungs proved not enough. For the same reason,
 * leaving such a rung downward takes two ratings below it in a row.
 */

export interface AutoEffortRung {
  /** Shown on the reply card and named by the rating and by `/<label>`. */
  label: string;
  model: string;
  effort: EffortLevel;
  /** Only runs the bot owner alone started may use it. */
  ownerOnly?: boolean;
  /** What belongs on this rung, for the rating prompt. */
  hint?: string;
}

export interface AutoEffortSettings {
  ladder: AutoEffortRung[];
  classifierModel: string;
  classifierEffort: EffortLevel;
  timeoutMs: number;
}

export const DEFAULT_AUTO_EFFORT_LADDER: readonly AutoEffortRung[] = [
  {
    label: 'medium',
    model: 'opus',
    effort: 'medium',
    hint: '简单问答、查一个事实、闲聊、短命令、按现成技能跑固定流程',
  },
  {
    label: 'high',
    model: 'opus',
    effort: 'high',
    hint: '常规排障或查询（涉及一两个系统）、小范围改代码、写短文档',
  },
  {
    label: 'xhigh',
    model: 'opus',
    effort: 'xhigh',
    hint: '多系统联合排障、根因分析、跨模块改代码、方案设计、长报告',
  },
  {
    label: 'fable',
    model: 'fable',
    effort: 'xhigh',
    ownerOnly: true,
    hint: '极难：架构级设计、大型改动、上一档反复失败或被用户指出不对仍没解决',
  },
];

const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4, ultra: 5 };

/** Up to this many characters (after trimming) a message on a running conversation counts as a follow-up. */
export const SHORT_FOLLOW_UP_CHARS = 6;
/** A rung whose model failed a run is skipped for this long (its quota may be used up). */
export const MODEL_BLOCK_MS = 60 * 60_000;
/** Ratings below a rung with its own model needed in a row before leaving it downward. */
export const MODEL_EXIT_VOTES = 2;

/** One scope's place on the ladder, as written to disk. */
export interface AutoEffortScopeState {
  rung: number;
  /** The conversation the rung belongs to; another one starts over. */
  handle?: string;
  /** Ratings in a row below the current rung (see {@link MODEL_EXIT_VOTES}). */
  downVotes: number;
  /** How the last run on this scope ended, for the next rating. */
  last?: { terminal?: string; durationMs?: number };
  updatedAt: number;
}

export interface RungDecision {
  rung: number;
  downVotes: number;
  /** How the rung was chosen, for the card and the log. */
  via: 'forced' | 'fresh' | 'up' | 'down' | 'stay' | 'held';
}

/** Rungs a run may use: the owner's may climb the whole ladder; anyone else's stay at or under the chat's effort and off owner-only rungs. */
export function allowedRungs(
  ladder: readonly AutoEffortRung[],
  opts: { owner: boolean; cap?: EffortLevel; blockedModels?: ReadonlySet<string> },
): number[] {
  const capRank = opts.cap !== undefined ? EFFORT_RANK[opts.cap] : undefined;
  const out: number[] = [];
  ladder.forEach((rung, i) => {
    if (opts.blockedModels?.has(rung.model)) return;
    if (!opts.owner) {
      if (rung.ownerOnly) return;
      if (capRank !== undefined && (EFFORT_RANK[rung.effort] ?? 0) > capRank) return;
    }
    out.push(i);
  });
  return out;
}

/** The highest allowed rung at or below `rung`, else the lowest allowed one. */
function seat(allowed: readonly number[], rung: number): number {
  let pos = 0;
  allowed.forEach((r, i) => {
    if (r <= rung) pos = i;
  });
  return pos;
}

/**
 * Where this run lands. `target` is the rating (a rung index; undefined when
 * the rating failed or was skipped), `current` the scope's state when the run
 * continues its conversation (undefined: a new one). `allowed` must be
 * non-empty and ascending.
 */
export function decideRung(input: {
  ladder: readonly AutoEffortRung[];
  allowed: readonly number[];
  current?: { rung: number; downVotes: number };
  target?: number;
  forced?: number;
}): RungDecision {
  const { ladder, allowed } = input;
  if (input.forced !== undefined) {
    return { rung: allowed[seat(allowed, input.forced)]!, downVotes: 0, via: 'forced' };
  }
  if (!input.current) {
    // Start on the first model only: another model is reached by climbing.
    const firstModel = ladder[0]?.model;
    let top = 0;
    ladder.forEach((rung, i) => {
      if (rung.model === firstModel) top = i;
    });
    const start = Math.min(input.target ?? 0, top);
    return { rung: allowed[seat(allowed, start)]!, downVotes: 0, via: 'fresh' };
  }
  const pos = seat(allowed, input.current.rung);
  const cur = allowed[pos]!;
  const target = input.target;
  if (target === undefined || target === cur) return { rung: cur, downVotes: 0, via: 'stay' };
  if (target > cur) {
    const next = allowed[pos + 1];
    return next === undefined ? { rung: cur, downVotes: 0, via: 'stay' } : { rung: next, downVotes: 0, via: 'up' };
  }
  const below = allowed[pos - 1];
  if (below === undefined) return { rung: cur, downVotes: 0, via: 'stay' };
  if (ladder[below]?.model !== ladder[cur]?.model) {
    const votes = input.current.downVotes + 1;
    if (votes < MODEL_EXIT_VOTES) return { rung: cur, downVotes: votes, via: 'held' };
  }
  return { rung: below, downVotes: 0, via: 'down' };
}

/** `/fable 帮我…` → the `fable` rung. Case-insensitive; the prefix must stand alone. */
export function forcedRung(ladder: readonly AutoEffortRung[], text: string): number | undefined {
  const m = /^\s*\/([A-Za-z][\w-]*)(?:\s|$)/.exec(text);
  if (!m) return undefined;
  const name = m[1]!.toLowerCase();
  const i = ladder.findIndex((r) => r.label.toLowerCase() === name);
  return i >= 0 ? i : undefined;
}

export function isShortFollowUp(text: string, attachments: number): boolean {
  return attachments === 0 && text.trim().length <= SHORT_FOLLOW_UP_CHARS;
}

/** The rating prompt's system part: what each rung is for and the answer format. */
export function classifierSystemPrompt(ladder: readonly AutoEffortRung[]): string {
  const levels = ladder.map((r) => `- ${r.label}：${r.hint ?? `${r.model} · ${r.effort}`}`).join('\n');
  return [
    '你是任务难度分级器。根据用户发给编程与运维助手的消息，判断完成它需要的推理档位。',
    '档位从低到高：',
    levels,
    '规则：只看完成任务本身的难度，不看消息长短；对上一轮的简单跟进（继续、好的、照做）沿用当前档位；',
    '上一轮失败、超时，或用户说结果不对、还是不行时，倾向高一档。',
    `只输出一个 JSON，不要其他文字：{"level":"${ladder.map((r) => r.label).join('|')}","reason":"不超过 20 字"}`,
  ].join('\n');
}

export interface ClassifierInput {
  text: string;
  quoted?: string;
  chatType: 'p2p' | 'group';
  /** Current rung label; undefined on a new conversation. */
  current?: string;
  last?: AutoEffortScopeState['last'];
}

const TEXT_LIMIT = 3000;
const QUOTE_LIMIT = 600;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…（已截断）` : text;
}

export function classifierUserPrompt(input: ClassifierInput): string {
  const lines = [`会话：${input.chatType === 'p2p' ? '私聊' : '群聊'}`];
  if (input.current) {
    const last = input.last;
    const outcome = last?.terminal
      ? `；上一轮${last.durationMs !== undefined ? `用时 ${Math.max(1, Math.round(last.durationMs / 60_000))} 分钟，` : ''}结果 ${last.terminal}`
      : '';
    lines.push(`当前档位：${input.current}${outcome}`);
  } else {
    lines.push('当前档位：新会话');
  }
  if (input.quoted) lines.push(`用户引用的消息：\n${clip(input.quoted, QUOTE_LIMIT)}`);
  lines.push(`本轮消息：\n${clip(input.text, TEXT_LIMIT)}`);
  return lines.join('\n\n');
}

/** `{"level":"high",…}` somewhere in the answer → the rung index and reason. */
export function parseClassifierAnswer(
  ladder: readonly AutoEffortRung[],
  answer: string,
): { rung: number; reason?: string } | undefined {
  const m = /\{[^{}]*\}/.exec(answer);
  if (!m) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(m[0]);
  } catch {
    return undefined;
  }
  const level = (doc as { level?: unknown }).level;
  if (typeof level !== 'string') return undefined;
  const rung = ladder.findIndex((r) => r.label.toLowerCase() === level.trim().toLowerCase());
  if (rung < 0) return undefined;
  const reason = (doc as { reason?: unknown }).reason;
  return { rung, ...(typeof reason === 'string' && reason ? { reason: reason.slice(0, 60) } : {}) };
}

export interface ClassifyOptions {
  binary?: string;
  /** An empty directory: the call must not pick up a project's CLAUDE.md. */
  cwd: string;
  /** The account's token (see PickedAccount.env); empty for the CLI's own login. */
  env?: Record<string, string>;
}

/**
 * One tool-less, session-less `claude -p` call that rates the message. Never
 * throws: undefined when it fails, times out or answers off-format.
 */
export async function classify(
  settings: AutoEffortSettings,
  input: ClassifierInput,
  opts: ClassifyOptions,
): Promise<{ rung: number; reason?: string } | undefined> {
  await mkdir(opts.cwd, { recursive: true }).catch(() => undefined);
  const args = [
    '-p',
    '--model',
    settings.classifierModel,
    '--effort',
    settings.classifierEffort,
    '--tools',
    '',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--system-prompt',
    classifierSystemPrompt(settings.ladder),
  ];
  // The message goes through stdin, never argv (see ClaudeAdapter.spawnRun).
  const stdout = await new Promise<string | undefined>((resolve) => {
    let out = '';
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawnProcess(opts.binary ?? 'claude', args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: mergeProcessEnv(process.env, opts.env ?? {}),
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(undefined);
    }, settings.timeoutMs);
    child.stdout?.on('data', (buf: Buffer) => {
      if (out.length < 64_000) out += buf.toString('utf8');
    });
    child.once('error', () => finish(undefined));
    child.once('close', (code) => finish(code === 0 ? out : undefined));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(classifierUserPrompt(input));
  });
  if (!stdout) return undefined;
  let result: unknown;
  try {
    result = (JSON.parse(stdout) as { result?: unknown }).result;
  } catch {
    return undefined;
  }
  return typeof result === 'string' ? parseClassifierAnswer(settings.ladder, result) : undefined;
}

type StateMap = Record<string, AutoEffortScopeState>;

/** Scopes untouched for this long are dropped at load. */
const MAX_AGE_MS = 14 * 24 * 60 * 60_000;

function isScopeState(x: unknown): x is AutoEffortScopeState {
  if (!x || typeof x !== 'object') return false;
  const s = x as Partial<AutoEffortScopeState>;
  return typeof s.rung === 'number' && typeof s.downVotes === 'number' && typeof s.updatedAt === 'number';
}

/**
 * Each scope's rung, kept on disk so a restart doesn't drop a long
 * conversation back to the bottom. Also remembers models whose runs just
 * failed (see {@link MODEL_BLOCK_MS}), in memory only.
 */
export class AutoEffortStore {
  private data: StateMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly blocked = new Map<string, number>();

  constructor(private readonly path?: string) {}

  async load(now: number = Date.now()): Promise<void> {
    if (!this.path) return;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
      this.data = {};
      for (const [scope, entry] of Object.entries(raw)) {
        if (isScopeState(entry) && now - entry.updatedAt < MAX_AGE_MS) this.data[scope] = entry;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.warn('auto-effort', 'load-failed', { err: String(err) });
      this.data = {};
    }
  }

  get(scope: string): AutoEffortScopeState | undefined {
    return this.data[scope];
  }

  /** The scope's state when it belongs to the conversation `handle` resumes; undefined otherwise. */
  forConversation(scope: string, handle: string | undefined): AutoEffortScopeState | undefined {
    const state = this.data[scope];
    return state && handle && state.handle === handle ? state : undefined;
  }

  set(scope: string, state: Omit<AutoEffortScopeState, 'updatedAt'>, now: number = Date.now()): void {
    this.data[scope] = { ...state, updatedAt: now };
    this.schedulePersist();
  }

  blockModel(model: string, now: number = Date.now()): void {
    this.blocked.set(model, now + MODEL_BLOCK_MS);
  }

  blockedModels(now: number = Date.now()): Set<string> {
    const out = new Set<string>();
    for (const [model, until] of this.blocked) {
      if (until > now) out.add(model);
      else this.blocked.delete(model);
    }
    return out;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    if (!this.path) return;
    const path = this.path;
    const snapshot = JSON.stringify(this.data);
    this.saving = this.saving
      .then(() => writeFileAtomic(path, snapshot, { mode: 0o600 }))
      .catch((err) => log.warn('auto-effort', 'persist-failed', { err: String(err) }));
  }
}

/** `preferences.autoEffort` → settings, or undefined when off. Malformed parts fall back to the defaults. */
export function resolveAutoEffort(pref: AutoEffortPreference | undefined): AutoEffortSettings | undefined {
  if (pref?.enabled !== true) return undefined;
  const validRung = (r: unknown): r is AutoEffortRung => {
    const x = r as Partial<AutoEffortRung> | undefined;
    return (
      typeof x?.label === 'string' &&
      /^[A-Za-z][\w-]*$/.test(x.label) &&
      typeof x.model === 'string' &&
      x.model.length > 0 &&
      EFFORT_LEVELS.includes(x.effort as EffortLevel)
    );
  };
  const ladder =
    Array.isArray(pref.ladder) && pref.ladder.length > 0 && pref.ladder.every(validRung)
      ? pref.ladder.map((r) => ({ ...r }))
      : DEFAULT_AUTO_EFFORT_LADDER.map((r) => ({ ...r }));
  const timeout = pref.timeoutMs;
  return {
    ladder,
    classifierModel: typeof pref.classifierModel === 'string' && pref.classifierModel ? pref.classifierModel : 'opus',
    classifierEffort: EFFORT_LEVELS.includes(pref.classifierEffort as EffortLevel)
      ? (pref.classifierEffort as EffortLevel)
      : 'medium',
    timeoutMs:
      typeof timeout === 'number' && Number.isFinite(timeout) ? Math.min(Math.max(timeout, 3_000), 60_000) : 20_000,
  };
}
