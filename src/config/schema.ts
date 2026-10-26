export type TenantBrand = 'feishu' | 'lark';

/**
 * SecretRef points at a secret stored outside this file — keeps secrets out
 * of `config.json` so backups / accidental git commits / log dumps don't
 * leak the bot's App Secret. Matches lark-cli's `SecretRef` shape so
 * `--source lark-channel` reads it through the same generic
 * `ResolveSecretInput` pipeline.
 *
 *   - `env`:  value is in process env at `id` (optionally allowlisted via provider)
 *   - `file`: value is at the path `id` (or `provider.path` if provider config)
 *   - `exec`: spawn `provider.command`, send JSON over stdin, read JSON from stdout
 */
export interface SecretRef {
  source: 'env' | 'file' | 'exec';
  provider?: string;
  id: string;
}

/** A secret field can be either a plain string (potentially a `${VAR}`
 * template) or a SecretRef. JSON deserializer accepts both forms. */
export type SecretInput = string | SecretRef;

export interface AppCredentials {
  id: string;
  secret: SecretInput;
  tenant: TenantBrand;
}

/**
 * `secrets.providers` declares how SecretRefs resolve to plaintext (env
 * allowlist, file path, exec command). Only the fields actually consumed by
 * bridge's resolver are typed here; lark-cli reads the same JSON via its
 * richer Go types.
 */
export interface ProviderConfig {
  source: 'env' | 'file' | 'exec';
  /** env: allowlist of env var names that ref.id is allowed to be in. */
  allowlist?: string[];
  /** file: optional base path; ref.id is joined onto it. */
  path?: string;
  /** exec: command to spawn + args. */
  command?: string;
  args?: string[];
  /** exec: explicit env to inject (key=value pairs). */
  env?: Record<string, string>;
  /** exec: env var names to pass through from parent env. */
  passEnv?: string[];
  /** exec: max ms to wait for the child. */
  noOutputTimeoutMs?: number;
  /** exec: max stdout bytes accepted before treating as runaway. */
  maxOutputBytes?: number;
}

export interface SecretsConfig {
  providers?: Record<string, ProviderConfig>;
  defaults?: { env?: string; file?: string; exec?: string };
}

/**
 * How replies are rendered in IM chats:
 *   - `card`: full interactive card (tool panels, ⏹ button, footer status)
 *   - `markdown`: lightweight streaming markdown card (typewriter, no buttons)
 *   - `text`: plain markdown post sent once at run completion (no streaming)
 *
 * Pre-0.1.27 only had `card` and `text`, where `text` meant what's now called
 * `markdown`. See `messageReplyMigrated` for the auto-coercion logic.
 */
export type MessageReplyMode = 'card' | 'markdown' | 'text';
export type CotMessagesMode = 'off' | 'brief' | 'detailed';
/**
 * Reasoning effort levels across agents. Claude Code's `--effort` accepts
 * {@link EFFORT_LEVELS}; Codex's `model_reasoning_effort` accepts
 * {@link CODEX_EFFORT_LEVELS}, which adds `ultra`.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
/** Claude Code `--effort` levels, in the CLI's own order. */
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Codex `model_reasoning_effort` levels, in the CLI's own order. */
export const CODEX_EFFORT_LEVELS: readonly EffortLevel[] = [...EFFORT_LEVELS, 'ultra'];
/** Every level any agent accepts — what a stored preference is validated against. */
export const ALL_EFFORT_LEVELS: readonly EffortLevel[] = CODEX_EFFORT_LEVELS;
/** Display labels for {@link EffortLevel}, for `/config` and the web console. */
export const EFFORT_LEVEL_LABELS: Record<EffortLevel, string> = {
  low: '低（low）',
  medium: '中（medium）',
  high: '高（high）',
  xhigh: '很高（xhigh）',
  max: '最高（max）',
  ultra: '极限（ultra，自动分派子任务）',
};

/**
 * Access control settings. Empty lists are fail-closed in the v2 policy:
 * no DM senders, no group chats, and only the runtime owner can administer
 * the bot. Runtime owner/admin bypass is applied by the policy layer because
 * owner identity is refreshed from Lark rather than stored in config.json.
 */
export interface AppAccess {
  /** open_id allowlist for DM senders. Group senders are gated by chat. */
  allowedUsers?: string[];
  /** chat_id allowlist for groups the bot responds in. Does not apply to p2p. */
  allowedChats?: string[];
  /** open_id list with admin privileges. Gates sensitive commands
   * (/account, /config, /exit, /reconnect, /doctor, /cd, /ws, /doc,
   * /invite, /remove). */
  admins?: string[];
  /** Per-chat @-mention override (chat_id → bool); overrides the global
   * requireMentionInGroup for the listed chats. */
  chatRequireMention?: Record<string, boolean>;
}

