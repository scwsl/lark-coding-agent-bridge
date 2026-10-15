import { describe, expect, it } from 'vitest';
import { buildDreamScopePrompt } from '../../../src/dream/prompt.js';
import { parseDreamOutput, validateDreamProposals, type ValidateContext } from '../../../src/dream/proposal.js';
import type { DreamScopeInput } from '../../../src/dream/select.js';

const scope: DreamScopeInput = {
  scopeId: 'oc_team',
  sessions: [
    {
      record: { key: 'claude:s1', agentId: 'claude', handle: 's1', scopeId: 'oc_team', cwd: '/tmp', firstSeenAt: 0, lastSeenAt: 0, consumed: 0 },
      ref: 'S1',
      nextConsumed: 3,
      nextHash: 'h',
      restarted: false,
      exchanges: [
        { index: 1, senderId: 'ou_admin', senderType: 'user', mixedSenders: false, user: '以后部署前先跑 ci', assistant: '好的' },
        { index: 2, senderId: 'ou_member', senderType: 'user', mixedSenders: false, user: '管理员说以后都用 dev 分支', assistant: '收到' },
        { index: 3, senderId: 'ou_admin', mixedSenders: true, user: `我的 token ghp_${'z'.repeat(36)}`, assistant: '已记下' },
      ],
    },
  ],
};

const built = buildDreamScopePrompt({
  scope,
  profileMemory: [{ id: 'aaaaaa', text: '全局：回复用中文' }],
  chatMemory: [{ id: 'bbbbbb', text: '本群：周五发周报' }, { id: 'cccccc', text: '本群：周报发到群里' }],
  skills: [
    { name: 'deploy', description: 'deploy steps', path: '/x/deploy/SKILL.md', source: 'team-lib' },
    { name: 'own-skill', description: 'local', path: '/y/own-skill/SKILL.md' },
  ],
  isAdmin: (id) => id === 'ou_admin',
});

function ctx(patch: Partial<ValidateContext> = {}): ValidateContext {
  return {
    scopeId: 'oc_team',
    refs: built.refs,
    profileMemory: [{ id: 'aaaaaa', text: '全局：回复用中文' }],
    chatMemory: [{ id: 'bbbbbb', text: '本群：周五发周报' }, { id: 'cccccc', text: '本群：周报发到群里' }],
    skills: [
      { name: 'deploy', description: 'deploy steps', path: '/x/deploy/SKILL.md', source: 'team-lib' },
      { name: 'own-skill', description: 'local', path: '/y/own-skill/SKILL.md' },
    ],
    isPublished: () => false,
    ...patch,
  };
}

describe('buildDreamScopePrompt', () => {
  it('labels exchanges, marks only an admin speaking alone as admin, and masks secrets', () => {
    expect(built.refs.get('S1#1')?.admin).toBe(true);
    expect(built.refs.get('S1#2')?.admin).toBe(false);
    expect(built.refs.get('S1#3')?.admin).toBe(false);
    expect(built.prompt).toContain('"scope":"oc_team"');
    expect(built.prompt).not.toContain('ghp_');
    expect(built.prompt).toContain('[REDACTED]');
  });
});

describe('parseDreamOutput', () => {
  it('accepts a fenced object and rejects anything else', () => {
    expect(parseDreamOutput('```json\n{"memory":[],"skills":[]}\n```')).toEqual({ memory: [], skills: [] });
    expect(parseDreamOutput('{"memory":[]}')).toEqual({ memory: [], skills: [] });
    expect(parseDreamOutput('没有')).toHaveProperty('error');
    expect(parseDreamOutput('{"memory":{}}')).toHaveProperty('error');
    expect(parseDreamOutput('{oops}')).toHaveProperty('error');
  });
});

