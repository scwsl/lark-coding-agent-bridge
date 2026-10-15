import type { Controls } from '../commands';
import {
  profileAppPaths,
  saveKnowledgeConfig,
  saveSkillsConfig,
  type MutableProfileState,
} from '../config/config-ops';
import type { SkillLibraryConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { isDirty } from '../git/status';
import {
  getKnowledgeSyncIntervalMinutes,
  summarizeSyncError,
  type KnowledgeSyncRecord,
} from '../knowledge/auto-sync';
import {
  buildLibraryConfig,
  getSkillSyncIntervalMinutes,
  maskUrlCredentials,
  shadowedSkills,
  SkillLibraries,
  type LibrarySyncResult,
} from '../knowledge/libraries';
import { KnowledgeStore } from '../knowledge/store';
import {
  bindKnowledgeRemote,
  isGitError,
  knowledgeRemoteUrl,
  ownRepoStatus,
  syncKnowledge,
  unbindKnowledgeRemote,
  type SyncOutcome,
} from '../knowledge/sync';
import { ApiError } from './api';

/**
 * The console's view of a profile's shared skill libraries (`/skills lib`) and
 * knowledge repo (`/knowledge`), with the same operations as those commands.
 *
 * A profile this process hosts is driven through its live objects, so changes
 * apply at once and share its sync queue. Any other profile — stopped, or run
 * by its own daemon — gets fresh objects over the same directories: settings
 * land in the config file and apply on its next start, while git work (pull a
 * library, bind / sync the knowledge repo) acts on disk right away, which the
 * running daemon reads on its next run.
 */
export interface ProfileTarget {
  state: MutableProfileState;
  live: boolean;
  controls?: Controls;
}

export interface SkillLibraryView {
  name: string;
  /** Credentials masked. */
  url: string;
  ref?: string;
  path?: string;
  include?: string[];
  exclude?: string[];
  /** A mirror exists on disk. */
  present: boolean;
  commit?: string;
  commitAt?: number;
  /** Only known for a profile this process runs. */
  lastSyncAt?: number;
  lastError?: string;
  skills: { name: string; description: string }[];
  /** Skills not loaded because an earlier one has the same name. */
  shadowed: string[];
}

export interface SkillsView {
  live: boolean;
  syncIntervalMinutes: number;
  libraries: SkillLibraryView[];
  /** Outcome of the sync this response is for, one per library. */
  results?: LibrarySyncResult[];
}

export interface KnowledgeView {
  live: boolean;
  dir: string;
  /** The directory is a git repository of its own. */
  repo: boolean;
  /** `origin`, credentials masked. */
  remote?: string;
  branch?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  profileMemories: number;
  /** Skills under the profile's own `knowledge/skills/`. */
  ownSkills: number;
  syncIntervalMinutes: number;
  /** The running loop's state; only for a profile this process runs. */
  autoSync?: { syncing: boolean; failures: number; last?: KnowledgeSyncRecord };
  /** Outcome of the sync this response is for. */
  outcome?: SyncOutcome;
  /** Remark from a bind, e.g. that the remote was empty. */
  note?: string;
}

/** Longest interval the console accepts: a week. */
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

function configuredLibraries(target: ProfileTarget): SkillLibraryConfig[] {
  return target.state.profileConfig.skills?.libraries ?? [];
}

/**
 * Library managers of profiles this process does not run, kept across requests
 * so two syncs of one mirror share a fetch and the last result stays visible.
 * Each request points `source` at its own freshly loaded config.
 */
const offlineLibraries = new Map<string, { source: () => SkillLibraryConfig[]; manager: SkillLibraries }>();

function librariesFor(target: ProfileTarget): SkillLibraries {
  if (target.controls?.skillLibraries) return target.controls.skillLibraries;
  const dir = profileAppPaths(target.state).skillLibrariesDir;
  const source = () => configuredLibraries(target);
  const known = offlineLibraries.get(dir);
  if (known) {
    known.source = source;
    return known.manager;
  }
  const holder = { source };
  const manager = new SkillLibraries({ dir, libraries: () => holder.source() });
  offlineLibraries.set(dir, Object.assign(holder, { manager }));
  return manager;
}

function storeFor(target: ProfileTarget, libraries: SkillLibraries): KnowledgeStore {
  if (target.controls?.knowledge) return target.controls.knowledge;
  const store = new KnowledgeStore(profileAppPaths(target.state).knowledgeDir);
  store.addSkillSource(libraries);
  return store;
}

export async function skillsView(target: ProfileTarget): Promise<SkillsView> {
  const libraries = librariesFor(target);
  const [statuses, merged] = await Promise.all([libraries.status(), storeFor(target, libraries).listSkills()]);
  return {
    live: target.live,
    syncIntervalMinutes: getSkillSyncIntervalMinutes(target.state.profileConfig.skills),
    libraries: statuses.map((status) => ({
      name: status.config.name,
      url: maskUrlCredentials(status.config.url),
      ...(status.config.ref ? { ref: status.config.ref } : {}),
      ...(status.config.path ? { path: status.config.path } : {}),
      ...(status.config.include ? { include: status.config.include } : {}),
      ...(status.config.exclude ? { exclude: status.config.exclude } : {}),
      present: status.present,
      ...(status.commit ? { commit: status.commit } : {}),
      ...(status.commitAt ? { commitAt: status.commitAt } : {}),
      ...(status.lastSyncAt ? { lastSyncAt: status.lastSyncAt } : {}),
      ...(status.lastError ? { lastError: status.lastError } : {}),
      skills: status.skills.map(({ name, description }) => ({ name, description })),
      shadowed: shadowedSkills(status, merged),
    })),
  };
}

/**
 * `add` (pull first, save only when that worked), `remove` (config entry and
 * mirror), `sync` (one library or all), `interval` (minutes between pulls).
 */
export async function mutateSkills(target: ProfileTarget, body: unknown): Promise<SkillsView> {
  const fv = asRecord(body);
  const libraries = librariesFor(target);
  const configured = configuredLibraries(target);
  const name = typeof fv.name === 'string' ? fv.name.trim() : '';

  switch (fv.action) {
    case 'add': {
      const built = buildLibraryConfig(
        {
          url: typeof fv.url === 'string' ? fv.url : '',
          name,
          ...(typeof fv.ref === 'string' ? { ref: fv.ref } : {}),
          ...(typeof fv.path === 'string' ? { path: fv.path } : {}),
          include: stringList(fv.include),
          exclude: stringList(fv.exclude),
        },
        new Set(configured.map((library) => library.name)),
      );
      if ('error' in built) throw new ApiError(400, built.error);
      const library = built.library;
      const result = await libraries.syncLibrary(library);
      if (!result.ok) throw new ApiError(400, `拉取 ${library.name} 失败：${result.error ?? '未知错误'}`);
      try {
        await saveSkillsConfig(target.state, (skills) => ({
          ...skills,
          libraries: [...skills.libraries.filter((item) => item.name !== library.name), library],
        }));
      } catch (err) {
        await libraries.remove(library.name).catch(() => undefined);
        throw new ApiError(500, `保存配置失败：${err instanceof Error ? err.message : String(err)}`);
      }
      log.info('ui', 'skill-library-added', { profile: target.state.profile, library: library.name });
      return { ...(await skillsView(target)), results: [result] };
    }
    case 'remove': {
      if (!configured.some((library) => library.name === name)) throw new ApiError(404, `没有叫 ${name} 的库`);
      await saveSkillsConfig(target.state, (skills) => ({
        ...skills,
        libraries: skills.libraries.filter((library) => library.name !== name),
      }));
      await libraries.remove(name);
      log.info('ui', 'skill-library-removed', { profile: target.state.profile, library: name });
      return skillsView(target);
    }
    case 'sync': {
      if (configured.length === 0) throw new ApiError(400, '还没有配置 skill 库');
      if (name && !configured.some((library) => library.name === name)) throw new ApiError(404, `没有叫 ${name} 的库`);
      const results = await libraries.sync(name || undefined);
      return { ...(await skillsView(target)), results };
    }
    case 'interval': {
      const minutes = parseInterval(fv.minutes);
      await saveSkillsConfig(target.state, (skills) => ({ ...skills, syncIntervalMinutes: minutes }));
      target.controls?.skillLibraries?.reschedule();
      return skillsView(target);
    }
    default:
      throw new ApiError(400, 'action must be add|remove|sync|interval');
  }
}

export async function knowledgeView(target: ProfileTarget): Promise<KnowledgeView> {
  const store = storeFor(target, librariesFor(target));
  // Only a repository of its own counts: a directory inside some other
  // repository would report that one's branch and remote.
  const repo = await ownRepoStatus(store);
  const [remote, memories, ownSkills] = await Promise.all([
    repo ? knowledgeRemoteUrl(store) : undefined,
    store.listMemories({ kind: 'profile' }),
    store.listOwnSkills(),
  ]);
  const auto = target.controls?.knowledgeAutoSync?.status();
  return {
    live: target.live,
    dir: store.dir,
    repo: Boolean(repo),
    ...(remote ? { remote: maskUrlCredentials(remote) } : {}),
    ...(repo?.branch ? { branch: repo.branch } : {}),
    ...(repo?.upstream ? { ahead: repo.upstream.ahead, behind: repo.upstream.behind } : {}),
    ...(repo ? { dirty: isDirty(repo) } : {}),
    profileMemories: memories.length,
    ownSkills: ownSkills.length,
    syncIntervalMinutes: getKnowledgeSyncIntervalMinutes(target.state.profileConfig.knowledge),
    ...(auto
      ? { autoSync: { syncing: auto.syncing, failures: auto.failures, ...(auto.last ? { last: auto.last } : {}) } }
      : {}),
  };
}

/** `bind` a remote, `unbind` it, `sync` now, or set the auto-sync `interval`. */
export async function mutateKnowledge(target: ProfileTarget, body: unknown): Promise<KnowledgeView> {
  const fv = asRecord(body);
  const store = storeFor(target, librariesFor(target));

  switch (fv.action) {
    case 'bind': {
      const url = typeof fv.url === 'string' ? fv.url.trim() : '';
      if (!url) throw new ApiError(400, '缺少 git 仓库地址');
      const result = await bindKnowledgeRemote(store, url);
      if (isGitError(result)) throw new ApiError(400, `绑定失败：${summarizeSyncError(result.error)}`);
      log.info('ui', 'knowledge-remote-bound', { profile: target.state.profile });
      return { ...(await knowledgeView(target)), ...(result.note ? { note: result.note } : {}) };
    }
    case 'unbind': {
      const result = await unbindKnowledgeRemote(store);
      if (isGitError(result)) throw new ApiError(400, `解绑失败：${summarizeSyncError(result.error)}`);
      log.info('ui', 'knowledge-remote-unbound', { profile: target.state.profile });
      return knowledgeView(target);
    }
    case 'sync': {
      const result = await syncKnowledge(store);
      target.controls?.knowledgeAutoSync?.noteManual(result);
      if (isGitError(result)) throw new ApiError(400, summarizeSyncError(result.error));
      return { ...(await knowledgeView(target)), outcome: result };
    }
    case 'interval': {
      const minutes = parseInterval(fv.minutes);
      await saveKnowledgeConfig(target.state, (knowledge) => ({ ...knowledge, syncIntervalMinutes: minutes }));
      target.controls?.knowledgeAutoSync?.reschedule();
      return knowledgeView(target);
    }
    default:
      throw new ApiError(400, 'action must be bind|unbind|sync|interval');
  }
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'expected a JSON object body');
  }
  return body as Record<string, unknown>;
}

/** An array of strings, or one comma-separated string. */
function stringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return value.split(',');
  return undefined;
}

function parseInterval(value: unknown): number {
  const minutes = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_INTERVAL_MINUTES) {
    throw new ApiError(400, `间隔要是 0 到 ${MAX_INTERVAL_MINUTES} 之间的整数分钟`);
  }
  return minutes;
}
