import { describe, expect, it } from 'vitest';
import { configFormCard, configSavedCard, type ConfigFormOpts } from '../../../src/card/config-card';

const base: ConfigFormOpts = {
  agentKind: 'claude',
  mode: 'personal',
  model: 'default',
  effort: undefined,
  messageReply: 'markdown',
  showToolCalls: false,
  cotMessages: 'off',
  maxConcurrentRuns: 1,
  runIdleTimeoutMinutes: 0,
  requireMentionInGroup: false,
  larkCliIdentity: 'bot-only',
  approvalsEnabled: false,
  allowedUsers: [],
  allowedChats: [],
  admins: [],
  knownChats: [],
};

describe('configFormCard approvals switch', () => {
  it('offers the non-admin approvals switch, set to the current state', () => {
    expect(findNamedSelect(configFormCard(base), 'approvals_enabled')?.initial_option).toBe('off');
    expect(findNamedSelect(configFormCard({ ...base, approvalsEnabled: true }), 'approvals_enabled')?.initial_option).toBe('on');
  });

  it('reports the switch on the saved card', () => {
    expect(JSON.stringify(configSavedCard({ ...base, approvalsEnabled: true }))).toContain('非管理员审批');
  });
});

describe('configFormCard console URL', () => {
  it('shows the web console URL when one is running', () => {
    const url = 'http://127.0.0.1:53219/?token=abc123';
    const card = configFormCard({ ...base, consoleUrl: url });
    expect(JSON.stringify(card)).toContain(url);
    expect(JSON.stringify(card)).toContain('Web 控制台');
  });

  it('omits the console section when no console is running', () => {
    const card = configFormCard(base);
    expect(JSON.stringify(card)).not.toContain('Web 控制台');
  });
});

type Select = { tag: string; name?: string; initial_option?: string; options?: { value: string }[] };

function replyPicker(card: object): Select {
  const found = JSON.stringify(card).length > 0 ? findSelect(card) : undefined;
  if (!found) throw new Error('message_reply picker not found');
  return found;
}

