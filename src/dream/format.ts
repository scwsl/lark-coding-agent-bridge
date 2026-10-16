import { formatChars } from './schedule';
import type { DreamRevertResult, DreamStatusView } from './service';
import type { DreamRun, DreamTarget } from './state';

/** Chat text for `/dream`: status, a finished run, the PR list. Counts and links only — never draft content. */

const STATUS_LABEL: Record<DreamRun['status'], string> = {
  queued: '⏳ 排队中',
  running: '📚 整理中',
  deferred: '⏸ 已延后',
  succeeded: '✅ 完成',
  failed: '❌ 失败',
  cancelled: '⏹ 已取消',
};

const PHASE_LABEL: Record<DreamTarget['phase'], string> = {
  skipped: '未提交',
  failed: '失败',
  committed: '草稿已生成（未推送）',
  pushed: '已推送（PR 未开）',
  'pr-created': 'Draft PR 已开',
};

export function formatDreamStatus(view: DreamStatusView): string {
  const { settings } = view;
  const lines = [
    `**📚 课堂精练**：${view.enabled ? '已开启' : '未开启（`/config` 里打开）'}`,
    '',
    `- 整理用 agent：${view.agent}（只读运行，独立会话）`,
    `- 知识库：${view.targets.knowledge.url ? `\`${view.targets.knowledge.url}\`` : `⚠️ ${view.targets.knowledge.problem}`}`,
    `- skill 库：${view.targets.skills.library ? `\`${view.targets.skills.library}\`` : `⚠️ ${view.targets.skills.problem}`}`,
    `- 每轮上限：${settings.maxSessions} 个会话、${settings.maxInputChars} 字符、${settings.maxRunMinutes} 分钟；会话空闲 ${settings.minIdleMinutes} 分钟后才读${settings.scopes ? `；只读 ${settings.scopes.length} 个指定会话` : ''}`,
    `- 已登记会话：${view.trackedSessions} 个`,
    `- 已开 Draft PR：${view.openedPrs} 个（\`/dream prs\` 看审核状态）${view.pendingDrafts > 0 ? `；待重试草稿 ${view.pendingDrafts} 个` : ''}`,
  ];
  if (view.lastSucceededAt) lines.push(`- 上次完成：${formatTime(view.lastSucceededAt)}`);
  if (view.running) lines.push(`- 进行中：批次 \`${view.running.id}\`（${STATUS_LABEL[view.running.status]}，${formatTime(view.running.startedAt)} 开始）`);
  lines.push(...autoLines(view));
  if (view.runs.length > 0) {
    lines.push('', '**最近几轮**');
    for (const run of view.runs) lines.push(`- ${runLine(run)}`);
  }
  lines.push(
    '',
    '`/dream run` 立即整理 · `/dream cancel` 取消 · `/dream prs` PR 列表 · `/dream diff [批次]` 查看差异 · `/dream revert <批次>` 撤销',
  );
  return lines.join('\n');
}

export function formatDreamRun(run: DreamRun): string {
  const lines = [`**📚 课堂精练 ${STATUS_LABEL[run.status]}** · 批次 \`${run.id}\``];
  if (run.note) lines.push('', run.note);
  for (const target of run.targets) lines.push(`- ${targetLine(target)}`);
  if (run.deferred.length > 0) {
    const reasons = new Map<string, number>();
    for (const item of run.deferred) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
    lines.push(`- 延后：${[...reasons].map(([reason, count]) => `${reason} × ${count}`).join('；')}`);
  }
  return lines.join('\n');
}

export function formatDreamPrs(
  entries: ReadonlyArray<{ run: DreamRun; target: DreamTarget; state?: string }>,
): string {
  if (entries.length === 0) return '还没有课堂精练开出的 PR。';
  const lines = ['**📚 课堂精练的 PR**', ''];
  for (const { run, target, state } of entries) {
    lines.push(`- \`${run.id}\` ${target.label}：[#${target.prNumber ?? '?'}](${target.prUrl})${state ? ` · ${state}` : ''}`);
  }
  return lines.join('\n');
}

export function formatDreamRevert(result: DreamRevertResult): string {
  const lines = [`**📚 撤销批次 \`${result.id}\`**`, ''];
  for (const item of result.results) {
    lines.push(`- ${item.label}：${item.note}${item.prUrl ? `（[撤销 PR](${item.prUrl})）` : ''}`);
  }
  lines.push('', '撤销同样以 Draft PR 提交，审核合并后才生效。');
  return lines.join('\n');
}

/** 自动整理: on or off, the gates in one line, and the last check's outcome. */
function autoLines(view: DreamStatusView): string[] {
  const { auto } = view;
  if (!auto.enabled) return [`- 自动整理：未开启${view.enabled ? '（`/config` 里打开「自动整理」）' : ''}`];
  const s = auto.settings;
  const lines = [
    `- 自动整理：已开启。${s.window.text}（${s.timezone}）内、距上次 ≥ ${s.minIntervalDays} 天、新内容 ≥ ${s.minScopes} 个会话范围或 ${formatChars(s.minInputChars)} 字${s.maxIntervalDays > 0 ? `（满 ${s.maxIntervalDays} 天有新内容即可）` : ''}、待审 PR 少于 ${s.maxOpenPrs} 个、额度低于 ${s.maxQuotaPercent}% 时才跑`,
  ];
  const check = auto.ledger.lastCheck;
  if (check) {
    lines.push(
      check.started
        ? `- 上次检查（${formatTime(check.at)}）：开始了批次 \`${check.started}\``
        : `- 上次检查（${formatTime(check.at)}）：没跑——${check.reason ?? check.block ?? '未知'}`,
    );
  }
  if (auto.ledger.consecutiveFailures > 0) lines.push(`- 自动整理连续失败：${auto.ledger.consecutiveFailures} 次`);
  return lines;
}

function runLine(run: DreamRun): string {
  const parts = [`\`${run.id}\` ${run.trigger === 'auto' ? '（自动）' : ''}${STATUS_LABEL[run.status]}`];
  if (run.endedAt) parts.push(formatTime(run.endedAt));
  if (run.note) parts.push(run.note);
  const prs = run.targets.filter((target) => target.prUrl);
  if (prs.length > 0) parts.push(prs.map((target) => `[${target.label} #${target.prNumber ?? '?'}](${target.prUrl})`).join('、'));
  return parts.join(' · ');
}

function targetLine(target: DreamTarget): string {
  const link = target.prUrl ? `：[#${target.prNumber ?? '?'}](${target.prUrl})` : '';
  const items = target.items > 0 ? `，${target.items} 项` : '';
  return `${target.label}：${PHASE_LABEL[target.phase]}${items}${link}${target.error ? `（${target.error}）` : ''}`;
}

function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
