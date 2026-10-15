import { describe, expect, it } from 'vitest';
import { approverCard, requesterCard, settledCard, toolLabel } from '../../../src/card/approval-cards';
import type { PendingApproval } from '../../../src/runtime/approvals';

const pending: PendingApproval = {
  id: 'ap-1',
  request: { tool: 'Bash', summary: 'git push origin main' },
  gate: { actor: { id: 'ou_c', name: 'Colleague' }, source: 'im', scopeId: 's', chatId: 'oc_1', where: '研发群', agent: 'claude' },
  createdAt: 0,
  notices: [],
};
const ctx = { requester: 'Colleague', where: '研发群', botName: 'CC', timeoutMinutes: 5 };
const buttonsOf = (card: object) => JSON.stringify(card).match(/"cmd":"approval\.[a-z]+"/g) ?? [];

describe('approval cards', () => {
  it('gives approvers allow / allow-turn / deny for this approval, with who and what', () => {
    const card = approverCard(pending, ctx);
    const text = JSON.stringify(card);
    expect(text).toContain('Colleague');
    expect(text).toContain('研发群');
    expect(text).toContain('git push origin main');
    expect(text).toContain('5 分钟');
    expect(buttonsOf(card)).toEqual(['"cmd":"approval.allow"', '"cmd":"approval.allowturn"', '"cmd":"approval.deny"']);
    expect(text).toContain('"arg":"ap-1"');
  });

  it('gives the requester only a way to cancel, and drops buttons once settled', () => {
    expect(buttonsOf(requesterCard(pending, ctx))).toEqual(['"cmd":"approval.deny"']);
    const done = settledCard(pending, { kind: 'denied', by: 'ou_boss', byRequester: false }, ctx);
    expect(buttonsOf(done)).toEqual([]);
    expect(JSON.stringify(done)).toContain('没有执行');
    expect(JSON.stringify(settledCard(pending, { kind: 'timeout' }, ctx))).toContain('5 分钟内没有管理员处理');
  });

  it('names steps in plain words', () => {
    expect(toolLabel('Bash')).toBe('运行命令');
    expect(toolLabel('file_change')).toBe('修改文件');
    expect(toolLabel('mcp__jira__create_issue')).toBe('调用外部工具 jira · create_issue');
  });
});