export interface AppPreferences {
  /** Reply rendering mode for IM (group/p2p) messages. Default 'card'. */
  messageReply?: MessageReplyMode;
  /**
   * Internal marker: pre-0.1.27 the value `'text'` meant "lightweight
   * streaming markdown card" (what's now called `'markdown'`). On upgrade
   * we'd silently switch those users to true plain-text behavior unless we
   * coerce; this flag is set the first time the user submits `/config`
   * after the rename, indicating their `messageReply` value is in the
   * new semantic.
   */
  messageReplyMigrated?: boolean;
  /**
   * Whether to render tool-call blocks (Bash / Read / Edit / ...) in the
   * output. Default true. Turn off if you only care about Claude's final
   * text answer and want to hide the "工具调用过程".
   */
  showToolCalls?: boolean;
  /**
   * Model the underlying agent runs with, forwarded as `--model`. The catalog
   * of valid values is agent-kind specific — see `agent/models.ts`. `undefined`
   * or the `'default'` sentinel means "don't pass `--model`" so the agent
   * CLI / account default applies. Default: unset.
   */
  model?: string;
  /**
   * Reasoning effort. Forwarded as Claude Code's `--effort`, or as Codex's
   * `-c model_reasoning_effort=…` (clamped to what the chosen model
   * supports). `undefined` means "don't pass it" and the CLI / Codex config
   * default applies. Default: unset.
   */
  effort?: EffortLevel;
  /**
   * Model Claude Code's subagents default to (`CLAUDE_CODE_SUBAGENT_MODEL`),
   * e.g. `sonnet`: a subagent whose definition or call names a model keeps
   * that one, so the agent can still ask for `opus` where it matters. Chats,
   * meetings and scheduled jobs only; 课堂精练 keeps the session's model.
   * Config-file only. Default: unset (subagents run on the session's model).
   */
  subagentModel?: string;
  /**
   * Per-chat override of {@link effort}, keyed by chat_id (a group's topics
   * follow the group). Chats not listed use `effort`. Hand-edited only;
   * `/config` still edits the profile-wide value.
   */
  chatEffort?: Record<string, EffortLevel>;
  /**
   * Whether to send a separate Lark COT process message before the final
   * answer. `brief` mirrors the lightweight tool/progress visibility from
   * the legacy tool display; `detailed` also includes tool args/output.
   * Legacy boolean/string `on` is accepted by the resolver for upgrades.
   */
  cotMessages?: CotMessagesMode | 'on' | 'simple';
  /**
   * Cap on concurrent claude runs across all chats / topics. Excess runs
   * queue FIFO. Default 10. Mostly relevant for topic groups where each
   * topic can spawn its own run; capping protects RAM / token spend.
   */
  maxConcurrentRuns?: number;
  /**
   * Global default idle-timeout for claude runs, in minutes. When set,
   * if claude emits no stream event for this long the bridge kills the
   * run as presumed-hung. Undefined / 0 = no timeout (the default — runs
   * can hang indefinitely). Per-scope `/timeout` overrides this.
   */
  runIdleTimeoutMinutes?: number;
  /**
   * 长任务完成提醒. A streamed reply card is updated in place, so finishing a
   * long run makes no sound on the requester's phone. When a group / topic run
   * — or a DM run whose answer landed in that in-place card — ends after at
   * least this many minutes, the bot posts a short reply that pushes (in
   * groups it @-mentions the requesters). Default 5; 0 turns it off.
   * Config-file only.
   */
  longRunNoticeMinutes?: number;
  /**
   * 过载保护: in these group chats, a batch made only of other bots' messages
   * is not answered while the agent account's quota is tight — the bot posts
   * an overload card instead and starts no run. Humans are always answered.
   * Config-file only. See {@link resolveBotOverload}.
   */
  botOverload?: BotOverloadConfig;
  /**
   * Whether the bot only responds to messages that @-mention it in groups
   * (regular and topic groups). p2p is always unrestricted. Default true:
   * groups are quiet unless the user @bot. Set false to let any group
   * message reach Claude (the 0.1.21-and-earlier behavior).
   *
   * @全员 is never responded to regardless (SDK `respondToMentionAll: false`).
   * Cloud-doc comments still require @-mention unconditionally.
   */
  requireMentionInGroup?: boolean;
  /** Access control — user/chat allowlists + admin gating. See AppAccess. */
  access?: AppAccess;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when killing the claude
   * subprocess. Bumped from a hardcoded 500ms because claude often has its
   * own subprocesses (e.g. lark-cli mid-OAuth) that need a moment to clean
   * up — too short a window and the SIGKILL cascade kills the descendants
   * before they can finish what the user is waiting on. Default 5000ms.
   * Range 100-30000; out-of-range values fall back to default.
   */
  agentStopGraceMs?: number;
  /**
   * 会话智能压缩. When on, a conversation that has gone idle with a large
   * context — or that the agent itself marked finished — is archived and the
   * next message starts a fresh session (still listed in `/resume`), and the
   * agent CLI is asked to auto-compact long sessions earlier. Default off.
   */
  smartSession?: boolean;
  /** Clean idle, merged bridge-managed worktrees; default off. */
  autoWorktreeCleanup?: boolean;
  /** Minimum idle days before cleanup, 1–365, default 7. */
  worktreeCleanupIdleDays?: number;
  /** Thresholds behind {@link smartSession}; config-file only. See {@link getSmartSession}. */
  smartSessionTuning?: SmartSessionTuning;
  /**
   * 课堂精练. When on, an admin's `/practice run` turns ended conversations into
   * reviewable Draft PRs against the knowledge repo and the profile's own skill
   * library. Never merges. Independent of {@link smartSession}. Default off.
   */
  dream?: boolean;
  /**
   * 自动整理, on top of {@link dream}: the bridge starts a run by itself — not on
   * a daily clock, but once enough new conversation has piled up, long enough
   * after the last run, with the previous batch reviewed, inside the allowed
   * hours and while the profile is idle. Default off.
   */
  dreamAuto?: boolean;
  /** Limits behind {@link dream}; config-file only. See {@link getDream}. */
  dreamTuning?: DreamTuning;
}

