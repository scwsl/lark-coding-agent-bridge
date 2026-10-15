import { isSafeRef, runCapture } from './exec';

/**
 * Pull-request lookup rides on the `gh` CLI rather than a token of our own.
 *
 * The bridge already runs as the person at the keyboard — their `gh` login is
 * exactly the identity that should be reading their PRs, and asking them to
 * paste a GitHub token into a chat bot would be strictly worse. When `gh` is
 * missing or logged out, every path here degrades to a clear message instead of
 * a stack trace.
 */

export interface CheckRollup {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /** Names of the checks that are failing, for the card. */
  failing: string[];
}

export interface PullRequestView {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision?: string;
  mergeable?: string;
  checks: CheckRollup;
}

export type PrLookup = { kind: 'current' } | { kind: 'number'; number: number };

export function parsePrArg(input: string): PrLookup | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'current' };
  const fromUrl = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(trimmed);
  if (fromUrl) return { kind: 'number', number: Number(fromUrl[1]) };
  const bare = /^#?(\d+)$/.exec(trimmed);
  if (bare) return { kind: 'number', number: Number(bare[1]) };
  return { error: `看不懂的 PR：${trimmed}（给个编号或 PR 链接）` };
}

const PR_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'isDraft',
  'headRefName',
  'baseRefName',
  'author',
  'additions',
  'deletions',
  'changedFiles',
  'reviewDecision',
  'mergeable',
  'statusCheckRollup',
].join(',');

export async function readPullRequest(
  cwd: string,
  lookup: PrLookup,
): Promise<PullRequestView | { error: string }> {
  const args = ['pr', 'view'];
  if (lookup.kind === 'number') args.push(String(lookup.number));
  args.push('--json', PR_FIELDS);

  const result = await runCapture('gh', cwd, args, { timeoutMs: 20_000 });
  if (!result.ok) {
    return { error: describeGhFailure(result.code, result.stderr) };
  }
  try {
    return toView(JSON.parse(result.stdout) as Record<string, unknown>);
  } catch {
    return { error: 'gh 返回的内容无法解析' };
  }
}

/** The PR (if any) for a branch — used to enrich `/status` and after a push. */
export async function findPullRequestForBranch(
  cwd: string,
  branch: string,
): Promise<PullRequestView | undefined> {
  if (!isSafeRef(branch)) return undefined;
  const result = await runCapture(
    'gh',
    cwd,
    ['pr', 'list', '--head', branch, '--state', 'open', '--limit', '1', '--json', PR_FIELDS],
    { timeoutMs: 20_000 },
  );
  if (!result.ok) return undefined;
  try {
    const list = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    return list[0] ? toView(list[0]) : undefined;
  } catch {
    return undefined;
  }
}

function toView(raw: Record<string, unknown>): PullRequestView {
  const author = raw.author as { login?: string } | undefined;
  return {
    number: Number(raw.number ?? 0),
    title: String(raw.title ?? ''),
    url: String(raw.url ?? ''),
    state: String(raw.state ?? ''),
    isDraft: Boolean(raw.isDraft),
    headRefName: String(raw.headRefName ?? ''),
    baseRefName: String(raw.baseRefName ?? ''),
    ...(author?.login ? { author: author.login } : {}),
    additions: Number(raw.additions ?? 0),
    deletions: Number(raw.deletions ?? 0),
    changedFiles: Number(raw.changedFiles ?? 0),
    ...(raw.reviewDecision ? { reviewDecision: String(raw.reviewDecision) } : {}),
    ...(raw.mergeable ? { mergeable: String(raw.mergeable) } : {}),
    checks: rollupChecks(raw.statusCheckRollup),
  };
}

/**
 * Collapse `statusCheckRollup` into pass/fail/pending counts.
 *
 * The array mixes two shapes: GitHub Actions runs (`CheckRun`, with `status`
 * and `conclusion`) and external statuses (`StatusContext`, with `state`).
 */
export function rollupChecks(raw: unknown): CheckRollup {
  const rollup: CheckRollup = { total: 0, passed: 0, failed: 0, pending: 0, failing: [] };
  if (!Array.isArray(raw)) return rollup;

  for (const entry of raw as Array<Record<string, unknown>>) {
    rollup.total++;
    const name = String(entry.name ?? entry.context ?? 'check');
    const status = String(entry.status ?? '').toUpperCase();
    const outcome = String(entry.conclusion ?? entry.state ?? '').toUpperCase();

    if (status && status !== 'COMPLETED' && !outcome) {
      rollup.pending++;
      continue;
    }
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(outcome)) {
      rollup.passed++;
      continue;
    }
    if (['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'EXPECTED', ''].includes(outcome)) {
      rollup.pending++;
      continue;
    }
    rollup.failed++;
    if (rollup.failing.length < 5) rollup.failing.push(name);
  }
  return rollup;
}

export function checksLabel(checks: CheckRollup): string {
  if (checks.total === 0) return '无 CI';
  if (checks.failed > 0) return `❌ ${checks.failed} 失败 / ${checks.total}`;
  if (checks.pending > 0) return `🟡 ${checks.pending} 进行中 / ${checks.total}`;
  return `✅ ${checks.passed}/${checks.total} 通过`;
}

export function reviewLabel(decision: string | undefined): string {
  switch (decision) {
    case 'APPROVED':
      return '✅ 已批准';
    case 'CHANGES_REQUESTED':
      return '🔁 要求修改';
    case 'REVIEW_REQUIRED':
      return '⏳ 待评审';
    default:
      return '—';
  }
}

export function describeGhFailure(code: number | null, stderr: string): string {
  if (code === null) {
    return '本机没有安装 `gh`（GitHub CLI），或者它没能启动。装好后再试：https://cli.github.com';
  }
  if (/not logged|authentication|gh auth login/i.test(stderr)) {
    return '`gh` 还没登录。在本机终端跑一次 `gh auth login` 再试。';
  }
  if (/no pull requests found|no default remote|not a git repository/i.test(stderr)) {
    return '当前分支没有关联的 PR（或这个目录不是 GitHub 仓库）。';
  }
  return stderr || 'gh 执行失败';
}
