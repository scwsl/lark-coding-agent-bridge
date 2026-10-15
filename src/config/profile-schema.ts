import { AGENT_KINDS, isAgentKind, type AgentKind } from '../agent/registry';
import type {
  AppCredentials,
  AppPreferences,
  MessageReplyMode,
  SecretsConfig,
} from './schema';
import {
  normalizePermissions,
  permissionsToLegacySandbox,
  type AccessMode,
  type CodexSandboxMode,
  type PermissionConfig,
  type PermissionSource,
} from './permissions';

export type { AgentKind } from '../agent/registry';
export type SandboxMode = CodexSandboxMode;
export type { AccessMode, PermissionConfig, PermissionSource };

export interface ProfileAccess {
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  requireMentionInGroup: boolean;
  /**
   * Per-chat override of {@link requireMentionInGroup}, keyed by chat_id.
   * `true` = require an @-mention in that chat, `false` = respond to every
   * message. A chat absent from the map follows the global setting. Takes
   * priority over `requireMentionInGroup` for the chats it lists.
   */
  chatRequireMention?: Record<string, boolean>;
  /**
   * Per-chat member allowlist, keyed by chat_id. When a chat_id is present
   * here — even with an empty array — only admins/owner and the listed
   * senders may use the bot in that chat; the normal `allowedChats`
   * membership no longer opens it to everyone. A chat_id absent from this
   * map keeps the existing behavior: everyone in an `allowedChats` chat can
   * use the bot. Presence of the key (not array length) is what flips a
   * chat into restricted mode, so a chat can be created pre-restricted with
   * zero members and never pass through an "open to everyone" window.
   */
  chatAllowedUsers?: Record<string, string[]>;
  /**
   * open_ids allowed to stop *anyone's* run (the stop button and `/stop`), on
   * top of the owner, admins, and whoever started that run. Omitted when empty.
   */
  stoppers?: string[];
  /**
   * Directories a run started by someone other than the owner may read and
   * change (`~` allowed). Everything else under the owner's home is off
   * limits to them. Omitted when empty.
   */
  guestRoots?: string[];
  /**
   * Directories a run started by someone other than the owner may read but
   * not change (`~` allowed): file tools may not edit them and shell commands
   * may not write into them; read-only git (log, show, diff, grep, blame…)
   * still works. Omitted when empty.
   */
  guestReadOnlyRoots?: string[];
  /**
   * Claude permission rules denied to runs the owner didn't start, e.g.
   * `mcp__github` (a whole MCP server) or `mcp__jira__jira_create_issue`.
   */
  guestDeniedTools?: string[];
  /** Regexes for shell commands refused to runs the owner didn't start. */
  guestDeniedCommands?: string[];
  /**
   * open_id → entries of `guestDeniedTools` lifted for that person's runs,
   * e.g. `{ "ou_x": ["mcp__jira__jira_create_issue"] }`. A run gets a tool back
   * only when every sender in its batch has it. Omitted when empty.
   */
  guestToolGrants?: Record<string, string[]>;
}

export interface SandboxConfig {
  default?: SandboxMode;
  max?: SandboxMode;
  defaultMode: SandboxMode;
  maxMode: SandboxMode;
}

export interface CodexConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  /**
   * How runs talk to Codex. `app-server` (default) keeps one process per
   * conversation and runs later turns in it; `exec` spawns `codex exec` per
   * message. The adapter falls back to `exec` on its own when the app-server
   * can't honour the profile (ignoreUserConfig, or execpolicy rules that
   * ignoreRules must keep out).
   */
  transport?: 'app-server' | 'exec';
  /**
   * Extra environment for the `codex` child process only — e.g. a proxy the
   * Codex CLI needs while the bridge itself talks to Feishu directly.
   * Bridge-managed variables (`CODEX_HOME`, `LARK_CHANNEL*`,
   * `LARKSUITE_CLI_CONFIG_DIR`) cannot be overridden here.
   */
  env?: Record<string, string>;
}

