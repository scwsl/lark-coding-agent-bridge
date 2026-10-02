import type { AgentEvent } from '../agent/types';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { runningToolLabel } from '../card/run-activity';
import { log, reportMetric } from '../core/logger';
import type { RunHandle } from './active-runs';


/** At most one `subagent-activity` log line per run this often. */
const SUBAGENT_LOG_INTERVAL_MS = 60_000;

/**
 * Drive the agent's event stream into a stateful RunState, calling `flush`
 * on every state transition. Used by both card and markdown reply modes —
 * the only difference between the two is what `flush` does with the state.
 */
export async function processAgentStream(
  handle: RunHandle,
  events: AsyncIterable<AgentEvent>,
  scope: string,
  idleTimeoutMs: number | undefined,
  recordSession: (event: AgentEvent) => void,
  flush: (state: RunState) => Promise<void>,
): Promise<RunState> {
  const runStart = Date.now();
  let state: RunState = initialState;

  // Idle watchdog: claude going silent for `idleTimeoutMs` is treated as
  // "presumed hung", we stop() and surface a timeout marker on the card.
  //
  // BUT — claude can legitimately be silent for a long time when it's
  // waiting on a long-running tool call (e.g. `lark-cli` printing an
  // OAuth URL and blocking until the user clicks authorize). In that
  // case there's no event stream activity from claude itself, only the
  // tool subprocess running. We track which tool_use ids haven't matched
  // a tool_result yet, and pause the watchdog whenever the set is
  // non-empty.
  //
  // The watchdog re-arms when:
  //  - a tool_result drains the in-flight set to zero, OR
  //  - any non-tool event arrives while the set is empty.
  let idleFired = false;
  let timer: NodeJS.Timeout | undefined;
  const inFlightTools = new Set<string>();
  const armOrPauseIdle = (): void => {
    if (!idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (inFlightTools.size > 0) return;
    timer = setTimeout(() => {
      idleFired = true;
      handle.interrupted = true;
      log.warn('agent', 'idle-timeout', { scope, idleTimeoutMs });
      void handle.run.stop().catch(() => {
        /* stop errors are non-fatal */
      });
    }, idleTimeoutMs);
  };
  armOrPauseIdle();
  // Subagents can work for a long time while the main agent sits in one tool
  // call; a line now and then keeps the log (and the watchdog reading it)
  // from mistaking that for a stuck run.
  let lastSubagentLogAt = 0;

  try {
    for await (const evt of events) {
      if (handle.interrupted) break;

      if (evt.type === 'subagent_activity' && evt.at - lastSubagentLogAt >= SUBAGENT_LOG_INTERVAL_MS) {
        lastSubagentLogAt = evt.at;
        log.info('agent', 'subagent-activity', {
          ...(evt.tool ? { tool: evt.tool } : {}),
          ...(evt.description ? { description: evt.description.slice(0, 80) } : {}),
        });
      }

      // Track tool flight before re-arming the idle timer so the arm step
      // sees the correct set size. tool_use opens a window; tool_result
      // closes it. Other event types are bookkept after the if/else.
      if (evt.type === 'tool_use') {
        inFlightTools.add(evt.id);
        log.info('agent', 'tool-in-flight', {
          tool: evt.name,
          inFlight: inFlightTools.size,
        });
      } else if (evt.type === 'tool_result') {
        inFlightTools.delete(evt.id);
        log.info('agent', 'tool-done', { inFlight: inFlightTools.size });
      }
      armOrPauseIdle();

      if (evt.type === 'system') {
        recordSession(evt);
        continue;
      }
      if (evt.type === 'usage') {
        const { costUsd, inputTokens, outputTokens } = evt;
        if (costUsd !== undefined || inputTokens !== undefined || outputTokens !== undefined) {
          log.info('agent', 'usage', {
            ...(costUsd !== undefined ? { costUsd: Number(costUsd.toFixed(4)) } : {}),
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          });
          if (costUsd !== undefined) reportMetric('cost_usd', costUsd);
          if (inputTokens !== undefined) reportMetric('tokens_in', inputTokens);
          if (outputTokens !== undefined) reportMetric('tokens_out', outputTokens);
        }
        continue;
      }

      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduce(state, evt);
      handle.lastActivityAt = Date.now();
      handle.toolLabel = runningToolLabel(state);
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
      }
      await flush(state);
      // Stop iterating as soon as we have a terminal state. Some claude
      // versions don't close stdout immediately after the result event, which
      // would leave the for-await waiting forever otherwise.
      if (state.terminal !== 'running') break;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins. This avoids "claude finished but flush was slow → timer fired
  // mid-flush → user sees 'idle_timeout' on a successful run".
  if (state.terminal === 'running') {
    if (idleFired) {
      state = markIdleTimeout(state, Math.round(idleTimeoutMs! / 60_000));
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  log.info('card', 'final', { scope, terminal: state.terminal, interrupted: handle.interrupted });
  reportMetric('run_e2e_ms', Date.now() - runStart, { terminal: state.terminal });
  await flush(state);
  if (handle.interrupted) {
    await handle.run.stop();
  }
  return state;
}
