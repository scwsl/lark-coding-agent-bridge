import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedMessage } from '@larksuite/channel';
import { isCreator, type RuntimeControls } from './access';

/** One fenced path for `bin/bridge-guard.mjs` (same shape it reads). */
export interface GuardRule {
  path: string;
  /** `any`: no shell command may name it; `write`: only writing into it is refused. */
  bash: 'any' | 'write';
  /** Regexes for sub-paths that stay usable, anchored where the path is named. */
  allow?: string[];
}

/**
 * Limits for a run someone other than the bot owner started: they may use the
 * bot, but not change the bridge or the agent itself. Edits to the fenced
 * paths are denied outright (Claude `Edit(...)` deny rules hold even under
 * bypassPermissions), shell commands go through the guard hook, and the
 * bridge's secrets and logs are unreadable.
 */
export interface RunGuard {
  home: string;
  rules: GuardRule[];
  /**
   * Inside `home`, the only places the run may read or write: the projects
   * the owner opened to others (`access.guestRoots`), the run's workspace,
   * and what the agent itself needs (skills, tools, attachments).
   */
  allowedRoots: string[];
  /** Regexes for further allowed paths (anchored), e.g. attachment dirs. */
  allowPatterns: string[];
  /** Absolute path globs the run may not read. */
  readDeny: string[];
  /** The PreToolUse hook script that applies the guard to tool calls. */
  hookScript: string;
}

const PACKAGE_NAME = 'lark-channel-bridge';

/** Root of the running bridge's own package — its source tree in a checkout. */
export function bridgeRoot(start: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === PACKAGE_NAME) {
          return dir;
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function ownerOnlyGuard(opts: {
  larkChannelHome: string;
  /** Projects the owner opened to others (`access.guestRoots`). */
  guestRoots?: readonly string[];
  /** The run's working directory. */
  workspace?: string;
  home?: string;
  root?: string;
}): RunGuard {
  const home = opts.home ?? homedir();
  const root = opts.root ?? bridgeRoot();
  const lc = opts.larkChannelHome;
  const claude = join(home, '.claude');
  const expand = (p: string): string => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);
  return {
    home,
    allowedRoots: [
      ...(opts.guestRoots ?? []).map(expand),
      ...(opts.workspace ? [opts.workspace] : []),
      // What the agent needs to do its job for anyone: skills (read and run,
      // never write — the rules below still apply) and command-line tools.
      join(claude, 'skills'),
      join(home, '.agents', 'skills'),
      ...skillTargets(join(claude, 'skills')),
      join(home, '.local', 'bin'),
    ],
    allowPatterns: [`${escapeRe(lc)}/profiles/[^/]+/media/`],
    rules: [
      { path: root, bash: 'any' },
      // Attachments the user sent land under media/ and must stay readable.
      { path: lc, bash: 'any', allow: [`${escapeRe(lc)}/profiles/[^/]+/media/`] },
      ...['CLAUDE.md', 'settings.json', 'settings.local.json', 'skills', 'agents', 'scripts', 'projects'].map(
        (name): GuardRule => ({ path: join(claude, name), bash: 'write' }),
      ),
      { path: join(home, '.local', 'bin'), bash: 'write' },
      { path: join(home, 'Library', 'LaunchAgents'), bash: 'write' },
    ],
    readDeny: [
      join(lc, 'config.json*'),
      join(lc, 'profiles', '*', 'secrets.enc'),
      join(lc, 'profiles', '*', 'lark-cli', '**'),
      join(lc, 'profiles', '*', 'logs', '**'),
    ],
    hookScript: join(root, 'bin', 'bridge-guard.mjs'),
  };
}

/** Where symlinked skills really live, so running their scripts stays possible. */
function skillTargets(skillsDir: string): string[] {
  const roots = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(skillsDir);
  } catch {
    return [];
  }
  for (const name of names) {
    try {
      const real = realpathSync(join(skillsDir, name));
      if (real !== join(skillsDir, name)) roots.add(real);
    } catch {
      /* dangling link */
    }
  }
  return [...roots];
}

/** Claude CLI flags that enforce `guard`, plus the env its hook reads. */
export function claudeGuardArgs(
  guard: RunGuard,
  nodeBinary: string = process.execPath,
): { args: string[]; env: Record<string, string> } {
  // `//abs/path` is Claude's absolute-path syntax; one Edit rule covers every
  // file-editing tool.
  const deny = [
    ...guard.rules.flatMap((r) => [`Edit(/${r.path})`, `Edit(/${r.path}/**)`]),
    ...guard.readDeny.map((p) => `Read(/${p})`),
  ];
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Read|Edit|MultiEdit|Write|NotebookEdit|Glob|Grep',
          hooks: [{ type: 'command', command: `"${nodeBinary}" "${guard.hookScript}"` }],
        },
      ],
    },
  };
  return {
    args: ['--disallowedTools', ...deny, '--settings', JSON.stringify(settings)],
    env: {
      LARK_CHANNEL_GUARD: JSON.stringify({
        home: guard.home,
        rules: guard.rules,
        allowedRoots: guard.allowedRoots,
        allowPatterns: guard.allowPatterns,
      }),
    },
  };
}

/** Every message of the batch came from the bot owner themselves (not a bot). */
export function isOwnerBatch(
  controls: RuntimeControls,
  batch: readonly NormalizedMessage[],
  isBot: (msg: NormalizedMessage) => boolean,
): boolean {
  return batch.length > 0 && batch.every((m) => isCreator(controls, m.senderId) && !isBot(m));
}