export interface AttachmentConfig {
  maxCount: number;
  maxBytes: number;
  maxFileBytes: number;
  imageMaxBytes: number;
  cacheTtlMs: number;
  cacheMaxBytes: number;
}

export type CommentConfig = Record<string, never>;

/** Where the agent's answer goes when it responds to meeting content. */
export type MeetingRespondIn = 'meeting' | 'im' | 'both';

/**
 * Where the end-of-meeting summary is delivered.
 *  - `origin`: the chat the bot was told to join from (`/meeting join` there).
 *  - `owner`: the bot owner's direct message.
 * Either way the other one is used as a fallback, so a summary is never
 * silently dropped just because the preferred target isn't available (a
 * console-initiated join has no origin chat; an unresolved owner has no DM).
 */
export type MeetingSummaryTarget = 'origin' | 'owner';

/**
 * In-meeting agent ("智能体入会", path 2 / TAT): the bot joins a Feishu meeting
 * as a real participant, receives in-meeting activity (transcript, chat,
 * participants, doc shares) and can answer in the meeting or over IM.
 *
 * Off by default — the capability is gated by a Feishu allowlist plus the
 * `vc:meeting.bot.join:write` scope, so it must be opted into per profile.
 */
export interface MeetingConfig {
  enabled: boolean;
  /** Auto-join when the bot is invited (needs `vc.bot.meeting_invited_v1` push). */
  autoJoinOnInvite: boolean;
  transcript: {
    /** Rolling transcript lines kept as agent context. */
    keep: number;
    /** Debounce window (ms) before a sentence counts as final; 0 = emit every update. */
    stabilizeMs: number;
  };
  /** Where answers go. */
  respondIn: MeetingRespondIn;
  /**
   * Extra prefix that makes an in-meeting chat message a question for the agent.
   * `@<bot 当前名字>` is always accepted on top of this, so the natural thing to
   * type works without configuring anything.
   */
  trigger: string;
  /** Base interval for the `bots/events` poller (idle rounds back off). */
  pollIntervalMs: number;
  /** Summarize the meeting to IM when it ends. */
  summaryOnEnd: boolean;
  /** Preferred destination for that summary. See {@link MeetingSummaryTarget}. */
  summaryTarget: MeetingSummaryTarget;
}

/**
 * Approvals for runs a non-admin drives (#6). Admins' own runs never ask.
 * Off unless a profile opts in.
 */
export interface ApprovalsConfig {
  /**
   * On: each side-effecting step a non-admin's run takes waits for an
   * admin's approval card. Off (default): non-admins' runs get the same
   * permissions as an admin's — no approval cards.
   */
  enabled: boolean;
  /**
   * Shell commands that run without asking, by their leading words — e.g.
   * `python3 ~/.claude/skills/remote-tcpdump/scripts/tcpdump_client.py`
   * covers every subcommand of that script. Each stage of a `&&` / `|` line
   * must be covered (or plainly read-only); `;`, redirection and
   * substitution still ask. See `isAllowedCommand`.
   */
  allowCommands: string[];
  /**
   * Tools that run without asking, by name; `*` matches anything
   * (`mcp__tdengine-*__query`). `Bash` here would waive every command.
   */
  allowTools: string[];
}

/**
 * One shared skill library: a git repository the bridge keeps a read-only
 * mirror of and adds to the agent's skill index, next to the profile's own
 * `knowledge/skills/`. See `src/knowledge/libraries.ts`.
 */
export interface SkillLibraryConfig {
  /** Directory name of the mirror and the label shown as the skill's source. */
  name: string;
  /** Anything `git fetch` accepts that {@link isPlausibleGitUrl} lets through. */
  url: string;
  /** Branch, tag or commit to follow. Absent: the remote's default branch. */
  ref?: string;
  /** Directory inside the repository holding `<skill>/SKILL.md`. Absent: `skills/` if present, else the root. */
  path?: string;
  /** Only these skills (directory or skill name). Absent: all of them. */
  include?: string[];
  /** Never these skills (directory or skill name). */
  exclude?: string[];
}

