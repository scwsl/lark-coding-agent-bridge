/**
 * Long tasks keep a ledger: a file with the plan, what is done and what comes
 * next (see the system prompt). The agent names it in its reply with one line
 * such as `📒 任务台账：/abs/path.md`. Knowing it lets the bridge pick the task
 * up again after the run dies halfway, instead of leaving the work stranded.
 */

const LEDGER_RE = /(?:📒\s*)?(?:任务台账|[Tt]ask ledger)\s*[:：]\s*`?((?:~|\/)[^\s`，。）)]+)`?/;

/** The ledger path a reply announces, if any. */
export function findLedger(text: string): string | undefined {
  return LEDGER_RE.exec(text)?.[1];
}

const LEDGER_LINE_RE = /^[ \t>*_-]*(?:📒\s*)?(?:任务台账|[Tt]ask ledger)\s*[:：]\s*`?(?:~|\/)[^\n]*(?:\r?\n|$)/gm;

/**
 * The reply without its ledger line(s). Group members can't open a path on
 * the owner's machine, so group replies hide it; the bridge still reads the
 * ledger from the raw answer (see {@link findLedger}).
 */
export function stripLedgerLines(text: string): string {
  if (!LEDGER_LINE_RE.test(text)) return text;
  LEDGER_LINE_RE.lastIndex = 0;
  return text.replace(LEDGER_LINE_RE, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * The run's process was killed from outside (SIGTERM / SIGKILL: exit 143 /
 * 137) rather than failing on its own — worth resuming, unlike a real error.
 */
export function isKilledExit(message: string | undefined): boolean {
  if (!message) return false;
  return /exited with code (?:137|143)\b|\bSIG(?:KILL|TERM)\b/.test(message);
}

/** Resumes after an interruption before giving up on a task. */
export const MAX_INTERRUPT_RESUMES = 3;
/** Pause before resuming an interrupted task, so a crash loop can't spin. */
export const INTERRUPT_RESUME_DELAY_MS = 30_000;
