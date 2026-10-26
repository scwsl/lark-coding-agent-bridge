import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TTL_MS = 60_000;
let cached: { at: number; root: string; dirs: ReadonlySet<string> } | undefined;

/**
 * Skill directory names Claude Code lists on its own (`<config dir>/skills`),
 * so the bridge's skill index can leave them out. Re-read at most once a
 * minute; empty when the directory cannot be read.
 */
export function claudeNativeSkillDirs(env: NodeJS.ProcessEnv = process.env, now = Date.now()): ReadonlySet<string> {
  const root = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills');
  if (cached && cached.root === root && now - cached.at < TTL_MS) return cached.dirs;
  let dirs: ReadonlySet<string>;
  try {
    dirs = new Set(
      readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name),
    );
  } catch {
    dirs = new Set();
  }
  cached = { at: now, root, dirs };
  return dirs;
}