export interface BotOverloadConfig {
  /** Group chats (`oc_…`) the rule applies to; `"*"`: every group and topic chat. Empty: off. */
  chats?: string[];
  /** Weekly window used above this (percent) … Default 80. */
  weekPercent?: number;
  /** … unless it resets within this many hours. Default 6. */
  weekGraceHours?: number;
  /** 5-hour window used above this (percent) … Default 80. */
  sessionPercent?: number;
  /** … unless it resets within this many hours. Default 1. */
  sessionGraceHours?: number;
  /** At most one overload card per chat this often; the rest are dropped silently. Default 10. */
  cooldownMinutes?: number;
  /** 白名单: chats (`oc_…`) never covered, even with `"*"`. */
  exceptChats?: string[];
  /** 白名单: bots (open_id `ou_…` or app id `cli_…`) whose messages are always answered. */
  exceptBots?: string[];
  /** Bot ↔ owner table: the overload card @s the owner of the bot that asked. */
  botOwners?: BotOwnerEntry[];
}

export interface BotOwnerEntry {
  /** Display name, for people reading the config. */
  name?: string;
  /** Every id the bot is known by: open_id `ou_…`, app id `cli_…`. */
  ids: string[];
  /** The owner's open_id. */
  owner: string;
  ownerName?: string;
}

export interface BotOverloadSettings {
  /** Listed chats; `['*']` means every group. */
  chats: string[];
  weekPercent: number;
  weekGraceHours: number;
  sessionPercent: number;
  sessionGraceHours: number;
  cooldownMinutes: number;
  exceptChats: string[];
  exceptBots: string[];
  botOwners: BotOwnerEntry[];
}

/** 过载保护 settings, or `undefined` when no chat is listed. Out-of-range values fall back to the defaults. */
export function resolveBotOverload(cfg: Pick<AppConfig, 'preferences'>): BotOverloadSettings | undefined {
  const raw = cfg.preferences?.botOverload;
  const chats = Array.isArray(raw?.chats)
    ? raw.chats
        .filter((chat): chat is string => typeof chat === 'string' && (/^oc_[\w-]+$/.test(chat.trim()) || chat.trim() === '*'))
        .map((chat) => chat.trim())
    : [];
  if (chats.length === 0) return undefined;
  const all = chats.includes('*');
  const pick = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  return {
    chats: all ? ['*'] : chats,
    weekPercent: pick(raw?.weekPercent, 1, 100, 80),
    weekGraceHours: pick(raw?.weekGraceHours, 0, 168, 6),
    sessionPercent: pick(raw?.sessionPercent, 1, 100, 80),
    sessionGraceHours: pick(raw?.sessionGraceHours, 0, 5, 1),
    cooldownMinutes: pick(raw?.cooldownMinutes, 0, 24 * 60, 10),
    exceptChats: ids(raw?.exceptChats, /^oc_[\w-]+$/),
    exceptBots: ids(raw?.exceptBots, /^(?:ou|cli)_[\w-]+$/),
    botOwners: (Array.isArray(raw?.botOwners) ? raw.botOwners : []).flatMap((entry): BotOwnerEntry[] => {
      if (!entry || typeof entry !== 'object' || typeof entry.owner !== 'string' || !/^ou_[\w-]+$/.test(entry.owner.trim())) return [];
      const botIds = ids(entry.ids, /^(?:ou|cli)_[\w-]+$/);
      if (botIds.length === 0) return [];
      return [
        {
          ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
          ids: botIds,
          owner: entry.owner.trim(),
          ...(typeof entry.ownerName === 'string' ? { ownerName: entry.ownerName } : {}),
        },
      ];
    }),
  };
}

