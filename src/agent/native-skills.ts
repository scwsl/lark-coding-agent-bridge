import { claudeNativeSkillDirs } from './claude/native-skills';
import type { AgentKind } from './registry';

const NATIVE_SKILL_DIRS: Record<AgentKind, (() => ReadonlySet<string>) | undefined> = {
  claude: () => claudeNativeSkillDirs(),
  // Codex lists no skills of its own.
  codex: undefined,
};

/** Skill directory names the agent CLI lists on its own; undefined when it lists none. */
export function nativeSkillDirsFor(kind: AgentKind): ReadonlySet<string> | undefined {
  return NATIVE_SKILL_DIRS[kind]?.();
}
