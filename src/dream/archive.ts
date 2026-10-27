/**
 * 深睡·归档: a note nobody has opened for a month, and nobody has changed,
 * only lengthens the notes index every conversation is shown. It moves to
 * `archive/notes/` — out of the index, still in the repository, one `git mv`
 * away from coming back. Whether a note changed is told by the hash of its
 * content each night ({@link RecallStore.observeNotes}), not by git history:
 * the checkouts are shallow.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { REVIEW_NOTE } from './consolidate';

/** Unread, unchanged and known for this many days before a note is archived. */
export const ARCHIVE_DAYS = 30;
/** At most this many notes a night, so one night never empties the index. */
export const MAX_ARCHIVE = 20;

export interface ObservedNote {
  /** Recall key: `note:<scope>/<topic>`. */
  key: string;
  hash: string;
}

const SCOPE_RE = /^[\w.-]+$/;
const TOPIC_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Every note of the checkout the recall counts can speak for, with the hash of its content. */
export async function observeNotes(dir: string): Promise<ObservedNote[]> {
  const root = join(dir, 'notes');
  const out: ObservedNote[] = [];
  const scopes = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const scope of scopes.filter((item) => item.isDirectory() && SCOPE_RE.test(item.name)).map((item) => item.name).sort()) {
    const names = await readdir(join(root, scope)).catch(() => [] as string[]);
    for (const name of names.sort()) {
      const topic = name.replace(/\.md$/, '');
      if (!name.endsWith('.md') || !TOPIC_RE.test(topic) || topic === REVIEW_NOTE) continue;
      const raw = await readFile(join(root, scope, name), 'utf8').catch(() => undefined);
      if (raw === undefined) continue;
      out.push({ key: `note:${scope}/${topic}`, hash: createHash('sha256').update(raw).digest('hex').slice(0, 16) });
    }
  }
  return out;
}

/** Move the notes to `archive/notes/`. Returns the paths to commit and the notes moved. */
export async function archiveNotes(dir: string, keys: readonly string[]): Promise<{ files: string[]; moved: string[] }> {
  const files: string[] = [];
  const moved: string[] = [];
  for (const key of keys) {
    const ref = key.replace(/^note:/, '');
    const [scope = '', topic = ''] = ref.split('/');
    if (!SCOPE_RE.test(scope) || !TOPIC_RE.test(topic) || topic === REVIEW_NOTE) continue;
    const from = `notes/${scope}/${topic}.md`;
    const to = `archive/notes/${scope}/${topic}.md`;
    await mkdir(join(dir, 'archive', 'notes', scope), { recursive: true });
    try {
      await rename(join(dir, ...from.split('/')), join(dir, ...to.split('/')));
    } catch {
      continue;
    }
    files.push(from, to);
    moved.push(ref);
  }
  return { files, moved };
}

export function archiveChangelogLines(moved: readonly string[]): string[] {
  return moved.map((ref) => `- 归档 \`notes/${ref}.md\` → \`archive/notes/${ref}.md\`（${ARCHIVE_DAYS} 天没被读过、没改过）`);
}