function ids(raw: unknown, shape: RegExp): string[] {
  return Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === 'string' && shape.test(id.trim())).map((id) => id.trim())
    : [];
}

export interface DreamTuning {
  /** Conversations read per run, newest first. Default 20. */
  maxSessions?: number;
  /** Transcript characters handed to the agent per run, all scopes together. Default 120000. */
  maxInputChars?: number;
  /** Wall-clock limit for one run's agent turns, in minutes. Default 20. */
  maxRunMinutes?: number;
  /**
   * 续跑: a run that left work behind (external files still pending, conversations
   * deferred for the run's input / count / time limits) is followed by another,
   * up to this many runs in a row. 1: one run only. Default 6.
   */
  drainRounds?: number;
  /** A conversation still active is read only after this many idle minutes. Default 30. */
  minIdleMinutes?: number;
  /**
   * `skills.libraries[].name` new skills go to. Needed only when more than one
   * library is configured; absent with exactly one, that one.
   */
  skillLibrary?: string;
  /** Only these chat / topic scopes. Absent: every chat scope. */
  scopes?: string[];
  /** 自动整理: hours a run may start in, `HH:MM-HH:MM` (may wrap midnight). Default `01:00-07:00`. */
  window?: string;
  /** IANA time zone of {@link window}. Default: the host's. */
  timezone?: string;
  /** 材料够: conversation scopes with new exchanges that make a run worth it. Default 5. */
  minScopes?: number;
  /** 材料够 (either is enough): new transcript characters. Default 60000. */
  minInputChars?: number;
  /** 间隔够: days since the last completed run. Default 3. */
  minIntervalDays?: number;
  /** Past this many days, any new input is enough; 0 turns the fallback off. Default 14. */
  maxIntervalDays?: number;
  /** 审得过来: open dream Draft PRs per target repository that pause automatic runs. Default 1. */
  maxOpenPrs?: number;
  /** Consecutive failed automatic runs after which they pause until a manual run succeeds. Default 3. */
  maxAutoFailures?: number;
  /** Skip automatic runs once any quota window of the agent account is this full (percent). Default 80. */
  maxQuotaPercent?: number;
  /** Which window {@link maxQuotaPercent} looks at: `any` — the fullest (default) — or `week`, the weekly one only. */
  quotaWindow?: 'any' | 'week';
  /**
   * `HH:MM` (in {@link timezone}): over {@link maxQuotaPercent} is no reason
   * to skip when that window resets today before this time — whatever is
   * left would be thrown away by the reset anyway. Absent: always skip.
   */
  quotaResetBefore?: string;
  /**
   * 每日模式: 自动整理 starts at this local time (`HH:MM`, in {@link timezone})
   * every day instead of waiting for material to pile up. The allowed hours
   * become the three hours from it ({@link window} is ignored), and the
   * interval, material and review-backlog gates are skipped; the others hold.
   */
  dailyAt?: string;
  /**
   * `pr` (default): every target gets a Draft PR for review. `push`: the batch
   * is committed straight onto the default branch and pushed, each repository
   * keeping a `CHANGELOG.md` of what every batch changed — for a profile whose
   * owner chose to let it learn without review.
   */
  publish?: 'pr' | 'push';
  /**
   * How changes to skills that already exist are published; default: as
   * {@link publish}. With `publish: push` and `skillUpdates: pr`, new skills
   * go straight onto the default branch but a rewrite of an existing one
   * waits in a Draft PR for review.
   */
  skillUpdates?: 'pr' | 'push';
  /**
   * 课前学习: repositories (other bots' knowledge / skill libraries) studied at
   * the start of every run, only what changed since the last run. Read-only:
   * never written to. What is worth keeping lands in this profile's own
   * knowledge repo (notes) and skill library.
   */
  externalLibraries?: DreamExternalLibraryConfig[];
  /** Every skill a run writes must declare `argument-hint` in its frontmatter; own skills without one get it added. */
  requireArgumentHint?: boolean;
  /**
   * Skills are named `<project>:<skill>`; keys are the allowed projects, values
   * say what each covers (shown to the model so it can pick one). A new skill
   * must use one of them, lives in directory `<project>-<skill>`, and its short
   * name (after the colon) must not clash with any skill already loaded.
   * Absent or empty: plain kebab-case names as before.
   */
  skillProjects?: Record<string, string>;
  /**
   * Skill directories the agent CLI loads by itself (`~/.claude/skills`…):
   * listed by name to 课前学习 so it does not create a library copy of a
   * skill the profile already has.
   */
  localSkillDirs?: string[];
  /**
   * Local clones of the target repositories that something else reads from
   * (`~/.claude/skills/<name>` linked into a clone of the skill library…):
   * after `publish: push` reaches a repository, a clone here whose `origin` is
   * that repository is fast-forwarded (`git pull --ff-only`).
   */
  localClones?: string[];
  /** Chat (`oc_…`) or user (`ou_…`) told the outcome of every automatic run. Absent: automatic runs stay silent. */
  notifyChat?: string;
}

