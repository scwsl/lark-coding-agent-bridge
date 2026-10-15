import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { isSafeSkillLibraryPath, type SkillLibraryConfig } from '../config/profile-schema';
import { git, isSafeRef, runCapture, type GitResult } from '../git/exec';
import { describeGhFailure, findPullRequestForBranch } from '../git/pr';
import { maskUrlCredentials } from '../knowledge/libraries';
import { defaultMemoryHeader, parseMemoryEntries, parseSkillHeader, sanitizeScopeId } from '../knowledge/store';
import { isPlausibleGitUrl } from '../knowledge/sync';
import { normalizeText, type MemoryAddition, type SkillProposal } from './proposal';

/**
 * The deterministic publishing half of 梦境整理: a fresh checkout of the target
 * repository's latest remote state, files written from validated proposals
 * only, one commit on `dream/<batch>`, a push of that new branch and a Draft
 * PR. Never a force push, never the default branch, never a merge.
 *
 * Every write stays inside a fixed allow-list of paths derived from scope ids
 * and slugs that already passed validation; the agent never names a path.
 */

export interface RepoSpec {
  /** `knowledge` or `skills:<library>`. */
  repo: string;
  label: string;
  url: string;
  /** Skill libraries only: the branch the library follows. */
  ref?: string;
}

const CLONE_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 120_000;
const GH_TIMEOUT_MS = 60_000;

/** `MEMORY.md`, `chats/<scope>.md`, `notes/<scope>/<topic>.md` — nothing else in the knowledge repo. */
const KNOWLEDGE_PATH_RE = /^(?:MEMORY\.md|chats\/[\w.-]+\.md|notes\/[\w.-]+\/[a-z0-9][a-z0-9-]*\.md)$/;

export function dreamBranch(batchId: string): string {
  return `dream/${batchId}`;
}

/**
 * Clone the target's latest remote state into `dir` (replacing whatever was
 * there) and start the batch branch. A library pinned to a tag or a commit is
 * not a branch anyone can open a PR against, and is refused.
 */
export async function prepareCheckout(
  spec: RepoSpec,
  dir: string,
  branch: string,
): Promise<{ base: string } | { error: string }> {
  if (!isPlausibleGitUrl(spec.url)) return { error: '仓库地址不合法' };
  if (spec.ref !== undefined && (!isSafeRef(spec.ref) || /^[0-9a-f]{7,40}$/i.test(spec.ref))) {
    return { error: `配置固定在提交 ${spec.ref} 上，不能作为写入目标` };
  }
  if (!isSafeRef(branch)) return { error: '分支名不合法' };
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
      '50',
      ...(spec.ref ? ['--branch', spec.ref] : []),
      '--',
      spec.url,
      dir,
    ],
    { timeoutMs: CLONE_TIMEOUT_MS },
  );
  if (!cloned.ok) return { error: `拉取最新基线失败：${gitFailure(cloned)}` };
  const head = await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const base = head.ok ? head.stdout.trim() : '';
  if (!base) return { error: `${spec.ref ?? '默认分支'} 不是分支（tag 或固定提交），不能作为写入目标` };
  const created = await git(dir, ['checkout', '-q', '-b', branch]);
  if (!created.ok) return { error: `创建分支失败：${gitFailure(created)}` };
  return { base };
}

/**
 * Append each addition to its memory / note file in the checkout. An entry
 * whose text the latest baseline already holds is reported as a duplicate and
 * not written — the PR never repeats what a human already merged or edited in.
 */