export interface SkillsConfig {
  libraries: SkillLibraryConfig[];
  /**
   * Minutes between automatic pulls of every library. Absent: 60. `0`: only on
   * start-up and `/skills lib sync`.
   */
  syncIntervalMinutes?: number;
}

/**
 * The knowledge directory's own git sync (`/knowledge bind`). See
 * `src/knowledge/auto-sync.ts`.
 */
export interface KnowledgeConfig {
  /**
   * Minutes between automatic syncs (commit, pull --rebase, push) once the
   * directory is bound to a remote. Absent: 30. `0`: only `/knowledge sync`.
   */
  syncIntervalMinutes?: number;
}

export type LarkCliIdentityPreset = 'bot-only' | 'user-default';

/**
 * Deployment mode — a single switch that binds two behaviors together
 * (see the "团队版 Bot 权限调整" spec):
 *   - `personal` (default, the status quo): only owner + allowlisted
 *     users/chats can use the bot; the CLI may carry owner's personal (user)
 *     authorization per {@link LarkCliConfig.identityPreset}.
 *   - `team`: anyone can @-use the bot (no allowlist gating), and the CLI is
 *     forced to `bot-only` so it never carries owner's personal authorization.
 *
 * The two behaviors are intentionally bound to one switch, not two configs.
 * Admin/sensitive commands stay owner/admin-gated in both modes.
 */
export type ProfileMode = 'personal' | 'team';

export type LarkCliUserImportStatus =
  | 'not-needed'
  | 'imported'
  | 'skipped-existing-private-user'
  | 'skipped-no-local-user'
  | 'failed';

export interface LarkCliConfig {
  identityPreset: LarkCliIdentityPreset;
  localUserImport?: {
    status: LarkCliUserImportStatus;
    attemptedAt?: string;
    importedAt?: string;
    reason?: string;
  };
}

export interface ProfileConfig {
  schemaVersion: 2;
  agentKind: AgentKind;
  /** Deployment mode switch. Default 'personal'. See {@link ProfileMode}. */
  mode: ProfileMode;
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  preferences: Omit<AppPreferences, 'access' | 'requireMentionInGroup'>;
  access: ProfileAccess;
  workspaces: {
    default?: string;
  };
  sandbox: SandboxConfig;
  permissions: PermissionConfig;
  permissionSource?: PermissionSource;
  codex?: CodexConfig;
  attachments: AttachmentConfig;
  comments: CommentConfig;
  /** In-meeting agent settings. See {@link MeetingConfig}. */
  meeting: MeetingConfig;
  larkCli: LarkCliConfig;
  /** Approvals for non-admins' runs. See {@link ApprovalsConfig}. */
  approvals: ApprovalsConfig;
  /** Shared skill libraries. Absent: none configured. See {@link SkillsConfig}. */
  skills?: SkillsConfig;
  /** Knowledge repo auto-sync. Absent: defaults. See {@link KnowledgeConfig}. */
  knowledge?: KnowledgeConfig;
}

/**
 * The lark-cli identity preset that actually takes effect, after applying the
 * deployment-mode override. Team mode forces `bot-only` regardless of the
 * user's stored {@link LarkCliConfig.identityPreset} (which is preserved so it
 * comes back into effect when switching back to personal mode). This is the
 * single source of truth for "team mode forces bot-only" — every place that
 * applies the lark-cli identity policy should read through here.
 */
export function effectiveLarkCliIdentity(
  profile: Pick<ProfileConfig, 'mode' | 'larkCli'>,
): LarkCliIdentityPreset {
  return profile.mode === 'team' ? 'bot-only' : profile.larkCli.identityPreset;
}

export interface RootConfig {
  schemaVersion: 2;
  activeProfile: string;
  preferences: Record<string, never>;
  secrets?: SecretsConfig;
  migrations?: {
    permissionDefaultsV1?: string[];
  };
  profiles: Record<string, ProfileConfig>;
}

