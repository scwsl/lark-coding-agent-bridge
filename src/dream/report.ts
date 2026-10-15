import type { DreamSourceRef } from './prompt';
import type { DreamRejection, MemoryAddition, MemoryFlag, SkillProposal } from './proposal';
import { knowledgePath } from './publish';
import type { DreamSessionInput } from './select';

/**
 * PR titles, bodies and commit messages for a batch. They carry the reasons,
 * the source references (conversation id, scope, exchange numbers) and the
 * scope of every change — never chat text or anything the validator treats as
 * a credential.
 */

export interface SessionLegend {
  ref: string;
  agentId: string;
  handle: string;
  scopeId: string;
  from: number;
  to: number;
  restarted: boolean;
}

export function sessionLegend(input: DreamSessionInput): SessionLegend {
  return {
    ref: input.ref,
    agentId: input.record.agentId,
    handle: input.record.handle,
    scopeId: input.record.scopeId,
    from: input.exchanges[0]?.index ?? 0,
    to: input.nextConsumed,
    restarted: input.restarted,
  };
}

const INTRO = (batchId: string, profile: string) =>
  [
    `梦境整理批次 \`${batchId}\` · profile \`${profile}\``,
    '',
    '由 lark-channel-bridge 的梦境整理根据已结束的会话生成，是待审核的草稿：合并后才经现有同步生效。不需要的条目直接在这个 PR 里删改；整批不要就关闭 PR，同样的候选不会再提。撤销已合并的内容用 revert。',
  ].join('\n');

export function knowledgePrTitle(batchId: string, count: number): string {
  return `梦境整理 ${batchId}：记忆与笔记提案（${count} 条）`;
}

export function skillsPrTitle(batchId: string, count: number): string {
  return `梦境整理 ${batchId}：skill 提案（${count} 个）`;
}

export function commitMessage(batchId: string, summary: string): string {
  return `dream: 梦境整理 ${batchId}\n\n${summary}\n`;
}

export function knowledgePrBody(input: {
  batchId: string;
  profile: string;
  written: readonly MemoryAddition[];
  flags: readonly MemoryFlag[];
  duplicates: number;
  rejected: readonly DreamRejection[];
  legend: readonly SessionLegend[];
  related?: string;
}): string {
  const promoted = input.written.filter((item) => item.target === 'profile');
  const local = input.written.filter((item) => item.target !== 'profile');
  const lines: string[] = [INTRO(input.batchId, input.profile), ''];
  if (local.length > 0) {
    lines.push(`## 新增（${local.length}）`, '');
    for (const item of local) {
      lines.push(`- \`${knowledgePath(item)}\`：${item.text}${item.downgraded ? '（原提议提升为全局，依据不是管理员的直接指令，已改为只写入原会话）' : ''}`);
      lines.push(`  - 理由：${item.reason}`, `  - 来源：${sources(item.sources)}`);
    }
    lines.push('');
  }
  if (promoted.length > 0) {
    lines.push(`## ⚠️ 提升为全局约定，待批准（${promoted.length}）`, '');
    lines.push('合并后这个 profile 下的所有会话都会看到这些条目。', '');
    for (const item of promoted) {
      lines.push(`- \`MEMORY.md\`：${item.text}`);
      lines.push(`  - 理由：${item.reason}`, `  - 来源：${sources(item.sources)}（含管理员直接指令）`, `  - 原会话范围：\`${item.scopeId}\``);
    }
    lines.push('');
  }
  if (input.flags.length > 0) {
    lines.push(`## 待人工确认（${input.flags.length}）`, '');
    lines.push('合并 / 冲突 / 疑似过时只做标记，写在对应范围的 `notes/<scope>/dream-review.md` 里，不改原条目。', '');
    for (const flag of input.flags) {
      lines.push(`- ${flagLine(flag)}`);
      lines.push(`  - 理由：${flag.reason}`, `  - 来源：${sources(flag.sources)}`);
    }
    lines.push('');
  }
  lines.push(...tail(input));
  return lines.join('\n');
}

export function skillsPrBody(input: {
  batchId: string;
  profile: string;
  library: string;
  written: readonly SkillProposal[];
  rejected: readonly DreamRejection[];
  legend: readonly SessionLegend[];
  related?: string;
}): string {
  const lines: string[] = [INTRO(input.batchId, input.profile), ''];
  lines.push(`目标库：\`${input.library}\`。整理过程不执行任何脚本；需要实际跑一遍验证的流程，请在合并前人工验证。`, '');
  lines.push(`## skill 提案（${input.written.length}）`, '');
  for (const skill of input.written) {
    lines.push(`- \`${skill.name}\`（${skill.action === 'create' ? '新建' : '更新已有'}）：${skill.description}`);
    lines.push(`  - 理由：${skill.reason}`, `  - 来源：${sources(skill.sources)}`, `  - 会话范围：\`${skill.scopeId}\``);
  }
  lines.push('');
  lines.push(...tail({ ...input, duplicates: 0 }));
  return lines.join('\n');
}

/** Bullet text for the review file: what a merge / conflict / stale flag says. */
export function flagLine(flag: MemoryFlag): string {
  const ids = flag.ids.map((entry) => `\`${entry.id}\`（${entry.where === 'profile' ? '全局' : '本会话'}）「${entry.text}」`).join('、');
  switch (flag.kind) {
    case 'merge':
      return `建议合并 ${ids} → 「${flag.text ?? ''}」`;
    case 'conflict':
      return `冲突 ${ids} ↔ 新说法「${flag.text ?? ''}」`;
    case 'stale':
      return `疑似过时 ${ids}`;
  }
}

function tail(input: {
  duplicates: number;
  rejected: readonly DreamRejection[];
  legend: readonly SessionLegend[];
  related?: string;
}): string[] {
  const lines: string[] = [];
  if (input.rejected.length > 0 || input.duplicates > 0) {
    lines.push('## 未采纳', '');
    if (input.duplicates > 0) lines.push(`- ${input.duplicates} 条与最新基线里已有的内容重复，未写入。`);
    const reasons = new Map<string, number>();
    for (const item of input.rejected) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
    for (const [reason, count] of reasons) lines.push(`- ${reason} × ${count}`);
    lines.push('');
  }
  lines.push('## 来源', '');
  for (const item of input.legend) {
    lines.push(
      `- ${item.ref}：${item.agentId} 会话 \`${item.handle}\`，范围 \`${item.scopeId}\`，第 ${item.from}–${item.to} 轮${item.restarted ? '（转录与上次游标不一致，已从头重读）' : ''}`,
    );
  }
  if (input.related) lines.push('', `同批次的另一个 PR：${input.related}`);
  return lines;
}

function sources(refs: readonly DreamSourceRef[]): string {
  return refs.map((ref) => ref.ref).join('、');
}
