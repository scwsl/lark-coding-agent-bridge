import { describe, expect, it } from 'vitest';
import { DREAM_DEFAULTS, resolveDreamSettings } from '../../../src/config/schema.js';
import { excludedScope, excludedTerm } from '../../../src/dream/exclude.js';
import { buildDreamScopePrompt } from '../../../src/dream/prompt.js';
import { validateDreamProposals } from '../../../src/dream/proposal.js';
import { selectDreamInputs, type DreamScopeInput } from '../../../src/dream/select.js';
import type { DreamSessionRecord } from '../../../src/dream/state.js';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const HOUR = 3_600_000;

describe('excludedScope', () => {
  it('matches the chat itself and every topic of it, raw or sanitized', () => {
    const prefixes = ['oc_proj'];
    expect(excludedScope('oc_proj', prefixes)).toBe(true);
    expect(excludedScope('oc_proj:omt_1', prefixes)).toBe(true);
    expect(excludedScope('oc_proj_omt_1', prefixes)).toBe(true);
    expect(excludedScope('oc_project', prefixes)).toBe(false);
    expect(excludedScope('oc_other:omt_1', prefixes)).toBe(false);
    expect(excludedScope('oc_proj', [])).toBe(false);
  });
});

describe('excludedTerm', () => {
  it('finds a term case-insensitively', () => {
    expect(excludedTerm('Thing-Hub 的 E2E', ['thing-hub', 'thinghub'])).toBe('thing-hub');
    expect(excludedTerm('nothing here', ['thing-hub'])).toBeUndefined();
    expect(excludedTerm('anything', [])).toBeUndefined();
  });
});

describe('resolveDreamSettings', () => {
  it('reads excludeScopes / excludeTerms, dropping blanks; defaults empty', () => {
    const s = resolveDreamSettings({ excludeScopes: ['oc_a', ' ', 3 as unknown as string], excludeTerms: [' thing-hub '] });
    expect(s.excludeScopes).toEqual(['oc_a']);
    expect(s.excludeTerms).toEqual(['thing-hub']);
    expect(resolveDreamSettings(undefined).excludeScopes).toEqual([]);
    expect(DREAM_DEFAULTS.excludeTerms).toEqual([]);
  });
});

describe('selectDreamInputs with excludeScopes', () => {
  it('never reads an excluded chat or its topics', async () => {
    const rec = (handle: string, scopeId: string): DreamSessionRecord => ({
      key: `claude:${handle}`, agentId: 'claude', handle, scopeId, cwd: '/tmp',
      firstSeenAt: NOW - 10 * HOUR, lastSeenAt: NOW - 2 * HOUR, consumed: 0,
    });
    const read: string[] = [];
    const sel = await selectDreamInputs({
      records: [rec('a', 'oc_proj:omt_1'), rec('b', 'oc_proj'), rec('c', 'oc_team')],
      settings: { ...DREAM_DEFAULTS, excludeScopes: ['oc_proj'] },
      now: NOW,
      isBusy: () => false,
      read: async (r) => {
        read.push(r.handle);
        return { exchanges: [{ index: 1, user: 'q', assistant: 'a', mixedSenders: false }], lastActivityAt: NOW - 2 * HOUR };
      },
    });
    expect(read).toEqual(['c']);
    expect(sel.scopes.map((s) => s.scopeId)).toEqual(['oc_team']);
    expect(sel.deferred).toEqual([]);
  });
});

describe('validateDreamProposals with excludeTerms', () => {
  const scope: DreamScopeInput = {
    scopeId: 'oc_team',
    sessions: [{
      record: { key: 'claude:s1', agentId: 'claude', handle: 's1', scopeId: 'oc_team', cwd: '/tmp', firstSeenAt: 0, lastSeenAt: 0, consumed: 0 },
      ref: 'S1', nextConsumed: 1, nextHash: 'h', restarted: false,
      exchanges: [{ index: 1, senderId: 'ou_admin', senderType: 'user', mixedSenders: false, user: 'x', assistant: 'y' }],
    }],
  };
  const built = buildDreamScopePrompt({ scope, profileMemory: [], chatMemory: [], skills: [], isAdmin: () => true });
  const ctx = { scopeId: 'oc_team', refs: built.refs, profileMemory: [], chatMemory: [], skills: [], isPublished: () => false, excludeTerms: ['thing-hub'] };

  it('rejects notes, memories and skills naming an excluded project; keeps the rest', () => {
    const out = validateDreamProposals(
      {
        memory: [
          { action: 'add', target: 'note', note: 'local-env', text: 'Thing-Hub 的 E2E 要等就绪', reason: 'r', sources: ['S1#1'] },
          { action: 'add', target: 'note', note: 'local-env', text: 'podman 扩盘要先停机', reason: '在 thing-hub 里遇到', sources: ['S1#1'] },
          { action: 'add', target: 'note', note: 'local-env', text: 'podman 扩盘要先停机', reason: '实测', sources: ['S1#1'] },
        ],
        skills: [{ action: 'create', name: 'release-check', description: '发版前检查', body: '## 步骤\n1. 构建 thing-hub', reason: 'r', sources: ['S1#1'] }],
      },
      ctx,
    );
    expect(out.additions.map((a) => a.text)).toEqual(['podman 扩盘要先停机']);
    expect(out.skills).toEqual([]);
    expect(out.rejected).toHaveLength(3);
    expect(out.rejected.every((r) => r.reason.includes('单独存放的项目'))).toBe(true);
  });
});