export interface CreateDefaultProfileConfigInput {
  agentKind: AgentKind;
  /** Deployment mode. Default 'personal'. */
  mode?: ProfileMode;
  accounts: {
    app: AppCredentials;
  };
  preferences?: AppPreferences;
  access?: Partial<ProfileAccess>;
  sandbox?: Partial<SandboxConfig>;
  permissions?: Partial<PermissionConfig>;
  codex?: CodexConfig;
  secrets?: SecretsConfig;
}

export function createDefaultProfileConfig(
  input: CreateDefaultProfileConfigInput,
): ProfileConfig {
  return normalizeProfileConfig({
    schemaVersion: 2,
    ...input,
  });
}

export function normalizeProfileConfig(input: unknown): ProfileConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('profile config must be an object');
  }
  const raw = input as {
    schemaVersion?: unknown;
    agentKind?: unknown;
    mode?: unknown;
    accounts?: unknown;
    secrets?: SecretsConfig;
    preferences?: (AppPreferences & { access?: Partial<ProfileAccess> }) | undefined;
    access?: Partial<ProfileAccess>;
    workspaces?: {
      default?: unknown;
      // Legacy workspace authorization fields are accepted for config
      // compatibility only; normalizeWorkspaces drops them.
      trusted?: unknown;
      trustedRoots?: unknown;
      riskFlags?: unknown;
    };
    sandbox?: Partial<SandboxConfig>;
    permissions?: Partial<PermissionConfig>;
    codex?: CodexConfig & { flags?: unknown };
    attachments?: Partial<AttachmentConfig>;
    comments?: unknown;
    meeting?: unknown;
    larkCli?: unknown;
    approvals?: unknown;
    skills?: unknown;
    knowledge?: unknown;
  };

  if (raw.schemaVersion !== 2) {
    throw new Error('profile schemaVersion must be 2');
  }
  if (!isAgentKind(raw.agentKind)) {
    throw new Error(`agentKind must be one of: ${AGENT_KINDS.join(', ')}`);
  }
  const accounts = normalizeAccounts(raw.accounts);
  if (raw.agentKind === 'codex' && !raw.codex) {
    throw new Error('codex profile requires codex configuration');
  }

  const preferences = normalizePreferences(raw.preferences);
  const access = normalizeAccess(
    raw.access ?? raw.preferences?.access,
    raw.preferences?.requireMentionInGroup,
  );
  const { permissions, source: permissionSource } = normalizePermissions({
    permissions: raw.permissions,
    sandbox: raw.sandbox,
  });
  const sandbox = permissionsToLegacySandbox(permissions);
  const workspaces = normalizeWorkspaces(raw.workspaces);
  const comments = normalizeComments(raw.comments);
  const meeting = normalizeMeeting(raw.meeting);
  const larkCli = normalizeLarkCli(raw.larkCli);
  const skills = normalizeSkills(raw.skills);
  const knowledge = normalizeKnowledge(raw.knowledge);

  return {
    schemaVersion: 2,
    agentKind: raw.agentKind,
    mode: raw.mode === 'team' ? 'team' : 'personal',
    accounts,
    ...(raw.secrets ? { secrets: raw.secrets } : {}),
    preferences,
    access,
    workspaces,
    sandbox,
    permissions,
    permissionSource,
    ...(raw.codex ? { codex: normalizeCodex(raw.codex) } : {}),
    attachments: {
      maxCount: numberOr(raw.attachments?.maxCount, 10),
      maxBytes: numberOr(raw.attachments?.maxBytes, 100 * 1024 * 1024),
      maxFileBytes: numberOr(raw.attachments?.maxFileBytes, 25 * 1024 * 1024),
      imageMaxBytes: numberOr(raw.attachments?.imageMaxBytes, 25 * 1024 * 1024),
      cacheTtlMs: numberOr(raw.attachments?.cacheTtlMs, 24 * 60 * 60 * 1000),
      cacheMaxBytes: numberOr(raw.attachments?.cacheMaxBytes, 512 * 1024 * 1024),
    },
    comments,
    meeting,
    larkCli,
    approvals: normalizeApprovals(raw.approvals),
    ...(skills ? { skills } : {}),
    ...(knowledge ? { knowledge } : {}),
  };
}