export async function writeKnowledgeDraft(
  dir: string,
  additions: readonly MemoryAddition[],
): Promise<{ files: string[]; written: MemoryAddition[]; duplicates: MemoryAddition[]; errors: string[] }> {
  const files = new Set<string>();
  const written: MemoryAddition[] = [];
  const duplicates: MemoryAddition[] = [];
  const errors: string[] = [];
  for (const addition of additions) {
    const rel = knowledgePath(addition);
    if (!KNOWLEDGE_PATH_RE.test(rel)) {
      errors.push(`路径越界：${rel}`);
      continue;
    }
    const file = join(dir, ...rel.split('/'));
    if (!(await isInsideReal(dir, dirname(file))) || (await isSymlink(file))) {
      errors.push(`路径越界：${rel}`);
      continue;
    }
    const current = await readIfExists(file);
    const entries = current ? parseMemoryEntries(current) : [];
    const key = normalizeText(addition.text);
    if (entries.some((entry) => normalizeText(entry.text) === key)) {
      duplicates.push(addition);
      continue;
    }
    const taken = new Set(entries.map((entry) => entry.id));
    let id = randomBytes(3).toString('hex');
    while (taken.has(id)) id = randomBytes(3).toString('hex');
    const header =
      addition.target === 'note'
        ? `# ${addition.note}\n\n梦境整理归纳的项目事实，范围 \`${addition.scopeId}\`。\n`
        : defaultMemoryHeader(
            addition.target === 'profile' ? { kind: 'profile' } : { kind: 'chat', scopeId: addition.scopeId },
          );
    const body = `${(current ?? header).replace(/\s*$/, '')}\n- [${id}] ${addition.text}\n`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body, 'utf8');
    files.add(rel);
    written.push(addition);
  }
  return { files: [...files], written, duplicates, errors };
}

export function knowledgePath(addition: Pick<MemoryAddition, 'target' | 'scopeId' | 'note'>): string {
  if (addition.target === 'profile') return 'MEMORY.md';
  const scope = sanitizeScopeId(addition.scopeId);
  return addition.target === 'chat' ? `chats/${scope}.md` : `notes/${scope}/${addition.note ?? ''}.md`;
}

/**
 * Write each skill proposal into the library checkout, under the library's
 * configured `path` and within its include / exclude filter — a skill the
 * library's own configuration would not load is not proposed to it.
 */
export async function writeSkillDraft(
  dir: string,
  library: SkillLibraryConfig,
  proposals: readonly SkillProposal[],
): Promise<{ files: string[]; written: SkillProposal[]; rejected: Array<{ proposal: SkillProposal; reason: string }> }> {
  const files: string[] = [];
  const written: SkillProposal[] = [];
  const rejected: Array<{ proposal: SkillProposal; reason: string }> = [];
  const rejectAll = (reason: string) => ({
    files,
    written,
    rejected: proposals.map((proposal) => ({ proposal, reason })),
  });
  if (library.path !== undefined && !isSafeSkillLibraryPath(library.path)) return rejectAll('库的 path 配置不合法');
  const baseRel = library.path ?? ((await isDirectory(join(dir, 'skills'))) ? 'skills' : '');
  const base = baseRel ? join(dir, ...baseRel.split(/[\\/]+/)) : dir;
  if (baseRel && (await isDirectory(base)) && !(await isInsideReal(dir, base))) return rejectAll('库的 path 指向仓库外');
  if (await isFile(join(base, 'SKILL.md'))) return rejectAll('这个库本身就是单个 skill，不能往里加别的 skill');

  for (const proposal of proposals) {
    let dirName = proposal.name;
    if (proposal.action === 'update') {
      const found = await findSkillDir(base, proposal.name);
      if (!found) {
        rejected.push({ proposal, reason: '最新基线里找不到这个 skill' });
        continue;
      }
      dirName = found;
    } else if (await exists(join(base, dirName))) {
      rejected.push({ proposal, reason: '最新基线里已有同名目录' });
      continue;
    }
    if (!passesFilter(library, dirName, proposal.name)) {
      rejected.push({ proposal, reason: '不在这个库配置的 include / exclude 范围内' });
      continue;
    }
    const skillDir = join(base, dirName);
    const file = join(skillDir, 'SKILL.md');
    if ((await isSymlink(skillDir)) || (await isSymlink(file))) {
      rejected.push({ proposal, reason: '目标是符号链接' });
      continue;
    }
    if (!(await isInsideReal(dir, skillDir))) {
      rejected.push({ proposal, reason: '路径越界' });
      continue;
    }
    await mkdir(skillDir, { recursive: true });
    await writeFile(file, proposal.body, 'utf8');
    files.push([baseRel, dirName, 'SKILL.md'].filter(Boolean).join('/'));
    written.push(proposal);
  }
  return { files, written, rejected };
}

