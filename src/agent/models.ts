import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentKind } from '../config/profile-schema';
import { CODEX_EFFORT_LEVELS, EFFORT_LEVELS, type EffortLevel } from '../config/schema';

/**
 * Sentinel selection meaning "don't pass `--model`; let the agent CLI /
 * account decide". Kept as a real option value (rather than empty string)
 * because Feishu's `select_static` requires `initial_option` to match one of
 * the option `value`s exactly and rejects an empty string.
 */
export const DEFAULT_MODEL = 'default';

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to the agent's `--model`
   * flag. `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
}

/**
 * Claude Code models, expressed as the CLI's own aliases rather than pinned
 * version ids: Claude Code resolves `opus` / `sonnet` / … to the newest model
 * the account can use, so the picker never needs a code change when a new
 * generation ships. Claude Code keeps no local catalog of concrete ids to
 * read (unlike Codex's `models_cache.json`); the account-specific extras it
 * does cache are appended by {@link claudeModels}.
 */
const CLAUDE_ALIASES: ModelOption[] = [
  { value: 'opus', label: 'Opus（始终最新）' },
  { value: 'sonnet', label: 'Sonnet（始终最新）' },
  { value: 'fable', label: 'Fable（始终最新）' },
  { value: 'haiku', label: 'Haiku（始终最新）' },
  { value: 'opus[1m]', label: 'Opus · 1M 上下文（始终最新）' },
  { value: 'sonnet[1m]', label: 'Sonnet · 1M 上下文（始终最新）' },
  { value: 'fable[1m]', label: 'Fable · 1M 上下文（始终最新）' },
  { value: 'opusplan', label: 'Opus Plan（规划用 Opus，执行用 Sonnet）' },
];

/** A concrete Claude model id such as `claude-opus-5-5` or `claude-fable-5-1[1m]`. */
const CLAUDE_MODEL_ID = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*(?:\[1m\])?$/;

/** `claude-opus-5-5[1m]` → `Opus 5.5 · 1M`; anything unrecognised keeps its id. */
export function claudeModelIdLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(\[1m\])?$/.exec(id);
  if (!m || !m[1] || !m[2]) return id;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const version = m[3] ? `${m[2]}.${m[3]}` : m[2];
  return `${family} ${version}${m[4] ? ' · 1M' : ''}`;
}

/**
 * Account-specific extras Claude Code caches in `~/.claude.json`
 * (`additionalModelOptionsCache`), e.g. a Fable 1M option. Returns `[]` for
 * anything unreadable so the picker falls back to the aliases.
 */
export function parseClaudeAdditionalModels(raw: string): ModelOption[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  const extras = (doc as { additionalModelOptionsCache?: unknown })?.additionalModelOptionsCache;
  if (!Array.isArray(extras)) return [];
  return extras
    .filter(
      (e): e is { value: string; label?: unknown; description?: unknown } =>
        typeof e === 'object' && e !== null && typeof (e as { value?: unknown }).value === 'string',
    )
    .filter((e) => CLAUDE_MODEL_ID.test(e.value) || CLAUDE_ALIASES.some((a) => a.value === e.value))
    .map((e) => {
      const description = typeof e.description === 'string' ? e.description.split(' · ')[0] : '';
      const base = description || claudeModelIdLabel(e.value);
      const label = e.value.endsWith('[1m]') && !base.includes('1M') ? `${base} · 1M` : base;
      return { value: e.value, label };
    });
}

let claudeExtrasCache: { at: number; entries: ModelOption[] } | undefined;
const CLAUDE_EXTRAS_TTL_MS = 60_000;

function claudeAdditionalModels(now: number = Date.now()): ModelOption[] {
  if (claudeExtrasCache && now - claudeExtrasCache.at < CLAUDE_EXTRAS_TTL_MS) return claudeExtrasCache.entries;
  let entries: ModelOption[] = [];
  try {
    const path = process.env.CLAUDE_CONFIG_DIR
      ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
      : join(homedir(), '.claude.json');
    entries = parseClaudeAdditionalModels(readFileSync(path, 'utf8'));
  } catch {
    entries = [];
  }
  claudeExtrasCache = { at: now, entries };
  return entries;
}

/** Test hook: forget the memoized Claude extras. */
export function resetClaudeModelCache(): void {
  claudeExtrasCache = undefined;
}

function claudeModels(): ModelOption[] {
  const out: ModelOption[] = [{ value: DEFAULT_MODEL, label: '跟随默认（不指定）' }, ...CLAUDE_ALIASES];
  for (const extra of claudeAdditionalModels()) {
    if (!out.some((m) => m.value === extra.value)) out.push(extra);
  }
  return out;
}

/** One entry of the Codex CLI's own model catalog. */
export interface CodexModelEntry {
  slug: string;
  label: string;
  /** Efforts the model accepts, in the CLI's order; empty when unknown. */
  efforts: EffortLevel[];
}

/**
 * Fallback when the Codex model cache can't be read (Codex never ran on this
 * machine, or the cache format moved). Mirrors the listed models of
 * codex-cli 0.156; the live cache wins whenever it is present.
 */
const CODEX_FALLBACK_CATALOG: CodexModelEntry[] = [
  { slug: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: [...CODEX_EFFORT_LEVELS] },
  { slug: 'gpt-6-sol', label: 'GPT-6-Sol', efforts: [...CODEX_EFFORT_LEVELS] },
  { slug: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: [...EFFORT_LEVELS] },
  { slug: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: [...CODEX_EFFORT_LEVELS] },
  { slug: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: [...CODEX_EFFORT_LEVELS] },
  { slug: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: [...EFFORT_LEVELS] },
  { slug: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
];

/** Where Codex keeps `models_cache.json` — the same home a profile inherits by default. */
function codexHomeDir(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/**
 * Parse Codex's `models_cache.json` into picker entries: only models the CLI
 * itself lists (`visibility: "list"`), in its priority order. Returns `[]`
 * for anything unreadable so callers fall back rather than fail.
 */
export function parseCodexModelsCache(raw: string): CodexModelEntry[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  const models = (doc as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter(
      (m): m is Record<string, unknown> =>
        typeof m === 'object' && m !== null && typeof (m as { slug?: unknown }).slug === 'string',
    )
    .filter((m) => m.visibility === undefined || m.visibility === 'list')
    .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))
    .map((m) => ({
      slug: m.slug as string,
      label: typeof m.display_name === 'string' && m.display_name ? m.display_name : (m.slug as string),
      efforts: Array.isArray(m.supported_reasoning_levels)
        ? (m.supported_reasoning_levels as unknown[])
            .map((l) => (typeof l === 'object' && l !== null ? (l as { effort?: unknown }).effort : l))
            .filter((e): e is EffortLevel => CODEX_EFFORT_LEVELS.includes(e as EffortLevel))
        : [],
    }));
}

let codexCatalogCache: { at: number; entries: CodexModelEntry[] } | undefined;
const CODEX_CATALOG_TTL_MS = 60_000;

/**
 * The Codex model catalog: the CLI's live cache when readable, else the
 * pinned fallback. Re-read at most once a minute, so a Codex upgrade shows
 * up in `/config` without restarting the bridge.
 */
export function codexModelCatalog(now: number = Date.now()): CodexModelEntry[] {
  if (codexCatalogCache && now - codexCatalogCache.at < CODEX_CATALOG_TTL_MS) {
    return codexCatalogCache.entries;
  }
  let entries: CodexModelEntry[] = [];
  try {
    entries = parseCodexModelsCache(readFileSync(join(codexHomeDir(), 'models_cache.json'), 'utf8'));
  } catch {
    entries = [];
  }
  if (entries.length === 0) entries = CODEX_FALLBACK_CATALOG;
  codexCatalogCache = { at: now, entries };
  return entries;
}

/** Test hook: forget the memoized Codex catalog. */
export function resetCodexModelCatalogCache(): void {
  codexCatalogCache = undefined;
}

/** Codex CLI models. Forwarded to `codex exec --model`. */
function codexModels(): ModelOption[] {
  return [
    { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
    ...codexModelCatalog().map((m) => ({ value: m.slug, label: m.label })),
  ];
}

/**
 * The model picker options for a profile's agent kind. Pass the stored
 * selection as `current` so a pinned Claude id chosen earlier (e.g.
 * `claude-opus-5-5`) stays selectable instead of silently resetting.
 */
export function supportedModels(agentKind: AgentKind, current?: string): ModelOption[] {
  return MODEL_CATALOGS[agentKind].models(current);
}

function claudeModelOptions(current?: string): ModelOption[] {
  const options = claudeModels();
  if (current && isPinnedClaudeModel(current) && !options.some((m) => m.value === current)) {
    options.push({ value: current, label: claudeModelIdLabel(current) });
  }
  return options;
}

/** A concrete, well-formed Claude model id — accepted even when no picker lists it. */
function isPinnedClaudeModel(value: string): boolean {
  return CLAUDE_MODEL_ID.test(value);
}

/** The effort picker options for a profile's agent kind, in the CLI's order. */
export function supportedEfforts(agentKind: AgentKind): readonly EffortLevel[] {
  return MODEL_CATALOGS[agentKind].efforts;
}

/** True when the selection means "use the agent default" (no `--model`). */
export function isDefaultModel(value: string | undefined): boolean {
  return !value || value === DEFAULT_MODEL;
}

/**
 * Coerce a stored model preference into a value guaranteed to be one of the
 * current agent's picker options — Feishu's `select_static` requires
 * `initial_option` to match an option value exactly. Unknown / cross-agent
 * values (e.g. a Claude alias left over after switching a profile to Codex)
 * fall back to {@link DEFAULT_MODEL}.
 */
export function normalizeModelSelection(
  agentKind: AgentKind,
  value: string | undefined,
): string {
  if (isDefaultModel(value)) return DEFAULT_MODEL;
  return supportedModels(agentKind, value).some((m) => m.value === value)
    ? (value as string)
    : DEFAULT_MODEL;
}

/**
 * Resolve the concrete model string to hand the agent, or `undefined` to omit
 * the `--model` flag. Cross-agent / unknown values are treated as "default".
 */
export function resolveModelArg(
  agentKind: AgentKind,
  value: string | undefined,
): string | undefined {
  const normalized = normalizeModelSelection(agentKind, value);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/**
 * Resolve the concrete effort to hand the agent, or `undefined` to omit it.
 * Validated against the agent's own levels ({@link supportedEfforts}): a
 * Codex-only level such as `ultra` never reaches Claude's `--effort`.
 * Unknown levels (hand-edited config, a level a future CLI drops) fall back
 * to the CLI default rather than failing the run.
 */
export function resolveEffortArg(
  agentKind: AgentKind,
  value: string | undefined,
): EffortLevel | undefined {
  return supportedEfforts(agentKind).includes(value as EffortLevel)
    ? (value as EffortLevel)
    : undefined;
}

/**
 * Fit a Codex effort to what the chosen model accepts. Models differ
 * (e.g. GPT-5.5 stops at `xhigh`), and Codex rejects a level the model
 * lacks, so an over-high pick steps down to the model's highest supported
 * level instead of failing the run. With no explicit model (Codex config
 * decides) or a model the catalog doesn't know, the level passes through.
 */
export function clampCodexEffort(
  model: string | undefined,
  effort: EffortLevel | undefined,
  catalog: CodexModelEntry[] = codexModelCatalog(),
): EffortLevel | undefined {
  if (!effort || !model) return effort;
  const supported = catalog.find((m) => m.slug === model)?.efforts ?? [];
  if (supported.length === 0 || supported.includes(effort)) return effort;
  const rank = CODEX_EFFORT_LEVELS.indexOf(effort);
  const fitting = supported.filter((e) => CODEX_EFFORT_LEVELS.indexOf(e) <= rank);
  return fitting.length > 0 ? fitting[fitting.length - 1] : supported[0];
}

/** Picker label for a stored value, for display in the saved-config card. */
export function modelLabel(agentKind: AgentKind, value: string | undefined): string {
  const normalized = normalizeModelSelection(agentKind, value);
  return supportedModels(agentKind, normalized).find((m) => m.value === normalized)?.label ?? normalized;
}

/**
 * Reply-card byline label once the agent has reported the model it actually
 * loaded: the concrete version first, then the `/config` choice it was resolved
 * from when that differs (an "always latest" alias or "follow default").
 * `claude-opus-5-5` under `opus` → `Opus 5.5 · 配置 Opus（始终最新）`.
 */
export function resolvedModelLabel(
  agentKind: AgentKind,
  configValue: string | undefined,
  actualId: string,
): string {
  const configured = modelLabel(agentKind, configValue);
  const actual = MODEL_CATALOGS[agentKind].actualModelLabel(actualId);
  return actual === configured ? actual : `${actual} · 配置 ${configured}`;
}

interface AgentModelCatalog {
  /** `/config` model picker options; `current` keeps a stored pinned id selectable. */
  models(current?: string): ModelOption[];
  /** Effort levels the CLI accepts, in its own order. */
  efforts: readonly EffortLevel[];
  /** Byline label for the concrete model id the CLI reports it loaded. */
  actualModelLabel(id: string): string;
}

const MODEL_CATALOGS: Record<AgentKind, AgentModelCatalog> = {
  claude: { models: claudeModelOptions, efforts: EFFORT_LEVELS, actualModelLabel: claudeModelIdLabel },
  codex: { models: () => codexModels(), efforts: CODEX_EFFORT_LEVELS, actualModelLabel: (id) => id },
};