function normalizeAccounts(input: unknown): ProfileConfig['accounts'] {
  if (!input || typeof input !== 'object') {
    throw new Error('accounts.app is required');
  }
  const accounts = input as { app?: Partial<AppCredentials> };
  const app = accounts.app;
  if (!app?.id || !app.secret || (app.tenant !== 'feishu' && app.tenant !== 'lark')) {
    throw new Error('accounts.app is incomplete');
  }
  return {
    app: {
      id: app.id,
      secret: app.secret,
      tenant: app.tenant,
    },
  };
}

function normalizePreferences(
  preferences: AppPreferences | undefined,
): ProfileConfig['preferences'] {
  const {
    access: _access,
    requireMentionInGroup: _mention,
    messageReply,
    ...rest
  } = preferences ?? {};
  if (messageReply !== undefined && isMessageReply(messageReply)) {
    return {
      ...rest,
      messageReply,
    };
  }
  return rest;
}

function isMessageReply(value: unknown): value is MessageReplyMode {
  return value === 'card' || value === 'markdown' || value === 'text';
}

function normalizeAccess(
  access: Partial<ProfileAccess> | undefined,
  legacyRequireMentionInGroup: boolean | undefined,
): ProfileAccess {
  const chatRequireMention = normalizeChatMentionMap(access?.chatRequireMention);
  const chatAllowedUsers = normalizeChatUserMap(access?.chatAllowedUsers);
  const stoppers = stringArray(access?.stoppers);
  const guestRoots = stringArray(access?.guestRoots);
  const guestReadOnlyRoots = stringArray(access?.guestReadOnlyRoots);
  const guestDeniedTools = stringArray(access?.guestDeniedTools);
  const guestDeniedCommands = stringArray(access?.guestDeniedCommands);
  const guestToolGrants = normalizeChatUserMap(access?.guestToolGrants);
  return {
    allowedUsers: stringArray(access?.allowedUsers),
    allowedChats: stringArray(access?.allowedChats),
    admins: stringArray(access?.admins),
    requireMentionInGroup: access?.requireMentionInGroup ?? legacyRequireMentionInGroup ?? true,
    // Omit when empty so configs without per-chat overrides stay clean.
    ...(Object.keys(chatRequireMention).length > 0 ? { chatRequireMention } : {}),
    ...(Object.keys(chatAllowedUsers).length > 0 ? { chatAllowedUsers } : {}),
    ...(stoppers.length > 0 ? { stoppers } : {}),
    ...(guestRoots.length > 0 ? { guestRoots } : {}),
    ...(guestReadOnlyRoots.length > 0 ? { guestReadOnlyRoots } : {}),
    ...(guestDeniedTools.length > 0 ? { guestDeniedTools } : {}),
    ...(guestDeniedCommands.length > 0 ? { guestDeniedCommands } : {}),
    ...(Object.keys(guestToolGrants).length > 0 ? { guestToolGrants } : {}),
  };
}

/** Keep only string→boolean entries; drop anything malformed. */
function normalizeChatMentionMap(input: unknown): Record<string, boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, boolean> = {};
  for (const [chatId, value] of Object.entries(input as Record<string, unknown>)) {
    if (chatId && typeof value === 'boolean') out[chatId] = value;
  }
  return out;
}

/**
 * Keep only string→string[] entries; drop anything malformed. A chat_id
 * mapped to `[]` is kept (not dropped) — the empty array is the "restricted,
 * no members yet" state, distinct from the chat_id being absent entirely.
 */
/** Keep only id → string[] entries (chat → users, user → tools). */
function normalizeChatUserMap(input: unknown): Record<string, string[]> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string[]> = {};
  for (const [chatId, value] of Object.entries(input as Record<string, unknown>)) {
    if (chatId && Array.isArray(value)) out[chatId] = stringArray(value);
  }
  return out;
}