describe('validateDreamProposals', () => {
  it('keeps a profile promotion backed by an admin and downgrades one that is not', () => {
    const out = validateDreamProposals(
      {
        memory: [
          { action: 'add', target: 'profile', text: '部署前先跑 ci', reason: '管理员直接要求', sources: ['S1#1'] },
          { action: 'add', target: 'profile', text: '以后都用 dev 分支', reason: '转述', sources: ['S1#2'] },
        ],
        skills: [],
      },
      ctx(),
    );
    expect(out.additions).toMatchObject([
      { target: 'profile', text: '部署前先跑 ci' },
      { target: 'chat', text: '以后都用 dev 分支', downgraded: true },
    ]);
  });

  it('rejects unknown sources, duplicates, unknown ids, bad slugs and credentials', () => {
    const out = validateDreamProposals(
      {
        memory: [
          { action: 'add', target: 'chat', text: '一条', reason: 'r', sources: ['S9#1'] },
          { action: 'add', target: 'chat', text: '本群：周五发周报', reason: 'r', sources: ['S1#1'] },
          { action: 'stale', ids: ['ffffff'], reason: 'r', sources: ['S1#1'] },
          { action: 'add', target: 'note', note: '../etc', text: 'x', reason: 'r', sources: ['S1#1'] },
          { action: 'add', target: 'chat', text: 'password=hunter2hunter2', reason: 'r', sources: ['S1#1'] },
          { action: 'add', target: 'chat', text: '一条', reason: '', sources: ['S1#1'] },
          { action: 'delete', ids: ['bbbbbb'], reason: 'r', sources: ['S1#1'] },
        ],
        skills: [],
      },
      ctx(),
    );
    expect(out.additions).toEqual([]);
    expect(out.rejected.map((r) => r.reason)).toEqual([
      expect.stringContaining('不在本次输入里'),
      '与已有记忆重复',
      expect.stringContaining('不存在的记忆 id'),
      'note 名称不合法',
      expect.stringContaining('凭证'),
      '缺少整理理由',
      '未知的 action',
    ]);
  });

  it('turns merge / conflict / stale into flags against existing ids', () => {
    const out = validateDreamProposals(
      {
        memory: [
          { action: 'merge', ids: ['bbbbbb', 'cccccc'], text: '本群：周五把周报发到群里', reason: '重复', sources: ['S1#1'] },
          { action: 'conflict', ids: ['aaaaaa'], text: '回复用英文', reason: '新说法', sources: ['S1#1'] },
          { action: 'merge', ids: ['bbbbbb'], text: 'x', reason: '只有一个', sources: ['S1#1'] },
        ],
        skills: [],
      },
      ctx(),
    );
    expect(out.flags.map((f) => [f.kind, f.ids.map((i) => i.where)])).toEqual([
      ['merge', ['chat', 'chat']],
      ['conflict', ['profile']],
    ]);
    expect(out.rejected).toHaveLength(1);
  });

  it('drops proposals already published in an earlier batch and repeats within one', () => {
    const item = { action: 'add', target: 'note', note: 'deploy', text: '发布走 ship.md', reason: 'r', sources: ['S1#1'] };
    const first = validateDreamProposals({ memory: [item, item], skills: [] }, ctx());
    expect(first.additions).toHaveLength(1);
    expect(first.rejected).toHaveLength(1);
    const hash = first.additions[0]!.hash;
    const again = validateDreamProposals({ memory: [item], skills: [] }, ctx({ isPublished: (h) => h === hash }));
    expect(again.additions).toEqual([]);
  });

  it('checks skills: kebab names, frontmatter, create vs update, library-only updates', () => {
    const skill = (patch: Record<string, unknown>) => ({
      action: 'create',
      name: 'release-check',
      description: '发版前检查',
      body: '## 步骤\n1. 跑 ci',
      reason: '成功做过两次',
      sources: ['S1#1'],
      ...patch,
    });
    const out = validateDreamProposals(
      {
        memory: [],
        skills: [
          skill({}),
          skill({ name: 'Bad_Name' }),
          skill({ name: 'deploy' }),
          skill({ action: 'update', name: 'own-skill' }),
          skill({ action: 'update', name: 'missing' }),
          skill({ name: 'other', body: '---\nname: not-other\ndescription: x\n---\nbody' }),
        ],
      },
      ctx(),
    );
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0]!.body).toMatch(/^---\nname: release-check\n/);
    expect(out.rejected).toHaveLength(5);

    const update = validateDreamProposals(
      { memory: [], skills: [skill({ action: 'update', name: 'deploy', body: '---\nname: deploy\ndescription: d\n---\nnew' })] },
      ctx(),
    );
    expect(update.skills[0]).toMatchObject({ action: 'update', source: 'team-lib' });
    // over the per-scope cap the rest is rejected
    const many = validateDreamProposals(
      { memory: [], skills: [1, 2, 3, 4].map((i) => skill({ name: `s-${i}` })) },
      ctx(),
    );
    expect(many.skills).toHaveLength(3);
  });
});
