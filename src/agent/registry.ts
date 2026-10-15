/**
 * The single list of agent CLIs the bridge can drive, and the static facts
 * shared code needs about each one.
 *
 * Shared code (bot, commands, scheduler, cards, CLI, web UI) must branch on a
 * descriptor field here — never on a literal `agentKind === 'codex'` with an
 * implicit "else Claude". Behaviour that needs real code per agent (adapter
 * construction, model catalog, account lookup, /resume listing) lives next to
 * that code as a `Record<AgentKind, …>`, so adding an agent is compiler-guided:
 *
 *   1. append the id to {@link AGENT_KINDS};
 *   2. add its descriptor to {@link AGENT_DESCRIPTORS};
 *   3. `pnpm typecheck` then lists every `Record<AgentKind, …>` still missing
 *      an entry (adapter factory, models, account, /resume, …).
 *
 * This module is pure data with no runtime imports so config parsing, the CLI
 * and the web API can all depend on it without pulling in agent internals.
 * See CLAUDE.md → "Adding an agent".
 */

export const AGENT_KINDS = ['claude', 'codex'] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

/** Agent assumed when a profile / lock / legacy record predates `agentKind`. */
export const DEFAULT_AGENT_KIND: AgentKind = 'claude';

export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

export interface AgentDescriptor {
  readonly kind: AgentKind;
  /** Human-facing name: status card, `/ps`, onboarding picker, errors. */
  readonly displayName: string;
  /** Executable looked up on PATH when nothing pins a binary path. */
  readonly command: string;
  /** Environment variable that overrides {@link command} for auto-detection. */
  readonly commandEnv: string;
  /** Model vendor shown on the reply card byline. */
  readonly provider: string;
  /**
   * Which `done`/`system` event field carries the resumable conversation
   * handle, and therefore which field a session-catalog entry stores.
   */
  readonly sessionHandle: 'sessionId' | 'threadId';
  /**
   * Also mirror the handle into the per-scope {@link SessionStore} — the
   * pre-catalog resume path that `/new`, `/cd` and `/timeout` still act on,
   * and that `/resume use <raw id>` falls back to.
   */
  readonly scopeSessionStore: boolean;
  /**
   * How the answer reaches the chat. `stream`: the live progress message is
   * the answer. `separate`: the progress stream only shows work, and the
   * final answer is posted as its own reply (text mode keeps the answer only).
   */
  readonly finalReply: 'stream' | 'separate';
  /** Accepted image attachments are passed as CLI file arguments, not only as paths in the prompt. */
  readonly imageArgs: boolean;
  /** The access knob `/status` reports: the CLI's permission mode, or its sandbox mode. */
  readonly accessControl: 'permission-mode' | 'sandbox';
  /** How the bridge system prompt reaches the CLI. */
  readonly promptInjection: PromptInjectionMode;
  /** Card-callback markers this agent's older skills may still emit. */
  readonly legacyCallbackMarkers: readonly string[];
  /** `/config` effort hint: what "跟随默认" (no explicit effort) means for this CLI. */
  readonly effortDefaultHint: string;
  /**
   * How long the CLI may take to exit on its own after its last turn before
   * the bridge stops it. Stopping it earlier cuts off its final bookkeeping
   * (Codex needs several seconds after `turn.completed`). Nothing waits on
   * this: replies go out at `done`, and a new turn starts its own process.
   */
  readonly exitGraceMs: number;
  /**
   * How long a process that can take further turns (`AgentRun.send`) stays
   * up idle after a turn, waiting for the conversation's next message. 0 =
   * close it right away (Claude: it is only kept while background tasks run).
   */
  readonly idleKeepAliveMs: number;
  /** The bridge can read the plan quota itself (`/usage`, quota pause). */
  readonly planQuota: boolean;
}

export const AGENT_DESCRIPTORS: Readonly<Record<AgentKind, AgentDescriptor>> = {
  claude: {
    kind: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    commandEnv: 'LARK_CHANNEL_CLAUDE_BIN',
    provider: 'anthropic',
    sessionHandle: 'sessionId',
    scopeSessionStore: true,
    finalReply: 'stream',
    imageArgs: false,
    accessControl: 'permission-mode',
    promptInjection: 'append-system-prompt',
    legacyCallbackMarkers: ['__claude_cb'],
    effortDefaultHint: '「跟随默认」= 不传 --effort',
    // Claude Code 2.1 takes 1–3s to exit after its stdin closes even with no
    // background task left; a 2s grace killed ~28% of finished turns.
    exitGraceMs: 10_000,
    idleKeepAliveMs: 0,
    planQuota: true,
  },
  codex: {
    kind: 'codex',
    displayName: 'Codex CLI',
    command: 'codex',
    commandEnv: 'LARK_CHANNEL_CODEX_BIN',
    provider: 'openai',
    sessionHandle: 'threadId',
    scopeSessionStore: false,
    finalReply: 'separate',
    imageArgs: true,
    accessControl: 'sandbox',
    promptInjection: 'stdin-prefix',
    legacyCallbackMarkers: [],
    effortDefaultHint:
      '「跟随默认」= 用 Codex 配置里的 model_reasoning_effort；所选模型不支持的档位会自动降到它支持的最高档',
    // codex-cli 0.159 spends 5–15s after `turn.completed` updating its
    // memories / thread-state sqlite stores (what thread listing reads);
    // the rollout itself is already complete by then.
    exitGraceMs: 30_000,
    // The app-server transport keeps the conversation's process for the next
    // message instead of paying Codex start-up again.
    idleKeepAliveMs: 10 * 60_000,
    planQuota: false,
  },
};

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value);
}

/** Descriptor for a kind; a missing kind (legacy records) resolves to {@link DEFAULT_AGENT_KIND}. */
export function agentDescriptor(kind: AgentKind | undefined): AgentDescriptor {
  return AGENT_DESCRIPTORS[kind ?? DEFAULT_AGENT_KIND];
}

export function listAgentDescriptors(): AgentDescriptor[] {
  return AGENT_KINDS.map((kind) => AGENT_DESCRIPTORS[kind]);
}