function normalizeWorkspaces(input: {
  default?: unknown;
  trusted?: unknown;
  trustedRoots?: unknown;
  riskFlags?: unknown;
} | undefined): ProfileConfig['workspaces'] {
  const defaultWorkspace = typeof input?.default === 'string' && input.default.trim()
    ? input.default.trim()
    : undefined;
  return defaultWorkspace ? { default: defaultWorkspace } : {};
}

function normalizeCodex(input: CodexConfig & { flags?: unknown }): CodexConfig {
  const codex: CodexConfig = {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.codexHome === 'string' ? { codexHome: input.codexHome } : {}),
    inheritCodexHome: input.inheritCodexHome !== false,
    ignoreUserConfig: input.ignoreUserConfig === true,
    ignoreRules: input.ignoreRules !== false,
    ...(input.transport === 'exec' || input.transport === 'app-server' ? { transport: input.transport } : {}),
  };
  const env = normalizeCodexEnv(input.env);
  if (env) codex.env = env;
  return codex;
}

const CODEX_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Keep only well-formed `KEY: "string"` pairs; `undefined` when none survive. */
function normalizeCodexEnv(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const entries = Object.entries(input as Record<string, unknown>).filter(
    (entry): entry is [string, string] => CODEX_ENV_KEY.test(entry[0]) && typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeComments(_input: unknown): CommentConfig {
  return {};
}

/** Defaults keep the in-meeting agent off until a profile opts in. */
export const MEETING_DEFAULTS: MeetingConfig = {
  enabled: false,
  autoJoinOnInvite: false,
  transcript: { keep: 200, stabilizeMs: 0 },
  respondIn: 'meeting',
  trigger: '@bot',
  pollIntervalMs: 3000,
  summaryOnEnd: false,
  summaryTarget: 'origin',
};

function normalizeMeeting(input: unknown): MeetingConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as {
    enabled?: unknown;
    autoJoinOnInvite?: unknown;
    transcript?: { keep?: unknown; stabilizeMs?: unknown };
    respondIn?: unknown;
    trigger?: unknown;
    pollIntervalMs?: unknown;
    summaryOnEnd?: unknown;
    summaryTarget?: unknown;
  };
  const trigger = typeof raw.trigger === 'string' && raw.trigger.trim() ? raw.trigger.trim() : MEETING_DEFAULTS.trigger;
  return {
    enabled: raw.enabled === true,
    autoJoinOnInvite: raw.autoJoinOnInvite === true,
    transcript: {
      keep: clampNumber(raw.transcript?.keep, 10, 2000, MEETING_DEFAULTS.transcript.keep),
      // 0 is meaningful here ("no debounce"), so it can't go through numberOr.
      stabilizeMs: clampNumber(raw.transcript?.stabilizeMs, 0, 30_000, MEETING_DEFAULTS.transcript.stabilizeMs),
    },
    respondIn:
      raw.respondIn === 'im' || raw.respondIn === 'both' || raw.respondIn === 'meeting'
        ? raw.respondIn
        : MEETING_DEFAULTS.respondIn,
    trigger,
    pollIntervalMs: clampNumber(raw.pollIntervalMs, 1000, 60_000, MEETING_DEFAULTS.pollIntervalMs),
    summaryOnEnd: raw.summaryOnEnd === true,
    summaryTarget:
      raw.summaryTarget === 'owner' || raw.summaryTarget === 'origin'
        ? raw.summaryTarget
        : MEETING_DEFAULTS.summaryTarget,
  };
}

/** Like {@link numberOr} but keeps 0 and bounds the result. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function normalizeApprovals(input: unknown): ApprovalsConfig {
  const raw = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as {
    enabled?: unknown;
    allowCommands?: unknown;
    allowTools?: unknown;
  };
  const trimmed = (value: unknown): string[] =>
    stringArray(value)
      .map((item) => item.trim())
      .filter(Boolean);
  return {
    enabled: raw.enabled === true,
    allowCommands: trimmed(raw.allowCommands),
    allowTools: trimmed(raw.allowTools),
  };
}

const SKILL_LIBRARY_NAME_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;

export function isValidSkillLibraryName(name: string): boolean {
  return SKILL_LIBRARY_NAME_RE.test(name) && name !== '.' && name !== '..';
}

/**
 * A library's `path` is joined onto the mirror directory, so it has to stay
 * inside it: relative, no `..` segments, nothing that starts like an option.
 */
export function isSafeSkillLibraryPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return false;
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments.length > 0 && segments.every((segment) => segment !== '..' && !segment.startsWith('-'));
}

