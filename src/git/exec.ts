import { mergeProcessEnv, spawnProcess } from '../platform/spawn';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /** True when stdout hit {@link GitRunOptions.maxBytes} and was cut short. */
  truncated: boolean;
}

export interface GitRunOptions {
  timeoutMs?: number;
  /** Cap on captured stdout. A `git diff` on a big branch can be megabytes. */
  maxBytes?: number;
  /** Extra environment for the command (cannot override the non-interactive settings below). */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Run one git command in `cwd` and capture its output.
 *
 * Callers build the argument list themselves — nothing here interpolates user
 * text into a shell, and `cross-spawn` never involves one. Refs that came from
 * a chat message must still pass {@link isSafeRef} first, so a leading `-`
 * cannot turn into a flag.
 */
export async function git(
  cwd: string,
  args: readonly string[],
  opts: GitRunOptions = {},
): Promise<GitResult> {
  return runCapture('git', cwd, args, opts);
}

/**
 * Run a command in `cwd` and capture its output under the same caps and
 * non-interactive environment git gets. Shared with the `gh` calls behind
 * `/pr`, which have exactly the same "must never block on a prompt" need.
 */
export async function runCapture(
  command: string,
  cwd: string,
  args: readonly string[],
  opts: GitRunOptions = {},
): Promise<GitResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let stderr = '';
  let timedOut = false;

  const code = await new Promise<number | null>((resolve) => {
    const child = spawnProcess(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: mergeProcessEnv(process.env, {
        ...(opts.env ?? {}),
        // Deterministic, non-interactive output: no pager to block on, no
        // credential prompt to hang on, and English messages we can parse.
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
      }),
    });
    child.stdout?.on('data', (buf: Buffer) => {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - size;
      if (buf.length > room) {
        chunks.push(buf.subarray(0, room));
        size = maxBytes;
        truncated = true;
        return;
      }
      chunks.push(buf);
      size += buf.length;
    });
    child.stderr?.on('data', (buf: Buffer) => {
      if (stderr.length < 8192) stderr += buf.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  return {
    ok: !timedOut && code === 0,
    stdout: Buffer.concat(chunks).toString('utf8'),
    stderr: stderr.trim(),
    code,
    timedOut,
    truncated,
  };
}

/**
 * Whether a string is safe to pass to git as a revision / branch name.
 *
 * The bridge accepts refs typed in chat (`/diff main`, `/worktree add fix-123`).
 * Rejecting anything that could be read as an option — or that git itself would
 * refuse — keeps a message from turning into a different git command.
 */
export function isSafeRef(ref: string): boolean {
  if (!ref || ref.length > 200) return false;
  if (ref.startsWith('-')) return false;
  if (ref.includes('..') && !/^[^.]+\.\.\.?[^.]+$/.test(ref)) return false;
  return /^[\w./@^~{}[\]*+-]+$/.test(ref);
}

/** Narrow a `T | { error }` result returned by the helpers in this directory. */
export function isGitError<T>(value: T | { error: string }): value is { error: string } {
  return typeof value === 'object' && value !== null && 'error' in value;
}
