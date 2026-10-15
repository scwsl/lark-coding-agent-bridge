import { readFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

export interface ManagedWorktree {
  repoRoot: string;
  path: string;
  branch: string;
  /** Only branches created by bridge may be deleted automatically. */
  ownedBranch: boolean;
  lastUsedAt: number;
}

interface WorkspaceData {
  chats: Record<string, { cwd: string }>;
  named: Record<string, string>;
  managedWorktrees?: ManagedWorktree[];
}

export class WorkspaceStore {
  private data: WorkspaceData = { chats: {}, named: {} };
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.workspacesFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Partial<WorkspaceData>;
      this.data = {
        chats: parsed.chats ?? {},
        named: parsed.named ?? {},
        managedWorktrees: parsed.managedWorktrees ?? [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  cwdFor(chatId: string): string | undefined {
    return this.data.chats[chatId]?.cwd;
  }

  setCwd(chatId: string, cwd: string): void {
    this.touchWorktree(this.data.chats[chatId]?.cwd);
    this.touchWorktree(cwd);
    this.data.chats[chatId] = { cwd };
    this.schedulePersist();
  }

  removeCwd(chatId: string): boolean {
    if (!(chatId in this.data.chats)) return false;
    this.touchWorktree(this.data.chats[chatId]?.cwd);
    delete this.data.chats[chatId];
    this.schedulePersist();
    return true;
  }

  listCwds(prefix?: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.data.chats)) {
      if (prefix && !key.startsWith(prefix)) continue;
      out[key] = value.cwd;
    }
    return out;
  }

  listNamed(): Record<string, string> {
    return { ...this.data.named };
  }

  getNamed(name: string): string | undefined {
    return this.data.named[name];
  }

  saveNamed(name: string, cwd: string): void {
    this.data.named[name] = cwd;
    this.schedulePersist();
  }

  removeNamed(name: string): boolean {
    if (!(name in this.data.named)) return false;
    delete this.data.named[name];
    this.schedulePersist();
    return true;
  }

  trackWorktree(entry: Omit<ManagedWorktree, 'lastUsedAt'>, now = Date.now()): void {
    this.data.managedWorktrees = [...this.listManagedWorktrees().filter(e => e.path !== entry.path), { ...entry, lastUsedAt: now }];
    this.schedulePersist();
  }

  listManagedWorktrees(): ManagedWorktree[] {
    return (this.data.managedWorktrees ?? []).map(e => ({ ...e }));
  }

  touchWorktree(cwd: string | undefined, now = Date.now()): void {
    if (!cwd) return;
    const entry = this.data.managedWorktrees?.find(e => e.path === cwd);
    if (entry) { entry.lastUsedAt = now; this.schedulePersist(); }
  }

  forgetWorktree(path: string): void {
    this.data.managedWorktrees = this.listManagedWorktrees().filter(e => e.path !== path);
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => {
        log.fail('workspace', err, { step: 'persist' });
      });
  }
}