/** Commit exactly `files`, with the repository's hooks switched off. */
export async function commitDraft(
  dir: string,
  files: readonly string[],
  message: string,
  hooksDir: string,
): Promise<{ commit: string } | { error: string }> {
  await mkdir(hooksDir, { recursive: true, mode: 0o700 });
  const added = await git(dir, ['add', '--', ...files]);
  if (!added.ok) return { error: `git add 失败：${gitFailure(added)}` };
  // The host's own git identity when it has one; a machine without any still commits.
  const named = (await git(dir, ['config', 'user.name'])).ok && (await git(dir, ['config', 'user.email'])).ok;
  const identity = named ? [] : ['-c', 'user.name=lark-channel-bridge', '-c', 'user.email=bridge@localhost'];
  const committed = await git(
    dir,
    [...identity, '-c', `core.hooksPath=${hooksDir}`, 'commit', '-q', '--no-verify', '-m', message],
    { timeoutMs: 30_000 },
  );
  if (!committed.ok) return { error: `git commit 失败：${gitFailure(committed)}` };
  const head = await git(dir, ['rev-parse', 'HEAD']);
  return head.ok ? { commit: head.stdout.trim() } : { error: '读不到提交号' };
}

/**
 * Whether the PR side can work at all before anything is pushed: `gh` is
 * there, logged in, recognises the remote, and the account may write to it.
 * Refusing here keeps the draft as a local commit instead of leaving an
 * orphan branch on the remote.
 */
export async function checkPullRequestAccess(dir: string): Promise<{ ok: true } | { error: string }> {
  const result = await runCapture('gh', dir, ['repo', 'view', '--json', 'viewerPermission'], { timeoutMs: GH_TIMEOUT_MS });
  if (!result.ok) return { error: `开不了 PR：${describeGhFailure(result.code, result.stderr.trim())}` };
  let permission = '';
  try {
    permission = String((JSON.parse(result.stdout) as { viewerPermission?: unknown }).viewerPermission ?? '');
  } catch {
    return { error: 'gh 返回的仓库信息无法解析' };
  }
  if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(permission)) {
    return { error: `当前 gh 账号对这个仓库的权限是 ${permission || '未知'}，不能推分支、开 PR（只读或第三方库不作为写入目标）` };
  }
  return { ok: true };
}

