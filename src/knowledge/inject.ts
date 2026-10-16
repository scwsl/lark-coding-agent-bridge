import type { KnowledgeStore, MemoryEntry, SkillSummary } from './store';

export interface KnowledgeContext {
  /** Notes that apply to every chat in this profile. */
  profileMemory?: string[];
  /** Notes recorded for this chat / topic only. */
  chatMemory?: string[];
  /** Index only — the agent reads a skill's body itself when it needs it. */
  skills?: SkillRef[];
  /** Topic notes (课堂精练), index only: `external/…` came from other bots' libraries. */
  notes?: Array<{ name: string; path: string }>;
  /** Set when notes were dropped to stay inside the budget. */
  truncated?: boolean;
}

export interface BuildKnowledgeContextInput {
  store: KnowledgeStore;
  scopeId: string;
  /** Character budget for the memory notes. Skills are just an index. */
  maxChars?: number;
}

export interface SkillRef {
  name: string;
  description: string;
  path: string;
  /** Shared library the skill comes from; absent for the profile's own. */
  source?: string;
}

const DEFAULT_MAX_CHARS = 6000;
const MAX_SKILLS = 80;
/**
 * The index rides along on every message, and shared libraries can bring dozens
 * of skills with paragraph-long descriptions. One sentence is enough to decide
 * whether to open the body, and the whole index gets its own budget.
 */
const MAX_DESCRIPTION_CHARS = 240;
const SKILL_INDEX_MAX_CHARS = 16_000;
/** 课前学习 writes what it learned from other bots under `notes/external/`; every chat may read it. */
const EXTERNAL_NOTES_SCOPE = 'external';
const MAX_NOTES = 60;

/**
 * Assemble what the agent should know before answering, or `undefined` when
 * there is nothing to inject.
 *
 * Only the skill *index* goes into the prompt. Bodies stay on disk and are read
 * on demand: a dozen skills would otherwise cost thousands of tokens on every
 * single turn, most of them irrelevant to the message at hand.
 */
export async function buildKnowledgeContext(
  input: BuildKnowledgeContextInput,
): Promise<KnowledgeContext | undefined> {
  // A topic (`oc_xxx:omt_yyy`) also sees its group's notes (`oc_xxx`), so a
  // topic group can keep one shared memory instead of one per topic.
  const groupId = input.scopeId.includes(':') ? input.scopeId.split(':')[0] : undefined;
  const [profile, group, topic, skills, notes] = await Promise.all([
    input.store.listMemories({ kind: 'profile' }),
    groupId ? input.store.listMemories({ kind: 'chat', scopeId: groupId }) : Promise.resolve([]),
    input.store.listMemories({ kind: 'chat', scopeId: input.scopeId }),
    input.store.listSkills(),
    input.store.listNotes([EXTERNAL_NOTES_SCOPE, ...(groupId ? [groupId] : []), input.scopeId]).catch(() => []),
  ]);
  const keptNotes = notes.slice(0, MAX_NOTES);
  const chat = [...group, ...topic];

  const budgeted = applyBudget(profile, chat, input.maxChars ?? DEFAULT_MAX_CHARS);
  const trimmedSkills = budgetSkills(skills.slice(0, MAX_SKILLS).map(toSkillRef));
  if (
    budgeted.profile.length === 0 &&
    budgeted.chat.length === 0 &&
    trimmedSkills.length === 0 &&
    keptNotes.length === 0
  ) {
    return undefined;
  }

  return {
    ...(budgeted.profile.length > 0 ? { profileMemory: budgeted.profile } : {}),
    ...(budgeted.chat.length > 0 ? { chatMemory: budgeted.chat } : {}),
    ...(trimmedSkills.length > 0 ? { skills: trimmedSkills } : {}),
    ...(keptNotes.length > 0 ? { notes: keptNotes } : {}),
    ...(budgeted.truncated || skills.length > trimmedSkills.length || notes.length > keptNotes.length ? { truncated: true } : {}),
  };
}

function toSkillRef(skill: SkillSummary): SkillRef {
  const description =
    skill.description.length > MAX_DESCRIPTION_CHARS
      ? `${skill.description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
      : skill.description;
  return {
    name: skill.name,
    description,
    path: skill.path,
    ...(skill.source ? { source: skill.source } : {}),
  };
}

/** Keep skills in order until the index budget runs out (own skills come first). */
function budgetSkills(skills: SkillRef[]): SkillRef[] {
  const kept: SkillRef[] = [];
  let used = 0;
  for (const skill of skills) {
    const size = skill.name.length + skill.description.length + skill.path.length + (skill.source?.length ?? 0);
    if (used + size > SKILL_INDEX_MAX_CHARS) break;
    kept.push(skill);
    used += size;
  }
  return kept;
}

/**
 * Keep the newest notes when the budget is tight, and give chat notes priority
 * over profile ones: the local context is what the current message is about.
 */
function applyBudget(
  profile: MemoryEntry[],
  chat: MemoryEntry[],
  maxChars: number,
): { profile: string[]; chat: string[]; truncated: boolean } {
  const keptChat: string[] = [];
  const keptProfile: string[] = [];
  let used = 0;
  let truncated = false;

  for (const entry of [...chat].reverse()) {
    if (used + entry.text.length > maxChars) {
      truncated = true;
      break;
    }
    keptChat.unshift(entry.text);
    used += entry.text.length;
  }
  for (const entry of [...profile].reverse()) {
    if (used + entry.text.length > maxChars) {
      truncated = true;
      break;
    }
    keptProfile.unshift(entry.text);
    used += entry.text.length;
  }

  return { profile: keptProfile, chat: keptChat, truncated };
}