export interface DreamExternalLibraryConfig {
  /** Slug: letters, digits, `.`, `_`, `-`. */
  name: string;
  /** Git URL, cloned read-only. */
  url: string;
  /** Branch to follow; absent: the remote's default branch. */
  ref?: string;
}

export interface DreamAutoSettings {
  /** Minutes after local midnight; `end` may be smaller than `start` (wraps midnight). */
  window: { start: number; end: number; text: string };
  timezone: string;
  minScopes: number;
  minInputChars: number;
  minIntervalDays: number;
  /** 0: no fallback. */
  maxIntervalDays: number;
  maxOpenPrs: number;
  maxAutoFailures: number;
  maxQuotaPercent: number;
  quotaWindow: 'any' | 'week';
  /** Over the quota limit is fine when the window resets today before this local time. */
  quotaResetBefore?: { at: number; text: string };
  /** 每日模式: start time, minutes after local midnight; {@link window} is then derived from it. */
  daily?: { at: number; text: string };
}

export interface DreamSettings {
  maxSessions: number;
  maxInputChars: number;
  maxRunMinutes: number;
  /** See {@link DreamTuning.drainRounds}. */
  drainRounds: number;
  minIdleMinutes: number;
  skillLibrary?: string;
  scopes?: string[];
  publish: 'pr' | 'push';
  skillUpdates: 'pr' | 'push';
  external: DreamExternalLibraryConfig[];
  requireArgumentHint: boolean;
  /** Empty: plain kebab-case skill names. See {@link DreamTuning.skillProjects}. */
  skillProjects: Record<string, string>;
  localSkillDirs: string[];
  localClones: string[];
  notifyChat?: string;
  auto: DreamAutoSettings;
}

/** 每日模式 runs may start within this many minutes of {@link DreamAutoSettings.daily}. */
export const DREAM_DAILY_WINDOW_MINUTES = 180;

export const DREAM_AUTO_DEFAULTS: DreamAutoSettings = {
  window: { start: 60, end: 420, text: '01:00-07:00' },
  timezone: hostTimeZone(),
  minScopes: 5,
  minInputChars: 60_000,
  minIntervalDays: 3,
  maxIntervalDays: 14,
  maxOpenPrs: 1,
  maxAutoFailures: 3,
  maxQuotaPercent: 80,
  quotaWindow: 'any',
};

export const DREAM_DEFAULTS: DreamSettings = {
  maxSessions: 20,
  maxInputChars: 120_000,
  maxRunMinutes: 20,
  drainRounds: 6,
  minIdleMinutes: 30,
  publish: 'pr',
  skillUpdates: 'pr',
  external: [],
  requireArgumentHint: false,
  skillProjects: {},
  localSkillDirs: [],
  localClones: [],
  auto: DREAM_AUTO_DEFAULTS,
};

export interface SmartSessionTuning {
  /** Idle this long with a large context starts a fresh session. Default 60. */
  idleMinutes?: number;
  /** What counts as a large context, in tokens. Default 150000. */
  minContextTokens?: number;
  /** Idle this long starts a fresh session whatever the context size. Default 480. */
  hardIdleMinutes?: number;
  /** Context window the agent CLI auto-compacts against, in tokens. Default 300000. */
  compactWindowTokens?: number;
}

export interface SmartSessionSettings {
  idleMinutes: number;
  minContextTokens: number;
  hardIdleMinutes: number;
  compactWindowTokens: number;
}

export const SMART_SESSION_DEFAULTS: SmartSessionSettings = {
  idleMinutes: 60,
  minContextTokens: 150_000,
  hardIdleMinutes: 480,
  compactWindowTokens: 300_000,
};

/**
 * Top-level config shape on disk.
 *
 * `accounts` is a namespace for credential-flavored fields (currently just
 * the bot app, room for OAuth / alternate apps later). `preferences`
 * holds user-tunable behavior knobs. Other future sections (mcp, etc.)
 * belong at this top level alongside them.
 */
export interface AppConfig {
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  preferences?: AppPreferences;
}

export function isComplete(cfg: Partial<AppConfig>): cfg is AppConfig {
  const app = cfg.accounts?.app;
  return Boolean(app?.id && hasSecret(app?.secret) && app?.tenant);
}

