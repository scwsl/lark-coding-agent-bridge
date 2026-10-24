import type { AgentAvailability } from './preflight';
import type { ClaudePermissionMode, CodexSandboxMode } from '../config/permissions';
import type { RunGuard } from '../policy/owner-guard';

export type { ClaudePermissionMode } from '../config/permissions';

export type AgentEvent =
  | { type: 'system'; sessionId?: string; threadId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'final_text'; content: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  /** A message injected mid-run via `AgentRun.inject` was picked up by the agent. */
  | { type: 'supplement'; preview: string }
  /**
   * A subagent (started by the main agent's Agent / Task tool) did something.
   * Only a sign of life for the progress footer and liveness checks — its
   * content is never shown.
   */
  | {
      type: 'subagent_activity';
      /** The main agent's tool_use that started the subagent. */
      parentToolUseId: string;
      /** Tool the subagent called, when this step was a tool call. */
      tool?: string;
      /** The subagent's own one-line description of that call. */
      description?: string;
      at: number;
    }
  /**
   * Subscription quota status. `blocked` means a request was refused because
   * the plan's quota ran out: the run can't make progress until `resetsAt`.
   * Non-blocking reports only carry the quota window's details.
   */
  | {
      type: 'rate_limit';
      blocked: boolean;
      /** Which window: `five_hour`, `seven_day`, `seven_day_opus`, … */
      limitType?: string;
      /** Epoch ms when the window resets, when the agent said. */
      resetsAt?: number;
      /** The agent's own wording, e.g. "You've hit your limit · resets 11pm". */
      message?: string;
      /**
       * How full each subscription window is, when the agent said: Claude's
       * `unifiedWindows` (`five_hour`, `seven_day`), `usedPercent` 0–100.
       */
      windows?: Array<{ kind: string; usedPercent: number; resetsAt?: number }>;
      /** Epoch ms the event was seen. */
      at: number;
    }
  /**
   * A subagent of this process (usually a background one) stopped because its
   * requests were refused for quota. It ran on the process's own account, so
   * that account is refused too. Claude reports it as the subagent's own
   * `error: "rate_limit"` message and as a failed `task_notification`.
   */
  | { type: 'subagent_rate_limited'; taskId?: string; message?: string; at: number }
  /**
   * Which subscription account this run (or, after a failover, the rest of
   * it) is paid by — for the reply card's `Sponsor:` line. `switchedFrom` is
   * set when the bridge moved the run off another account; `reason` says why
   * when it was not refused (e.g. it reached a switch line).
   */
  | { type: 'account'; label: string; switchedFrom?: string; reason?: string }
  | {
      /**
       * One turn's consumption. `inputTokens` is the whole prompt, the cached
       * part (`cachedInputTokens`) included; `costUsd` is this turn's share
       * (an estimate on subscription logins).
       */
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'done';
      sessionId?: string;
      threadId?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout' }
  /**
   * How many background tasks (backgrounded shell commands, background
   * sub-agents, monitors) the agent process currently has running. While it
   * is above zero after a `done`, the process is still working and will run
   * further turns on its own as those tasks report back.
   */
  | { type: 'background'; count: number };

export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

/**
 * Present on runs driven by someone who is not an admin: every
 * side-effecting step must be approved first. Each adapter wires it the way
 * its CLI allows — a PreToolUse hook command (Claude) or answering the CLI's
 * own approval requests (Codex app-server).
 */
export interface RunApprovals {
  hookCommand?: string;
  /** How long a hook may block waiting for a decision. */
  hookTimeoutSec?: number;
  decide(request: {
    tool: string;
    summary: string;
    readOnly?: boolean;
    /** The shell command, when the step runs one (checked against the profile's allowlist). */
    command?: string;
  }): Promise<{ decision: 'allow' | 'deny'; reason: string }>;
}

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  threadId?: string;
  model?: string;
  /**
   * Reasoning effort for adapters whose CLI exposes one (Claude Code's
   * `--effort`, Codex's `model_reasoning_effort`). Adapters without the
   * concept ignore it.
   */
  effort?: string;
  images?: readonly string[];
  sandbox?: CodexSandboxMode;
  permissionMode?: ClaudePermissionMode;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
  */
  stopGraceMs?: number;
  /** Set when someone other than the bot owner started the run: what it may
   * not touch. Adapters that can't enforce it ignore it. */
  guard?: RunGuard;
  approvals?: RunApprovals;
  /**
   * 会话智能压缩: auto-compact the conversation against a context window of
   * this many tokens instead of the model's full window, so long sessions get
   * summarised well before they reach it. Adapters without the knob ignore it.
   */
  compactWindowTokens?: number;
  /**
   * A ceiling on every account's switch lines for this run only, by window
   * (`five_hour`, `seven_day`), 1–100: 课堂精练 leaves an account at its
   * 80% even where chats go on further. Such a run never makes the account it
   * lands on the main one, and never moves to an account at or past the
   * ceiling. Adapters with a single account ignore it.
   */
  accountLineCap?: Partial<Record<'five_hour' | 'seven_day', number>>;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  /** OS pid of the agent process, for `/status`. Absent when not spawned. */
  readonly pid?: number;
  stop(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before claude has actually closed
   * stdout — there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
  /**
   * Feed one more user message into the still-running agent, which picks it
   * up at its next turn boundary (after the current tool call) and folds it
   * into the ongoing task. `preview` is what the `supplement` event reports
   * once the agent has actually read it. Returns false when the run can no
   * longer take input (already finishing / exited) — callers then fall back
   * to queueing the message for the next run. Adapters without streaming
   * input omit it.
   */
  inject?(prompt: string, preview: string): boolean;
  /**
   * Hand the still-running process another user message, as the next turn.
   * Only offered by adapters whose CLI accepts streamed input; returns false
   * once the process no longer takes input (it closed stdin after a turn with
   * no background tasks left, or exited), in which case the caller spawns a
   * fresh run instead.
   */
  send?(prompt: string): boolean;
  /**
   * No more turns are coming: close the process's input so it exits on its
   * own. Offered by adapters whose processes otherwise stay up between turns.
   */
  endInput?(): void;
}

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that don't bake identity into their prompts may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
}