/**
 * Libraries with a broken entry (no url, unusable name, duplicate name) are
 * dropped one by one instead of failing the whole profile: a typo in one
 * library must not keep the bot from starting.
 */
function normalizeSkills(input: unknown): SkillsConfig | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as { libraries?: unknown; syncIntervalMinutes?: unknown };
  const trimmed = (value: unknown): string[] =>
    stringArray(value)
      .map((item) => item.trim())
      .filter(Boolean);
  const libraries: SkillLibraryConfig[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw.libraries) ? raw.libraries : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!url || !isValidSkillLibraryName(name) || seen.has(name)) continue;
    seen.add(name);
    const ref = typeof item.ref === 'string' ? item.ref.trim() : '';
    const path = typeof item.path === 'string' ? item.path.trim() : '';
    const include = trimmed(item.include);
    const exclude = trimmed(item.exclude);
    libraries.push({
      name,
      url,
      ...(ref ? { ref } : {}),
      ...(path && isSafeSkillLibraryPath(path) ? { path } : {}),
      ...(include.length > 0 ? { include } : {}),
      ...(exclude.length > 0 ? { exclude } : {}),
    });
  }
  const interval =
    typeof raw.syncIntervalMinutes === 'number' && Number.isFinite(raw.syncIntervalMinutes)
      ? Math.max(0, Math.floor(raw.syncIntervalMinutes))
      : undefined;
  if (libraries.length === 0 && interval === undefined) return undefined;
  return { libraries, ...(interval !== undefined ? { syncIntervalMinutes: interval } : {}) };
}

/** Same rules as the skills interval: a negative number means `0`, anything else invalid is dropped. */
function normalizeKnowledge(input: unknown): KnowledgeConfig | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as { syncIntervalMinutes?: unknown };
  if (typeof raw.syncIntervalMinutes !== 'number' || !Number.isFinite(raw.syncIntervalMinutes)) return undefined;
  return { syncIntervalMinutes: Math.max(0, Math.floor(raw.syncIntervalMinutes)) };
}

function normalizeLarkCli(input: unknown): LarkCliConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { identityPreset: 'bot-only' };
  }
  const raw = input as {
    identityPreset?: unknown;
    localUserImport?: unknown;
  };
  const identityPreset: LarkCliIdentityPreset =
    raw.identityPreset === 'user-default' ? 'user-default' : 'bot-only';
  const localUserImport = normalizeLarkCliUserImport(raw.localUserImport);
  return {
    identityPreset,
    ...(localUserImport ? { localUserImport } : {}),
  };
}

function normalizeLarkCliUserImport(input: unknown): LarkCliConfig['localUserImport'] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as {
    status?: unknown;
    attemptedAt?: unknown;
    importedAt?: unknown;
    reason?: unknown;
  };
  if (!isLarkCliUserImportStatus(raw.status)) return undefined;
  return {
    status: raw.status,
    ...(typeof raw.attemptedAt === 'string' ? { attemptedAt: raw.attemptedAt } : {}),
    ...(typeof raw.importedAt === 'string' ? { importedAt: raw.importedAt } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

function isLarkCliUserImportStatus(value: unknown): value is LarkCliUserImportStatus {
  return (
    value === 'not-needed' ||
    value === 'imported' ||
    value === 'skipped-existing-private-user' ||
    value === 'skipped-no-local-user' ||
    value === 'failed'
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