function hasSecret(s: SecretInput | undefined): boolean {
  if (!s) return false;
  if (typeof s === 'string') return s.length > 0;
  return Boolean(s.source && s.id);
}

/** True iff this credential's secret is stored externally (env/file/exec). */
export function isSecretRef(s: SecretInput): s is SecretRef {
  return typeof s === 'object' && s !== null;
}

/** Account/keystore key for the bot's App Secret. lark-cli also uses a
 * similar `appsecret:` convention so audit/grep is consistent. */
export function secretKeyForApp(appId: string): string {
  return `app-${appId}`;
}

/**
 * Resolve the message-reply preference with default fallback + legacy coerce.
 *
 * Pre-0.1.27 users with `messageReply: 'text'` actually wanted the streaming
 * markdown card (the new `'markdown'`). Until they re-submit `/config`
 * (which sets `messageReplyMigrated: true`), we map their `text` →
 * `markdown` so the behavior stays the same after upgrade.
 *
 * Default for fresh configs (no `messageReply` set) is `'markdown'`.
 */
export function getMessageReplyMode(cfg: AppConfig): MessageReplyMode {
  const raw = cfg.preferences?.messageReply;
  if (raw === 'text' && cfg.preferences?.messageReplyMigrated !== true) {
    return 'markdown';
  }
  if (raw === 'card' || raw === 'markdown' || raw === 'text') return raw;
  return 'markdown';
}

/** Resolve the show-tool-calls preference with default fallback. */
export function getShowToolCalls(cfg: AppConfig): boolean {
  return cfg.preferences?.showToolCalls !== false;
}

/**
 * Resolve the stored effort preference, or `undefined` for "follow the CLI
 * default" (unset, or a value outside {@link ALL_EFFORT_LEVELS} — e.g.
 * hand-edited config, or a level a future CLI drops). Callers that need the
 * per-agent gating should go through `resolveEffortArg` instead.
 */
export function getEffort(cfg: AppConfig): EffortLevel | undefined {
  const raw = cfg.preferences?.effort;
  return ALL_EFFORT_LEVELS.includes(raw as EffortLevel) ? (raw as EffortLevel) : undefined;
}

/**
 * The effort preference that applies in one chat: its `chatEffort` entry,
 * else the profile-wide `effort`. Returns the raw stored value; pass it
 * through `resolveEffortArg` for the per-agent gating.
 */
export function effortPrefForChat(
  prefs: Pick<AppPreferences, 'effort' | 'chatEffort'> | undefined,
  chatId: string | undefined,
): EffortLevel | undefined {
  const override = chatId ? prefs?.chatEffort?.[chatId] : undefined;
  // A mistyped override falls back to the profile value, not to the CLI default.
  return ALL_EFFORT_LEVELS.includes(override as EffortLevel) ? override : prefs?.effort;
}

export function getCotMessages(cfg: AppConfig): CotMessagesMode {
  const raw = cfg.preferences?.cotMessages;
  if (raw === 'brief' || raw === 'simple') return 'brief';
  if (raw === 'detailed' || raw === 'on') return 'detailed';
  return 'off';
}

/** Resolve the max-concurrent-runs preference with default + sanity clamp. */
export function getMaxConcurrentRuns(cfg: AppConfig): number {
  const raw = cfg.preferences?.maxConcurrentRuns;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 10;
  // Reasonable upper bound — at 50+ concurrent claudes the bot box is
  // probably already RAM-starved. Clamp to keep typos from killing the box.
  return Math.min(Math.floor(raw), 50);
}

/**
 * Resolve the require-mention-in-group preference. Default `true` — the
 * `!== false` check makes "undefined" (older configs that don't have the
 * field) inherit the new safer default automatically.
 */
export function getRequireMentionInGroup(cfg: AppConfig): boolean {
  if (cfg.preferences?.requireMentionInGroup !== undefined) {
    return cfg.preferences.requireMentionInGroup !== false;
  }
  const profileAccess = (cfg as AppConfig & {
    access?: { requireMentionInGroup?: boolean };
  }).access;
  if (profileAccess?.requireMentionInGroup !== undefined) {
    return profileAccess.requireMentionInGroup;
  }
  return true;
}

/**
 * Resolve the global default idle-timeout in ms. Returns `undefined` when
 * disabled (the default). Clamps to [1, 120] minutes when set so a typo
 * can't lock the bot into a 1-second kill loop or wait forever to a number
 * the user didn't really mean.
 */
/**
 * Grace period before SIGKILL fallback when stopping a claude subprocess.
 * Returns ms. Defaults to 5000 (5 seconds). Clamps to [100, 30000] so a
 * typo can't either make stop() effectively SIGKILL-immediate or hang for
 * minutes.
 */