function findSelect(node: unknown): Select | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findSelect(item);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.tag === 'select_static' && obj.name === 'message_reply') return obj as Select;
    for (const value of Object.values(obj)) {
      const hit = findSelect(value);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe('configFormCard message reply picker', () => {
  it('offers all three reply modes', () => {
    const picker = replyPicker(configFormCard(base));
    expect(picker.options?.map((o) => o.value)).toEqual(['text', 'markdown', 'card']);
  });

  it('keeps `card` selected instead of silently showing it as markdown', () => {
    const picker = replyPicker(configFormCard({ ...base, messageReply: 'card' }));
    expect(picker.initial_option).toBe('card');
  });
});

function findNamedSelect(node: unknown, name: string): Select | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNamedSelect(child, name);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node && typeof node === 'object') {
    const obj = node as Select & Record<string, unknown>;
    if (obj.tag === 'select_static' && obj.name === name) return obj;
    for (const value of Object.values(obj)) {
      const hit = findNamedSelect(value, name);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe('configFormCard effort picker', () => {
  it('offers the Codex levels, including ultra, on codex profiles', () => {
    const picker = findNamedSelect(configFormCard({ ...base, agentKind: 'codex', effort: 'ultra' }), 'effort');
    expect(picker?.options?.map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(picker?.initial_option).toBe('ultra');
  });

  it('keeps ultra out of the claude picker, and a stale ultra shows as default', () => {
    const picker = findNamedSelect(configFormCard({ ...base, agentKind: 'claude', effort: 'ultra' }), 'effort');
    expect(picker?.options?.map((o) => o.value)).not.toContain('ultra');
    expect(picker?.initial_option).toBe('');
  });
});

describe('configFormCard group panel', () => {
  const groups: ConfigFormOpts = {
    ...base,
    requireMentionInGroup: true,
    allowedChats: ['oc_open000001', 'oc_quiet00002', 'oc_strict0003', 'oc_gone000004'],
    knownChats: [
      { id: 'oc_open000001', name: '研发群' },
      { id: 'oc_quiet00002', name: '值班群' },
      { id: 'oc_strict0003', name: '客户群' },
      { id: 'oc_idle000005', name: '闲聊群' },
    ],
    chatRequireMention: { oc_quiet00002: false },
    chatAllowedUsers: { oc_strict0003: ['ou_alice', 'ou_bob'] },
  };

  it('splits groups into answered, joined-but-idle and left, with counts in the title', () => {
    const panel = groupPanelText(configFormCard(groups));
    expect(panel).toContain('bot 在 4 个群，响应 3 个');
    expect(panel).toContain('**响应中**（3）');
    expect(panel).toContain('**在群里但不响应**（1）');
    expect(panel).toContain('闲聊群');
    expect(panel).toContain('**名单里但 bot 已不在群**（1）');
    expect(panel).toContain('...000004');
  });

  it('shows each answered group its @ rule and member restriction', () => {
    const panel = groupPanelText(configFormCard(groups));
    expect(lineAfter(panel, '研发群')).toContain('跟随全局（需 @）');
    expect(lineAfter(panel, '研发群')).toContain('群内所有人可用');
    expect(lineAfter(panel, '值班群')).toContain('无需 @');
    expect(lineAfter(panel, '客户群')).toContain('仅指定成员（2）');
    expect(lineAfter(panel, '客户群')).toContain('<at id=\\"ou_alice\\"></at>');
  });

  it('says a restricted group with no members is admin-only', () => {
    const panel = groupPanelText(configFormCard({ ...groups, chatAllowedUsers: { oc_strict0003: [] } }));
    expect(lineAfter(panel, '客户群')).toContain('仅管理员可用');
  });

  it('falls back to the allowlist alone when the joined-group lookup is empty', () => {
    const panel = groupPanelText(configFormCard({ ...groups, knownChats: [] }));
    expect(panel).toContain('**响应中**（4）');
    expect(panel).toContain('群列表为空');
    expect(panel).not.toContain('在群里但不响应');
    expect(panel).not.toContain('bot 已不在群');
  });

  it('warns that the lists are not enforced in team mode', () => {
    expect(groupPanelText(configFormCard({ ...groups, mode: 'team' }))).toContain('团队版已开启');
    expect(groupPanelText(configFormCard(groups))).not.toContain('团队版已开启');
  });

  it('points the access panel at the group panel instead of repeating the list', () => {
    const card = JSON.stringify(configFormCard(groups));
    expect(card).toContain('**允许响应的群**（共 4 个）');
    expect(card.split('研发群').length - 1).toBe(1);
  });
});

function groupPanelText(card: object): string {
  const panel = findPanel(card, '群管理');
  if (!panel) throw new Error('group panel not found');
  return JSON.stringify(panel);
}

/** The panel row for a group: its name line plus the rule line under it. */
function lineAfter(panelJson: string, name: string): string {
  const start = panelJson.indexOf(name);
  if (start === -1) throw new Error(`${name} not in panel`);
  const firstBreak = panelJson.indexOf('\\n', start);
  const secondBreak = panelJson.indexOf('\\n', firstBreak + 2);
  return panelJson.slice(start, secondBreak === -1 ? undefined : secondBreak);
}

function findPanel(node: unknown, keyword: string): object | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findPanel(item, keyword);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.tag === 'collapsible_panel' && JSON.stringify(obj.header).includes(keyword)) return obj;
    for (const value of Object.values(obj)) {
      const hit = findPanel(value, keyword);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe('configFormCard group panel management hints', () => {
  const withLeft: ConfigFormOpts = {
    ...base,
    allowedChats: ['oc_gone000004'],
    knownChats: [{ id: 'oc_other00009', name: '别的群' }],
  };

  it('points per-group settings at the web console when it is running', () => {
    const panel = groupPanelText(configFormCard({ ...withLeft, consoleUrl: 'http://127.0.0.1:1/' }));
    expect(panel).toContain('在 Web 控制台里设置');
  });

  it('points per-group settings at the config file when no console is running', () => {
    const panel = groupPanelText(configFormCard(withLeft));
    expect(panel).toContain('access.chatRequireMention');
  });

  it('tells how to drop a chat the bot has left from p2p', () => {
    for (const opts of [withLeft, { ...withLeft, consoleUrl: 'http://127.0.0.1:1/' }]) {
      expect(groupPanelText(configFormCard(opts))).toContain('/remove group <ID 末 6 位>');
    }
  });
});

describe('configFormCard 会话智能压缩 switch', () => {
  it('offers the switch, set to the current state', () => {
    expect(findNamedSelect(configFormCard(base), 'smart_session')?.initial_option).toBe('off');
    expect(findNamedSelect(configFormCard({ ...base, smartSession: true }), 'smart_session')?.initial_option).toBe('on');
  });

  it('reports the switch on the saved card', () => {
    expect(JSON.stringify(configSavedCard({ ...base, smartSession: true }))).toContain('会话智能压缩');
  });
});

describe('config Worktree 自动清理 switch', () => {
  it('shows the current state in the form and saved card', () => {
    expect(findNamedSelect(configFormCard(base), 'auto_worktree_cleanup')?.initial_option).toBe('off');
    expect(findNamedSelect(configFormCard({ ...base, autoWorktreeCleanup: true }), 'auto_worktree_cleanup')?.initial_option).toBe('on');
    expect(JSON.stringify(configSavedCard({ ...base, autoWorktreeCleanup: true }))).toContain('Worktree 自动清理');
  });
});

describe('config 梦境整理 switch', () => {
  it('shows the current state in the form and saved card', () => {
    expect(findNamedSelect(configFormCard(base), 'dream')?.initial_option).toBe('off');
    expect(findNamedSelect(configFormCard({ ...base, dream: true }), 'dream')?.initial_option).toBe('on');
    expect(JSON.stringify(configSavedCard({ ...base, dream: true }))).toContain('梦境整理');
  });

  it('has its own 自动整理 switch that says when it cannot act', () => {
    expect(findNamedSelect(configFormCard(base), 'dream_auto')?.initial_option).toBe('off');
    expect(findNamedSelect(configFormCard({ ...base, dreamAuto: true }), 'dream_auto')?.initial_option).toBe('on');
    expect(JSON.stringify(configSavedCard({ ...base, dream: true, dreamAuto: true }))).toContain('自动整理');
    expect(JSON.stringify(configSavedCard({ ...base, dream: false, dreamAuto: true }))).toContain('不生效');
  });
});
