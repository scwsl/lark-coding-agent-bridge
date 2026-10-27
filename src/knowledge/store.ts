import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * Bridge-managed knowledge for one profile: what the bot should remember, and
 * the reusable instructions it can pull in on demand.
 *
 * Everything is plain Markdown on disk rather than a database, for one reason:
 * the directory is meant to be a git repository. A human can read it, edit it
 * in an editor, review a diff of it, and sync it between machines — none of
 * which works if the same content lives in a JSON blob.
 *
 *   knowledge/
 *     MEMORY.md                 profile-wide notes
 *     chats/<scope>.md          notes scoped to one chat / topic
 *     skills/<name>/SKILL.md    reusable instructions, agent-agnostic
 */

export type MemoryScope = { kind: 'profile' } | { kind: 'chat'; scopeId: string };

export interface MemoryEntry {
  /** Short stable id, written into the file so edits keep it. */
  id: string;
  text: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  /** Absolute path of SKILL.md — handed to the agent so it can read the body. */
  path: string;
  /** Shared library the skill comes from; absent for the profile's own `skills/`. */
  source?: string;
}

/** Extra skills merged behind the profile's own — the shared libraries. */
export interface SkillSource {
  listSkills(): Promise<SkillSummary[]>;
}

/** Bullet lines look like `- [a1b2c3] remember this`. */
const ENTRY_RE = /^-\s*\[([0-9a-f]{6})\]\s*(.*)$/;

export class KnowledgeStore {
  readonly dir: string;
  private readonly skillSources: SkillSource[] = [];
  private noteRanker: (() => (name: string) => number) | undefined;

  constructor(dir: string = paths.knowledgeDir) {
    this.dir = dir;
  }

  /** Merge another source's skills behind this profile's own (`/skills lib`). */
  addSkillSource(source: SkillSource): void {
    this.skillSources.push(source);
  }

  get skillsDir(): string {
    return join(this.dir, 'skills');
  }

  /**
   * Topic notes (`notes/<scope>/<topic>.md`, written by 课堂精练) of these
   * scopes, name `<scope>/<topic>`. Only real files inside the directory.
   */
  async listNotes(scopeIds: readonly string[]): Promise<Array<{ name: string; path: string }>> {
    const out: Array<{ name: string; path: string }> = [];
    for (const scope of [...new Set(scopeIds.map(sanitizeScopeId))]) {
      const dir = join(this.dir, 'notes', scope);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.filter((item) => item.isFile() && /^[a-z0-9][a-z0-9-]*\.md$/.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
        out.push({ name: `${scope}/${entry.name.slice(0, -3)}`, path: join(dir, entry.name) });
      }
    }
    return out;
  }