export function getAgentStopGraceMs(cfg: AppConfig): number {
  const raw = cfg.preferences?.agentStopGraceMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 5000;
  return Math.min(30_000, Math.max(100, Math.floor(raw)));
}

export function getRunIdleTimeoutMs(cfg: AppConfig): number | undefined {
  const raw = cfg.preferences?.runIdleTimeoutMinutes;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  const clamped = Math.min(Math.max(Math.floor(raw), 1), 120);
  return clamped * 60_000;
}

const DEFAULT_LONG_RUN_NOTICE_MINUTES = 5;

/** 长任务完成提醒 threshold in ms, or `undefined` when off. See `longRunNoticeMinutes`. */
export function getLongRunNoticeMs(cfg: AppConfig): number | undefined {
  const raw = cfg.preferences?.longRunNoticeMinutes;
  if (raw === undefined) return DEFAULT_LONG_RUN_NOTICE_MINUTES * 60_000;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(Math.max(Math.floor(raw), 1), 24 * 60) * 60_000;
}

/**
 * Resolved 会话智能压缩 settings, or `undefined` when the switch is off.
 * Out-of-range tuning values fall back to the defaults.
 */
export function getSmartSession(cfg: AppConfig): SmartSessionSettings | undefined {
  if (cfg.preferences?.smartSession !== true) return undefined;
  const tuning = cfg.preferences.smartSessionTuning ?? {};
  const pick = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : fallback;
  return {
    idleMinutes: pick(tuning.idleMinutes, 5, 24 * 60, SMART_SESSION_DEFAULTS.idleMinutes),
    minContextTokens: pick(tuning.minContextTokens, 10_000, 2_000_000, SMART_SESSION_DEFAULTS.minContextTokens),
    hardIdleMinutes: pick(tuning.hardIdleMinutes, 30, 30 * 24 * 60, SMART_SESSION_DEFAULTS.hardIdleMinutes),
    compactWindowTokens: pick(tuning.compactWindowTokens, 100_000, 2_000_000, SMART_SESSION_DEFAULTS.compactWindowTokens),
  };
}

/**
 * Resolved 课堂精练 limits, or `undefined` when the switch is off.
 * Out-of-range values fall back to the defaults.
 */
export function getDream(cfg: AppConfig): DreamSettings | undefined {
  if (cfg.preferences?.dream !== true) return undefined;
  return resolveDreamSettings(cfg.preferences.dreamTuning);
}

/**
 * 自动整理 settings, or `undefined` when either {@link AppPreferences.dream}
 * or {@link AppPreferences.dreamAuto} is off.
 */
export function getDreamAuto(cfg: AppConfig): DreamSettings | undefined {
  if (cfg.preferences?.dreamAuto !== true) return undefined;
  return getDream(cfg);
}

/** Projects a skill name may start with: kebab-case keys, each with a non-empty description. */
function resolveSkillProjects(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, text]) => /^[a-z0-9][a-z0-9-]*$/.test(key) && typeof text === 'string' && text.trim() !== '')
      .map(([key, text]) => [key, (text as string).trim()]),
  );
}