/** Push the batch branch. A branch already on the remote at our commit counts as pushed. */
export async function pushDraft(dir: string, branch: string, hooksDir: string): Promise<{ ok: true } | { error: string }> {
  await mkdir(hooksDir, { recursive: true, mode: 0o700 });
  const pushed = await git(
    dir,
    ['-c', `core.hooksPath=${hooksDir}`, 'push', '-q', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`],
    { timeoutMs: PUSH_TIMEOUT_MS },
  );
  if (pushed.ok) return { ok: true };
  const head = await git(dir, ['rev-parse', 'HEAD']);
  const remote = await git(dir, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { timeoutMs: PUSH_TIMEOUT_MS });
  if (head.ok && remote.ok && remote.stdout.split(/\s+/)[0] === head.stdout.trim()) return { ok: true };
  const reason = gitFailure(pushed);
  if (/permission|denied|403|not allowed|protected/i.test(reason)) return { error: `没有推送权限：${reason}` };
  return { error: `推送失败：${reason}` };
}

/** Open the Draft PR, or return the one already open for the branch. */
export async function openDraftPullRequest(
  dir: string,
  input: { branch: string; base: string; title: string; body: string },
): Promise<{ url: string; number?: number } | { error: string }> {
  const existing = await findPullRequestForBranch(dir, input.branch);
  if (existing?.url) return { url: existing.url, number: existing.number };
  const bodyFile = `${dir}.pr-body.md`;
  await writeFile(bodyFile, input.body, { encoding: 'utf8', mode: 0o600 });
  try {
    const created = await runCapture(
      'gh',
      dir,
      ['pr', 'create', '--draft', '--base', input.base, '--head', input.branch, '--title', input.title, '--body-file', bodyFile],
      { timeoutMs: GH_TIMEOUT_MS },
    );
    const url = created.stdout
      .split('\n')
      .map((line) => line.trim())
      .reverse()
      .find((line) => /^https?:\/\/\S+\/pull\/\d+$/.test(line));
    if (created.ok && url) return { url, number: Number(/\/pull\/(\d+)$/.exec(url)?.[1]) };
    const again = await findPullRequestForBranch(dir, input.branch);
    if (again?.url) return { url: again.url, number: again.number };
    return { error: `创建 PR 失败：${describeGhFailure(created.code, created.stderr.trim())}` };
  } finally {
    await rm(bodyFile, { force: true });
  }
}

/** A PR's review state in words, or undefined when `gh` cannot say. */
export async function pullRequestState(cwd: string, url: string): Promise<string | undefined> {
  const result = await runCapture('gh', cwd, ['pr', 'view', url, '--json', 'state,isDraft,reviewDecision'], {
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (!result.ok) return undefined;
  try {
    const view = JSON.parse(result.stdout) as { state?: string; isDraft?: boolean; reviewDecision?: string };
    if (view.state === 'MERGED') return '已合并';
    if (view.state === 'CLOSED') return '已关闭';
    if (view.reviewDecision === 'APPROVED') return '已批准，待合并';
    if (view.reviewDecision === 'CHANGES_REQUESTED') return '要求修改';
    return view.isDraft ? '待审核（草稿）' : '待审核';
  } catch {
    return undefined;
  }
}

/**
 * `gh -R` form of a remote: `owner/repo` on github.com, `host/owner/repo`
 * elsewhere; undefined for a local path or anything unrecognised.
 */
export function ghRepoSlug(url: string): string | undefined {
  const trimmed = url.trim();
  let host: string;
  let path: string;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes('://')) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const parsed = new URL(trimmed);
      if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol) || !parsed.hostname) return undefined;
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  const parts = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2 || !parts.every((part) => /^[\w.-]+$/.test(part))) return undefined;
  const slug = parts.join('/');
  return host.toLowerCase() === 'github.com' ? slug : `${host.toLowerCase()}/${slug}`;
}

/**
 * Open `dream/*` PRs on the repository, whichever bot opened them. Undefined
 * when `gh` cannot list them (no slug, not logged in…).
 */
export async function countOpenDreamPullRequests(cwd: string, url: string): Promise<number | undefined> {
  const slug = ghRepoSlug(url);
  if (!slug) return undefined;
  const result = await runCapture(
    'gh',
    cwd,
    ['pr', 'list', '-R', slug, '--state', 'open', '--limit', '100', '--json', 'number,headRefName'],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (!result.ok) return undefined;
  try {
    const list = JSON.parse(result.stdout) as Array<{ headRefName?: unknown }>;
    if (!Array.isArray(list)) return undefined;
    return list.filter((pr) => typeof pr.headRefName === 'string' && pr.headRefName.startsWith('dream/')).length;
  } catch {
    return undefined;
  }
}

/** A PR's state with what a revert needs, or an error in words. */
export async function pullRequestMergeInfo(
  cwd: string,
  url: string,
): Promise<{ state: string; mergeCommit?: string; base?: string } | { error: string }> {
  const result = await runCapture('gh', cwd, ['pr', 'view', url, '--json', 'state,mergeCommit,baseRefName'], {
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (!result.ok) return { error: describeGhFailure(result.code, result.stderr.trim()) };
  try {
    const view = JSON.parse(result.stdout) as { state?: unknown; mergeCommit?: { oid?: unknown } | null; baseRefName?: unknown };
    const oid = view.mergeCommit?.oid;
    return {
      state: String(view.state ?? ''),
      ...(typeof oid === 'string' && /^[0-9a-f]{7,64}$/i.test(oid) ? { mergeCommit: oid } : {}),
      ...(typeof view.baseRefName === 'string' && isSafeRef(view.baseRefName) ? { base: view.baseRefName } : {}),
    };
  } catch {
    return { error: 'gh 返回的 PR 信息无法解析' };
  }
}

/**
 * Revert one merged batch commit on the checkout's branch: a merge commit
 * against its first parent, a squashed / rebased one as it is. A conflict —
 * someone edited the same lines since — aborts and is reported, never forced.
 */
export async function revertDraft(
  dir: string,
  commit: string,
  message: string,
  hooksDir: string,
): Promise<{ commit: string } | { error: string }> {
  await mkdir(hooksDir, { recursive: true, mode: 0o700 });
  // Usually already inside the fresh clone's history; fetched by id when not.
  const present = (await git(dir, ['cat-file', '-e', `${commit}^{commit}`])).ok;
  if (!present) {
    const fetched = await git(dir, ['fetch', '-q', '--depth', '2', 'origin', commit], { timeoutMs: CLONE_TIMEOUT_MS });
    if (!fetched.ok) return { error: `取不到合并提交 ${commit.slice(0, 8)}：${gitFailure(fetched)}` };
  }
  const parents = await git(dir, ['rev-list', '--parents', '-n', '1', commit]);
  if (!parents.ok) return { error: `读不到合并提交：${gitFailure(parents)}` };
  const isMerge = parents.stdout.trim().split(/\s+/).length > 2;
  const named = (await git(dir, ['config', 'user.name'])).ok && (await git(dir, ['config', 'user.email'])).ok;
  const identity = named ? [] : ['-c', 'user.name=lark-channel-bridge', '-c', 'user.email=bridge@localhost'];
  const reverted = await git(
    dir,
    [...identity, '-c', `core.hooksPath=${hooksDir}`, 'revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), commit],
    { timeoutMs: 30_000 },
  );
  if (!reverted.ok) {
    await git(dir, ['revert', '--abort']);
    return { error: `撤销有冲突（合并之后有人改过同样的内容），请在仓库里手动处理：${gitFailure(reverted)}` };
  }
  const amended = await git(
    dir,
    [...identity, '-c', `core.hooksPath=${hooksDir}`, 'commit', '-q', '--amend', '--no-verify', '-m', message],
    { timeoutMs: 30_000 },
  );
  if (!amended.ok) return { error: `git commit 失败：${gitFailure(amended)}` };
  const head = await git(dir, ['rev-parse', 'HEAD']);
  return head.ok ? { commit: head.stdout.trim() } : { error: '读不到提交号' };
}

/** The batch commit of a kept checkout, as stat + patch. */
export async function checkoutDiff(dir: string, maxBytes = 200_000): Promise<string | undefined> {
  const shown = await git(dir, ['show', '--format=%s', '--stat', '--patch', 'HEAD'], { maxBytes });
  return shown.ok ? shown.stdout : undefined;
}

/** A PR's diff through `gh`, for a batch whose checkout is gone. */
export async function pullRequestDiff(cwd: string, url: string, maxBytes = 200_000): Promise<string | { error: string }> {
  const result = await runCapture('gh', cwd, ['pr', 'diff', url], { timeoutMs: GH_TIMEOUT_MS, maxBytes });
  return result.ok ? result.stdout : { error: describeGhFailure(result.code, result.stderr.trim()) };
}

function gitFailure(result: GitResult): string {
  if (result.timedOut) return '超时';
  const lines = result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.find((item) => /^(fatal|error|remote):/.test(item)) ?? lines.at(-1) ?? `退出码 ${result.code}`;
  return maskUrlCredentials(line);
}

async function findSkillDir(base: string, name: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const raw = await readIfExists(join(base, entry.name, 'SKILL.md'));
    if (raw !== undefined && parseSkillHeader(entry.name, raw).name === name) return entry.name;
  }
  return undefined;
}

function passesFilter(library: SkillLibraryConfig, dirName: string, name: string): boolean {
  const matches = (list: string[] | undefined) => Boolean(list?.some((item) => item === dirName || item === name));
  if (library.include && !matches(library.include)) return false;
  return !matches(library.exclude);
}

/** `path` (resolved through symlinks) is `root` itself or inside it. */
async function isInsideReal(root: string, path: string): Promise<boolean> {
  try {
    const rel = relative(await realpath(root), await realpath(path));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    // Not there yet: check the nearest existing parent instead.
    const parent = dirname(path);
    return parent !== path && isInsideReal(root, parent);
  }
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  return lstat(path).then((info) => info.isSymbolicLink(), () => false);
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function isDirectory(path: string): Promise<boolean> {
  return lstat(path).then((info) => info.isDirectory(), () => false);
}

async function isFile(path: string): Promise<boolean> {
  return lstat(path).then((info) => info.isFile(), () => false);
}
