import type { ApprovalOutcome, PendingApproval } from '../runtime/approvals';

export interface ApprovalCardContext {
  /** Requester's display name (falls back to a short id). */
  requester: string;
  /** Where the request came from, e.g. `研发群` or `私聊`. */
  where: string;
  botName: string;
  timeoutMinutes: number;
}

const TOOL_LABELS: Record<string, string> = {
  Bash: '运行命令',
  command_execution: '运行命令',
  Edit: '修改文件',
  MultiEdit: '修改文件',
  Write: '写入文件',
  NotebookEdit: '修改笔记本',
  file_change: '修改文件',
  Monitor: '运行监控命令',
};

export function toolLabel(tool: string): string {
  if (TOOL_LABELS[tool]) return TOOL_LABELS[tool]!;
  if (tool.startsWith('mcp__')) return `调用外部工具 ${tool.slice(5).replace('__', ' · ')}`;
  return `调用 ${tool}`;
}

/** Card an approver gets in their private chat. */
export function approverCard(p: PendingApproval, ctx: ApprovalCardContext): object {
  return card('🔐 需要你审批', 'orange', [
    md(`**${escapeMd(ctx.requester)}**（${escapeMd(ctx.where)}）让 ${escapeMd(ctx.botName)}${toolLabel(p.request.tool)}：`),
    md(codeBlock(p.request.summary)),
    note(`${ctx.timeoutMinutes} 分钟内无人处理将自动拒绝。「本轮都允许」只对这一轮对话里的后续操作生效。`),
    {
      tag: 'action',
      actions: [
        button('允许', 'primary', 'approval.allow', p.id),
        button('本轮都允许', 'default', 'approval.allowturn', p.id),
        button('拒绝', 'danger', 'approval.deny', p.id),
      ],
    },
  ]);
}

/** Card the requester sees in their own chat while waiting. */
export function requesterCard(p: PendingApproval, ctx: ApprovalCardContext): object {
  return card('⏳ 等待管理员审批', 'blue', [
    md(`${escapeMd(ctx.botName)}要${toolLabel(p.request.tool)}，这一步需要管理员同意后才会执行：`),
    md(codeBlock(p.request.summary)),
    note(`已通知管理员；${ctx.timeoutMinutes} 分钟内无人处理会自动取消。`),
    { tag: 'action', actions: [button('取消这一步', 'default', 'approval.deny', p.id)] },
  ]);
}

/** Either card once the approval has an outcome. */
export function settledCard(p: PendingApproval, outcome: ApprovalOutcome, ctx: ApprovalCardContext & { by?: string }): object {
  const { title, template, line } = describeOutcome(outcome, ctx);
  return card(title, template, [
    md(`${escapeMd(ctx.requester)}（${escapeMd(ctx.where)}）· ${toolLabel(p.request.tool)}`),
    md(codeBlock(p.request.summary)),
    note(line),
  ]);
}

function describeOutcome(
  outcome: ApprovalOutcome,
  ctx: ApprovalCardContext & { by?: string },
): { title: string; template: string; line: string } {
  const by = ctx.by ? `（${escapeMd(ctx.by)}）` : '';
  switch (outcome.kind) {
    case 'allowed':
      return {
        title: '✅ 已允许',
        template: 'green',
        line: outcome.allowTurn ? `管理员${by}已允许本轮后续操作。` : `管理员${by}已允许，已继续执行。`,
      };
    case 'denied':
      return {
        title: '❌ 已拒绝',
        template: 'red',
        line: outcome.byRequester ? '发起人取消了这一步。' : `管理员${by}拒绝了这一步，没有执行。`,
      };
    case 'timeout':
      return { title: '⏱ 已自动拒绝', template: 'grey', line: `${ctx.timeoutMinutes} 分钟内没有管理员处理，这一步没有执行。` };
    case 'cancelled':
      return { title: '⏹ 已取消', template: 'grey', line: `这一步没有执行：${escapeMd(outcome.reason)}。` };
  }
}

function card(title: string, template: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements,
  };
}

function md(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function note(content: string): object {
  return { tag: 'note', elements: [{ tag: 'lark_md', content }] };
}

function button(text: string, type: string, cmd: string, id: string): object {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type, value: { cmd, arg: id } };
}

function codeBlock(text: string): string {
  const clipped = text.length > 800 ? `${text.slice(0, 800)}…` : text;
  return `\`\`\`\n${clipped.replace(/```/g, "'''")}\n\`\`\``;
}

function escapeMd(text: string): string {
  return text.replace(/([*_`~[\]<>])/g, '\\$1');
}