/** {@link getDream}'s limits whether or not the switch is on — for status displays. */
export function resolveDreamSettings(tuning: DreamTuning | undefined): DreamSettings {
  const raw = tuning ?? {};
  const pick = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : fallback;
  const library = typeof raw.skillLibrary === 'string' ? raw.skillLibrary.trim() : '';
  const scopes = Array.isArray(raw.scopes)
    ? raw.scopes.filter((scope): scope is string => typeof scope === 'string' && scope.trim() !== '').map((scope) => scope.trim())
    : [];
  const daily = typeof raw.dailyAt === 'string' ? parseDreamClock(raw.dailyAt) : undefined;
  const resetBefore = typeof raw.quotaResetBefore === 'string' ? parseDreamClock(raw.quotaResetBefore) : undefined;
  const notifyChat = typeof raw.notifyChat === 'string' && /^o[cu]_[\w-]+$/.test(raw.notifyChat.trim()) ? raw.notifyChat.trim() : '';
  return {
    maxSessions: pick(raw.maxSessions, 1, 200, DREAM_DEFAULTS.maxSessions),
    maxInputChars: pick(raw.maxInputChars, 10_000, 1_000_000, DREAM_DEFAULTS.maxInputChars),
    maxRunMinutes: pick(raw.maxRunMinutes, 2, 120, DREAM_DEFAULTS.maxRunMinutes),
    drainRounds: pick(raw.drainRounds, 1, 20, DREAM_DEFAULTS.drainRounds),
    minIdleMinutes: pick(raw.minIdleMinutes, 0, 7 * 24 * 60, DREAM_DEFAULTS.minIdleMinutes),
    ...(library ? { skillLibrary: library } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
    publish: raw.publish === 'push' ? 'push' : 'pr',
    skillUpdates: raw.skillUpdates === 'pr' || raw.skillUpdates === 'push' ? raw.skillUpdates : raw.publish === 'push' ? 'push' : 'pr',
    external: resolveExternalLibraries(raw.externalLibraries),
    requireArgumentHint: raw.requireArgumentHint === true,
    skillProjects: resolveSkillProjects(raw.skillProjects),
    localSkillDirs: absoluteDirs(raw.localSkillDirs),
    localClones: absoluteDirs(raw.localClones),
    ...(notifyChat ? { notifyChat } : {}),
    auto: {
      window:
        (daily ? dailyWindow(daily) : undefined) ??
        (typeof raw.window === 'string' ? parseDreamWindow(raw.window) : undefined) ??
        DREAM_AUTO_DEFAULTS.window,
      timezone: typeof raw.timezone === 'string' && isTimeZone(raw.timezone.trim()) ? raw.timezone.trim() : DREAM_AUTO_DEFAULTS.timezone,
      minScopes: pick(raw.minScopes, 1, 200, DREAM_AUTO_DEFAULTS.minScopes),
      minInputChars: pick(raw.minInputChars, 1_000, 1_000_000, DREAM_AUTO_DEFAULTS.minInputChars),
      minIntervalDays: pick(raw.minIntervalDays, 1, 90, DREAM_AUTO_DEFAULTS.minIntervalDays),
      maxIntervalDays: pick(raw.maxIntervalDays, 0, 365, DREAM_AUTO_DEFAULTS.maxIntervalDays),
      maxOpenPrs: pick(raw.maxOpenPrs, 1, 20, DREAM_AUTO_DEFAULTS.maxOpenPrs),
      maxAutoFailures: pick(raw.maxAutoFailures, 1, 20, DREAM_AUTO_DEFAULTS.maxAutoFailures),
      maxQuotaPercent: pick(raw.maxQuotaPercent, 10, 100, DREAM_AUTO_DEFAULTS.maxQuotaPercent),
      quotaWindow: raw.quotaWindow === 'week' ? 'week' : 'any',
      ...(resetBefore ? { quotaResetBefore: resetBefore } : {}),
      ...(daily ? { daily } : {}),
    },
  };
}

/** `HH:MM` → minutes after midnight. */
export function parseDreamClock(text: string): { at: number; text: string } | undefined {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return { at: hours * 60 + minutes, text: `${String(hours).padStart(2, '0')}:${match[2]}` };
}

function dailyWindow(daily: { at: number }): DreamAutoSettings['window'] | undefined {
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  return parseDreamWindow(`${clock(daily.at)}-${clock((daily.at + DREAM_DAILY_WINDOW_MINUTES) % 1440)}`);
}

/** Absolute (or `~/`) directories only. */
function absoluteDirs(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((dir): dir is string => typeof dir === 'string' && /^(?:~\/|\/)/.test(dir.trim())).map((dir) => dir.trim())
    : [];
}

const EXTERNAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Well-formed entries only, first of each name; the URL and ref are checked again before any git call. */
function resolveExternalLibraries(raw: unknown): DreamExternalLibraryConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: DreamExternalLibraryConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { name, url, ref } = item as Partial<DreamExternalLibraryConfig>;
    if (typeof name !== 'string' || !EXTERNAL_NAME_RE.test(name.trim())) continue;
    if (typeof url !== 'string' || !url.trim() || /\s/.test(url.trim())) continue;
    if (out.some((entry) => entry.name === name.trim())) continue;
    out.push({
      name: name.trim(),
      url: url.trim(),
      ...(typeof ref === 'string' && ref.trim() ? { ref: ref.trim() } : {}),
    });
  }
  return out;
}

/** `HH:MM-HH:MM` → minutes after midnight; a window that ends where it starts is refused. */
export function parseDreamWindow(text: string): DreamAutoSettings['window'] | undefined {
  const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!match) return undefined;
  const [h1, m1, h2, m2] = match.slice(1).map(Number) as [number, number, number, number];
  if (h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59) return undefined;
  const start = (h1 * 60 + m1) % 1440;
  const end = (h2 * 60 + m2) % 1440;
  if (start === end) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { start, end, text: `${pad(Math.floor(start / 60))}:${pad(start % 60)}-${pad(Math.floor(end / 60))}:${pad(end % 60)}` };
}

function isTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Undefined when automatic worktree cleanup is off. */
export function getWorktreeCleanupIdleDays(cfg: AppConfig): number | undefined {
  if (cfg.preferences?.autoWorktreeCleanup !== true) return undefined;
  const days = cfg.preferences.worktreeCleanupIdleDays;
  return typeof days === 'number' && Number.isFinite(days) && days >= 1 && days <= 365 ? Math.floor(days) : 7;
}