  /**
   * Note directories of a chat's topics (`notes/<chat>_omt_…`), sorted. A
   * topic of a chat shares the chat's members, so what one topic learned is
   * fair to show in another.
   */
  async noteTopicScopes(chatId: string): Promise<string[]> {
    const prefix = `${sanitizeScopeId(chatId)}_omt_`;
    try {
      const entries = await readdir(join(this.dir, 'notes'), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * How useful a note (`<scope>/<topic>`) has been — 课堂精练's recall
   * count. Notes with a higher rank come first in their part of the index.
   * `ranker` is asked once per {@link rankNotes} for the rank as of now.
   */
  setNoteRank(ranker: (() => (name: string) => number) | undefined): void {
    this.noteRanker = ranker;
  }

  /** Notes ordered by {@link setNoteRank}, highest first; ties keep their order. */
  rankNotes<T extends { name: string }>(notes: readonly T[]): T[] {
    let rank: ((name: string) => number) | undefined;
    try {
      rank = this.noteRanker?.();
    } catch {
      rank = undefined;
    }
    if (!rank) return [...notes];
    const score = new Map(notes.map((note) => [note.name, safeRank(rank, note.name)]));
    return [...notes].sort((a, b) => (score.get(b.name) ?? 0) - (score.get(a.name) ?? 0));
  }

  memoryFile(scope: MemoryScope): string {
    if (scope.kind === 'profile') return join(this.dir, 'MEMORY.md');
    return join(this.dir, 'chats', `${sanitizeScopeId(scope.scopeId)}.md`);
  }

  async listMemories(scope: MemoryScope): Promise<MemoryEntry[]> {
    const raw = await readIfExists(this.memoryFile(scope));
    return raw ? parseMemoryEntries(raw) : [];
  }

  async addMemory(scope: MemoryScope, text: string): Promise<MemoryEntry> {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('memory text is empty');
    const existing = await this.listMemories(scope);
    const taken = new Set(existing.map((entry) => entry.id));
    let id = randomBytes(3).toString('hex');
    while (taken.has(id)) id = randomBytes(3).toString('hex');

    const file = this.memoryFile(scope);
    const current = (await readIfExists(file)) ?? defaultMemoryHeader(scope);
    const body = `${current.replace(/\s*$/, '')}\n- [${id}] ${clean}\n`;
    await this.write(file, body);
    return { id, text: clean };
  }

  async removeMemory(scope: MemoryScope, id: string): Promise<boolean> {
    const file = this.memoryFile(scope);
    const raw = await readIfExists(file);
    if (!raw) return false;
    let removed = false;
    const kept = raw.split('\n').filter((line) => {
      const match = ENTRY_RE.exec(line.trim());
      if (match?.[1] === id) {
        removed = true;
        return false;
      }
      return true;
    });
    if (!removed) return false;
    await this.write(file, `${kept.join('\n').replace(/\s*$/, '')}\n`);
    return true;
  }

  /** Drop every note in a scope — `/memory clear`. Returns how many went. */
  async clearMemories(scope: MemoryScope): Promise<number> {
    const entries = await this.listMemories(scope);
    if (entries.length === 0) return 0;
    await this.write(this.memoryFile(scope), defaultMemoryHeader(scope));
    return entries.length;
  }

  /**
   * Every skill the agent gets in its index: the profile's own first, then each
   * shared library's. A name that is already taken is skipped, so a profile can
   * override one library skill by writing its own under the same name.
   */
  async listSkills(): Promise<SkillSummary[]> {
    const own = await this.listOwnSkills();
    if (this.skillSources.length === 0) return own;
    const merged = [...own];
    const taken = new Set(own.map((skill) => skill.name));
    for (const source of this.skillSources) {
      let extra: SkillSummary[] = [];
      try {
        extra = await source.listSkills();
      } catch (err) {
        log.warn('knowledge', 'skill-source-failed', { err: String(err) });
      }
      for (const skill of extra) {
        if (taken.has(skill.name)) continue;
        taken.add(skill.name);
        merged.push(skill);
      }
    }
    return merged;
  }

  /** Only the skills under this profile's `knowledge/skills/`. */
  async listOwnSkills(): Promise<SkillSummary[]> {
    let names: string[];
    try {
      const dirents = await readdir(this.skillsDir, { withFileTypes: true });
      names = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('knowledge', 'skills-scan-failed', { err: String(err) });
      }
      return [];
    }

    const skills: SkillSummary[] = [];
    for (const name of names.sort()) {
      const path = join(this.skillsDir, name, 'SKILL.md');
      const raw = await readIfExists(path);
      if (raw === undefined) continue;
      skills.push({ ...parseSkillHeader(name, raw), path });
    }
    return skills;
  }

  async readSkill(name: string): Promise<{ summary: SkillSummary; body: string } | undefined> {
    if (isSafeSkillName(name)) {
      const path = join(this.skillsDir, name, 'SKILL.md');
      const raw = await readIfExists(path);
      if (raw !== undefined) return { summary: { ...parseSkillHeader(name, raw), path }, body: raw };
    }
    if (this.skillSources.length === 0) return undefined;
    // Library skills are looked up by their indexed name, never by a path built
    // from the request, so `show ../../x` cannot reach outside a mirror.
    const summary = (await this.listSkills()).find((skill) => skill.source && skill.name === name);
    if (!summary) return undefined;
    const raw = await readIfExists(summary.path);
    return raw === undefined ? undefined : { summary, body: raw };
  }

  /** Create the directory skeleton so a fresh profile has something to sync. */
  async ensure(): Promise<void> {
    await mkdir(join(this.dir, 'chats'), { recursive: true, mode: 0o700 });
    await mkdir(this.skillsDir, { recursive: true, mode: 0o700 });
  }

  /** Remove a chat's note file entirely (used when a chat is forgotten). */
  async dropChat(scopeId: string): Promise<void> {
    await rm(this.memoryFile({ kind: 'chat', scopeId }), { force: true });
  }

  private async write(file: string, body: string): Promise<void> {
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    // 0600 like every other piece of profile state: chat notes routinely quote
    // things people would not want world-readable on a shared machine.
    await writeFileAtomic(file, body, { mode: 0o600 });
  }
}

function safeRank(rank: (name: string) => number, name: string): number {
  try {
    const value = rank(name);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** The `- [id] text` bullets of a memory file, in order. */
export function parseMemoryEntries(raw: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const line of raw.split('\n')) {
    const match = ENTRY_RE.exec(line.trim());
    if (match?.[1] && match[2]?.trim()) entries.push({ id: match[1], text: match[2].trim() });
  }
  return entries;
}

export function defaultMemoryHeader(scope: MemoryScope): string {
  return scope.kind === 'profile'
    ? '# 记忆（全局）\n\n这个 profile 下所有会话都会看到下面的内容。\n'
    : '# 记忆（本会话）\n\n只有这个会话会看到下面的内容。\n';
}

/**
 * A chat scope id (`oc_xxx` or `oc_xxx:omt_yyy`) becomes one safe file name.
 * The colon is illegal on Windows, and the id itself is not a secret but is
 * long, so it is kept verbatim apart from separator characters.
 */
export function sanitizeScopeId(scopeId: string): string {
  return scopeId.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'unknown';
}

export function isSafeSkillName(name: string): boolean {
  return /^[\w.-]{1,64}$/.test(name) && name !== '.' && name !== '..';
}

/**
 * Read a skill's name and one-line description.
 *
 * Accepts the YAML-ish frontmatter that Claude Code skills use, and falls back
 * to "first heading + first paragraph" so a plain Markdown file also works —
 * the point of this layer is that one file serves both agents.
 */
export function parseSkillHeader(dirName: string, raw: string): { name: string; description: string } {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
  if (frontmatter?.[1]) {
    const block = frontmatter[1];
    const name = frontmatterValue(block, 'name');
    const description = frontmatterValue(block, 'description');
    if (name || description) {
      return { name: name || dirName, description: description || '' };
    }
  }

  const lines = raw.split('\n');
  const heading = lines.find((line) => line.startsWith('# '))?.slice(2).trim();
  const firstProse = lines.find(
    (line) => line.trim() && !line.startsWith('#') && !line.startsWith('---'),
  );
  return { name: heading || dirName, description: (firstProse ?? '').trim() };
}

/** One top-level frontmatter value of a SKILL.md (`argument-hint`, …), or undefined without one. */
export function skillFrontmatterValue(raw: string, key: string): string | undefined {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
  return frontmatter?.[1] ? frontmatterValue(frontmatter[1], key) : undefined;
}

/**
 * One top-level scalar from a YAML-ish frontmatter block: plain, quoted
 * (`"…"` / `'…'`), or a folded / literal block (`>`, `|`) whose indented lines
 * are joined into one line — the index wants a single line either way.
 */
function frontmatterValue(block: string, key: string): string | undefined {
  const lines = block.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index < 0) return undefined;
  let value = lines[index]!.slice(key.length + 1).trim();
  if (/^[>|][+-]?$/.test(value)) {
    const body: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (line.trim() && !/^\s/.test(line)) break;
      if (line.trim()) body.push(line.trim());
    }
    value = body.join(' ');
  } else if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
    const quote = value[0];
    value = value.slice(1, -1);
    value = quote === '"' ? value.replace(/\\(["\\])/g, '$1') : value.replace(/''/g, "'");
  }
  return value.trim() || undefined;
}
