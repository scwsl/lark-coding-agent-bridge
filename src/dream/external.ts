import { lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type { DreamExternalLibraryConfig } from '../config/schema';
import { git, isSafeRef, type GitResult } from '../git/exec';
import { maskUrlCredentials } from '../knowledge/libraries';
import { parseSkillHeader } from '../knowledge/store';
import { isPlausibleGitUrl } from '../knowledge/sync';
import { maskSecrets } from './secrets';

/**
 * 课前学习: before a run reads its own conversations, it studies what changed
 * in the external repositories the owner pointed it at — other bots' knowledge
 * and skill libraries. They are cloned read-only into the run's scratch space
 * and never written to; only Markdown is read, newest change since the last
 * run's commit first, within a character budget. What does not fit stays
 * `pending` for the next run, so a large first read is spread over several.
 */

export interface ExternalCursor {
  /** Commit everything up to which has been read. */
  commit: string;
  learnedAt: number;
  /** Files changed up to {@link commit} that did not fit the budget yet. */
  pending?: string[];
}

export interface ExternalFile {
  /** `X1`, `X2`… — numbered across every library of the run. */
  ref: string;
  library: string;
  path: string;
  content: string;
  truncated: boolean;
}

export interface ExternalMaterial {
  library: string;
  /** Commit read this time; becomes the cursor at the checkpoint. */
  head: string;
  files: ExternalFile[];
  /** Changed files left for the next run. */
  pending: string[];
  /** Nothing was read before (or the old cursor is gone): the whole repository counts as new. */
  full: boolean;
}

const CLONE_TIMEOUT_MS = 120_000;
const FETCH_DEPTH = '50';
const MAX_FILE_BYTES = 200_000;
export const MAX_EXTERNAL_FILE_CHARS = 12_000;

/** Bring `dir` to the library's latest remote commit. Never merges, never pushes. */
export async function fetchExternalLibrary(
  library: DreamExternalLibraryConfig,
  dir: string,
): Promise<{ head: string } | { error: string }> {
  if (!isPlausibleGitUrl(library.url)) return { error: '仓库地址不合法' };
  if (library.ref !== undefined && !isSafeRef(library.ref)) return { error: `分支名 ${library.ref} 不合法` };
  const present = await lstat(join(dir, '.git')).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (present) {
    const fetched = await git(
      dir,
      ['-c', 'protocol.ext.allow=never', 'fetch', '-q', '--no-tags', '--depth', FETCH_DEPTH, 'origin', library.ref ?? 'HEAD'],
      { timeoutMs: CLONE_TIMEOUT_MS },
    );
    if (fetched.ok) {
      const checkout = await git(dir, ['checkout', '-q', '--force', '--detach', 'FETCH_HEAD']);
      if (checkout.ok) {
        await git(dir, ['clean', '-q', '-fdx']);
        return head(dir);
      }
    }
    // A broken or re-pointed mirror is simply cloned again.
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  const cloned = await git(
    dirname(dir),
    [
      '-c',
      'protocol.ext.allow=never',
      'clone',
      '-q',
      '--no-tags',
      '--single-branch',
      '--depth',
      FETCH_DEPTH,
      ...(library.ref ? ['--branch', library.ref] : []),
      '--',
      library.url,
      dir,
    ],
    { timeoutMs: CLONE_TIMEOUT_MS },
  );
  if (!cloned.ok) return { error: `拉取失败：${failure(cloned)}` };
  return head(dir);
}

/**
 * The Markdown files of `dir` changed since the cursor (all of them without
 * one), pending ones first, skills before the rest, read until `budget`
 * characters are used. `startRef` numbers the first file.
 */
export async function collectExternalMaterial(input: {
  library: string;
  dir: string;
  head: string;
  cursor?: ExternalCursor;
  budget: number;
  startRef: number;
}): Promise<ExternalMaterial> {
  const { dir, cursor } = input;
  const known = cursor ? (await git(dir, ['cat-file', '-e', `${cursor.commit}^{commit}`])).ok : false;
  let changed: string[];
  if (cursor && known && cursor.commit === input.head) changed = [];
  else if (cursor && known) {
    const diff = await git(dir, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=AMR', `${cursor.commit}..${input.head}`]);
    changed = diff.ok ? splitZ(diff.stdout) : [];
  } else {
    const listed = await git(dir, ['ls-files', '-z']);
    changed = listed.ok ? splitZ(listed.stdout) : [];
  }
  const candidates = unique([...(known ? (cursor?.pending ?? []) : []), ...changed].filter(isStudyFile));
  candidates.sort((a, b) => rank(a) - rank(b));

  const files: ExternalFile[] = [];
  const pending: string[] = [];
  let used = 0;
  let next = input.startRef;
  for (const path of candidates) {
    if (used >= input.budget) {
      pending.push(path);
      continue;
    }
    const text = await readInside(dir, path);
    if (text === undefined) continue;
    const masked = maskSecrets(text);
    const room = Math.min(MAX_EXTERNAL_FILE_CHARS, input.budget - used);
    if (masked.length > room && files.length > 0 && room < MAX_EXTERNAL_FILE_CHARS) {
      // Would only fit cut short: leave it whole for the next run.
      pending.push(path);
      used = input.budget;
      continue;
    }
    const content = masked.length > room ? `${masked.slice(0, room)}…` : masked;
    files.push({ ref: `X${next++}`, library: input.library, path, content, truncated: masked.length > room });
    used += content.length;
  }
  return { library: input.library, head: input.head, files, pending, full: !known };
}

/** SKILL.md files under `dirs` (top-level skill directories), name and description only. */
export async function listLocalSkills(dirs: readonly string[]): Promise<Array<{ name: string; description: string }>> {
  const out: Array<{ name: string; description: string }> = [];
  for (const raw of dirs) {
    const dir = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const body = await readFile(join(dir, name, 'SKILL.md'), 'utf8').catch(() => undefined);
      if (body === undefined) continue;
      const header = parseSkillHeader(name, body);
      if (!out.some((item) => item.name === header.name)) {
        out.push({ name: header.name, description: header.description.slice(0, 200) });
      }
    }
  }
  return out;
}

export function describeExternal(library: DreamExternalLibraryConfig): string {
  return `${library.name}（${maskUrlCredentials(library.url)}${library.ref ? `@${library.ref}` : ''}）`;
}

function isStudyFile(path: string): boolean {
  if (!/\.md$/i.test(path)) return false;
  return !path.split('/').some((part) => part.startsWith('.'));
}

/** Skills first, then the knowledge files, READMEs last. */
function rank(path: string): number {
  if (/(^|\/)SKILL\.md$/i.test(path)) return 0;
  if (/(^|\/)README\.md$/i.test(path)) return 2;
  return 1;
}

async function readInside(dir: string, path: string): Promise<string | undefined> {
  const file = join(dir, ...path.split('/'));
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    const [root, real] = await Promise.all([realpath(dir), realpath(file)]);
    const rel = relative(root, real);
    if (rel.startsWith('..') || rel.startsWith(sep)) return undefined;
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function head(dir: string): Promise<{ head: string } | { error: string }> {
  const result = await git(dir, ['rev-parse', 'HEAD']);
  return result.ok ? { head: result.stdout.trim() } : { error: '读不到最新提交' };
}

function splitZ(text: string): string[] {
  return text.split('\0').filter(Boolean);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function failure(result: GitResult): string {
  const text = maskUrlCredentials(result.stderr.trim() || result.stdout.trim());
  if (/repository not found|not found|could not read from remote|permission denied|403/i.test(text)) {
    return `没有读权限或仓库不存在（${text.split('\n')[0]?.slice(0, 160) ?? ''}）`;
  }
  return result.timedOut ? '超时' : text.split('\n').slice(-1)[0]?.slice(0, 200) || `退出码 ${result.code}`;
}
