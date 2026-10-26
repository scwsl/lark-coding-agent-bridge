import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../core/logger';
import type { KnowledgeContext } from './inject';

/** Snapshots kept: enough for every chat's current version and a few old ones. */
const KEEP = 40;

/**
 * Write the block of `context.version` to `<dir>/<version>.json` (once) and
 * return its path, for the stub a resumed conversation gets instead of the
 * block. Old snapshots beyond {@link KEEP} are removed. Never throws.
 */
export async function writeKnowledgeSnapshot(dir: string, context: KnowledgeContext): Promise<string | undefined> {
  if (!context.version) return undefined;
  const file = join(dir, `${context.version}.json`);
  try {
    await mkdir(dir, { recursive: true });
    const exists = await stat(file).then(() => true, () => false);
    if (!exists) {
      await writeFile(file, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
      await prune(dir);
    }
    return file;
  } catch (err) {
    log.warn('knowledge', 'snapshot-failed', { err: String(err) });
    return undefined;
  }
}

async function prune(dir: string): Promise<void> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  if (names.length <= KEEP) return;
  const aged = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(dir, name))).mtimeMs })));
  aged.sort((a, b) => b.at - a.at);
  await Promise.all(aged.slice(KEEP).map((entry) => unlink(join(dir, entry.name)).catch(() => undefined)));
}
