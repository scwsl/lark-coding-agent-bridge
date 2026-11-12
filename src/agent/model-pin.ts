import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * 指定模型: `/model sonnet 帮我…` pins a topic to one model. Outside a topic
 * the message opens a topic of its own; inside one it switches that topic.
 * Every later run in the topic uses the pinned model, and 自动分级 neither
 * rates nor changes it until `/model auto`.
 */
export const MODEL_PIN_CHOICES = ['sonnet', 'fable', 'haiku', 'opus'] as const;
export type ModelPinChoice = (typeof MODEL_PIN_CHOICES)[number];

/** Only the owner may pin these: their quota is the scarce one. */
export const OWNER_ONLY_PINS: ReadonlySet<string> = new Set(['fable']);

export type ModelCommand =
  /** Bare `/model`: show what the topic runs on. */
  | { kind: 'show' }
  /** `/model auto` (or `off`): drop the pin, back to 自动分级. */
  | { kind: 'clear' }
  | { kind: 'set'; model: ModelPinChoice; rest: string }
  | { kind: 'invalid'; name: string };

const CLEAR_WORDS = new Set(['auto', 'off', 'reset', 'default']);

/** `/model …` at the start of `text`, else undefined. Case-insensitive; `/models` is not it. */
export function parseModelCommand(text: string): ModelCommand | undefined {
  const m = /^\s*\/model(?=\s|$)\s*/i.exec(text);
  if (!m) return undefined;
  const after = text.slice(m[0].length);
  const word = /^(\S+)\s*/.exec(after);
  if (!word) return { kind: 'show' };
  const name = word[1]!.toLowerCase();
  const rest = after.slice(word[0].length).trim();
  if (CLEAR_WORDS.has(name)) return { kind: 'clear' };
  const model = MODEL_PIN_CHOICES.find((c) => c === name);
  return model ? { kind: 'set', model, rest } : { kind: 'invalid', name: word[1]! };
}

export const MODEL_COMMAND_USAGE =
  `用法：\`/model <${MODEL_PIN_CHOICES.join('|')}> 问题\`。话题外发会单独开一个话题，话题里发会切换本话题；` +
  '之后整个话题都用这个模型。`/model` 看本话题当前模型，`/model auto` 恢复自动分级。';

export interface ModelPin {
  model: ModelPinChoice;
  setBy?: string;
  updatedAt: number;
}

/** Pins older than this are dropped on load: the topic has long gone quiet. */
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

function isPin(x: unknown): x is ModelPin {
  if (!x || typeof x !== 'object') return false;
  const p = x as Partial<ModelPin>;
  return typeof p.updatedAt === 'number' && MODEL_PIN_CHOICES.includes(p.model as ModelPinChoice);
}

/** Each scope's pinned model, kept on disk so a restart keeps the topic on it. */
export class ModelPinStore {
  private data: Record<string, ModelPin> = {};
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path?: string) {}

  async load(now: number = Date.now()): Promise<void> {
    if (!this.path) return;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
      this.data = {};
      for (const [scope, entry] of Object.entries(raw)) {
        if (isPin(entry) && now - entry.updatedAt < MAX_AGE_MS) this.data[scope] = entry;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.warn('model-pin', 'load-failed', { err: String(err) });
      this.data = {};
    }
  }

  get(scope: string): ModelPin | undefined {
    return this.data[scope];
  }

  set(scope: string, model: ModelPinChoice, setBy?: string, now: number = Date.now()): void {
    this.data[scope] = { model, ...(setBy ? { setBy } : {}), updatedAt: now };
    this.schedulePersist();
  }

  /** Keep a pin in use from aging out. */
  touch(scope: string, now: number = Date.now()): void {
    const pin = this.data[scope];
    if (!pin || now - pin.updatedAt < 24 * 60 * 60_000) return;
    this.data[scope] = { ...pin, updatedAt: now };
    this.schedulePersist();
  }

  delete(scope: string): boolean {
    if (!this.data[scope]) return false;
    delete this.data[scope];
    this.schedulePersist();
    return true;
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
      .catch((err) => log.warn('model-pin', 'persist-failed', { err: String(err) }));
  }
}
