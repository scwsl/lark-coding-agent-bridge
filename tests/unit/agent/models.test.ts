import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  clampCodexEffort,
  claudeModelIdLabel,
  parseClaudeAdditionalModels,
  isDefaultModel,
  modelLabel,
  normalizeModelSelection,
  parseCodexModelsCache,
  resetCodexModelCatalogCache,
  resolveEffortArg,
  resolveModelArg,
  resolvedModelLabel,
  supportedEfforts,
  supportedModels,
} from '../../../src/agent/models.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

describe('agent model catalog', () => {
  it('offers a distinct catalog per agent kind, each led by the default sentinel', () => {
    const claude = supportedModels('claude');
    const codex = supportedModels('codex');
    expect(claude[0]?.value).toBe(DEFAULT_MODEL);
    expect(codex[0]?.value).toBe(DEFAULT_MODEL);
    // Claude is offered through the CLI's own "always latest" aliases.
    expect(claude.map((m) => m.value)).toEqual(expect.arrayContaining(['opus', 'sonnet', 'fable', 'haiku', 'opusplan']));
    expect(codex.length).toBeGreaterThan(1);
    expect(claude.map((m) => m.value)).not.toContain(codex[1]?.value);
  });

  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('claude-opus-5')).toBe(false);
  });

  it('coerces unknown / cross-agent selections back to the default option', () => {
    expect(normalizeModelSelection('claude', 'claude-opus-5')).toBe('claude-opus-5');
    // A Codex model left over after switching a profile to Claude is invalid.
    expect(normalizeModelSelection('claude', 'gpt-6-sol')).toBe(DEFAULT_MODEL);
    expect(normalizeModelSelection('claude', undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolves the --model argument, omitting it for the default', () => {
    expect(resolveModelArg('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelArg('claude', DEFAULT_MODEL)).toBeUndefined();
    expect(resolveModelArg('claude', undefined)).toBeUndefined();
    // Cross-agent value → no flag rather than a broken model.
    expect(resolveModelArg('codex', 'claude-opus-5')).toBeUndefined();
  });

  it('labels a stored value using the picker option text', () => {
    expect(modelLabel('claude', 'opus')).toBe('Opus（始终最新）');
    expect(modelLabel('claude', 'opus[1m]')).toContain('1M');
    expect(modelLabel('claude', DEFAULT_MODEL)).toContain('跟随默认');
  });

  it('keeps a previously pinned Claude id selectable and labelled, instead of resetting it', () => {
    // A profile saved with the old pinned picker keeps working.
    expect(normalizeModelSelection('claude', 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(resolveModelArg('claude', 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(modelLabel('claude', 'claude-opus-5-5')).toBe('Opus 5.5');
    expect(supportedModels('claude', 'claude-fable-5-1[1m]').map((m) => m.value)).toContain('claude-fable-5-1[1m]');
    // …but a malformed or foreign value still falls back to default.
    expect(normalizeModelSelection('claude', 'rm -rf /')).toBe(DEFAULT_MODEL);
    expect(supportedModels('claude', 'gpt-6-sol').map((m) => m.value)).not.toContain('gpt-6-sol');
  });

  it('formats pinned Claude ids into readable labels', () => {
    expect(claudeModelIdLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(claudeModelIdLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(claudeModelIdLabel('claude-fable-5-1[1m]')).toBe('Fable 5.1 · 1M');
    expect(claudeModelIdLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(claudeModelIdLabel('something-else')).toBe('something-else');
  });

  it('labels the byline with the model the agent actually loaded', () => {
    expect(resolvedModelLabel('claude', 'opus', 'claude-opus-5-5')).toBe(
      'Opus 5.5 · 配置 Opus（始终最新）',
    );
    expect(resolvedModelLabel('claude', 'opus[1m]', 'claude-opus-5-5[1m]')).toBe(
      'Opus 5.5 · 1M · 配置 Opus · 1M 上下文（始终最新）',
    );
    // Unrecognised ids fall through verbatim rather than being dropped.
    expect(resolvedModelLabel('claude', 'sonnet', 'custom-model')).toBe(
      'custom-model · 配置 Sonnet（始终最新）',
    );
  });

  it('reads the account-specific extras Claude Code caches, ignoring junk', () => {
    const raw = JSON.stringify({
      additionalModelOptionsCache: [
        { value: 'claude-fable-5-1[1m]', label: 'Fable', description: 'Fable 5.1 · Most capable for long tasks' },
        { value: 'not a model', label: 'x' },
        { label: 'no value' },
      ],
    });
    expect(parseClaudeAdditionalModels(raw)).toEqual([{ value: 'claude-fable-5-1[1m]', label: 'Fable 5.1 · 1M' }]);
    expect(parseClaudeAdditionalModels('{')).toEqual([]);
    expect(parseClaudeAdditionalModels('{}')).toEqual([]);
  });

  it('resolves effort against each agent\'s own levels', () => {
    expect(resolveEffortArg('claude', 'xhigh')).toBe('xhigh');
    expect(resolveEffortArg('claude', 'max')).toBe('max');
    // Unset / unknown / hand-edited → omit the flag, let the CLI default win.
    expect(resolveEffortArg('claude', undefined)).toBeUndefined();
    expect(resolveEffortArg('claude', 'extra')).toBeUndefined();
    // Codex-only `ultra` must never reach Claude's --effort.
    expect(resolveEffortArg('claude', 'ultra')).toBeUndefined();
    expect(resolveEffortArg('codex', 'xhigh')).toBe('xhigh');
    expect(resolveEffortArg('codex', 'ultra')).toBe('ultra');
    expect(resolveEffortArg('codex', 'extra')).toBeUndefined();
    expect(supportedEfforts('claude')).not.toContain('ultra');
    expect(supportedEfforts('codex')).toContain('ultra');
  });
});

describe('Codex model catalog', () => {
  const cache = JSON.stringify({
    models: [
      { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide', priority: 0 },
      {
        slug: 'gpt-b',
        display_name: 'GPT-B',
        visibility: 'list',
        priority: 5,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
      },
      {
        slug: 'gpt-a',
        display_name: 'GPT-A',
        visibility: 'list',
        priority: 1,
        supported_reasoning_levels: [
          { effort: 'low' },
          { effort: 'max' },
          { effort: 'ultra' },
          { effort: 'something-new' },
        ],
      },
    ],
  });

  it('keeps only listed models, in priority order, with known effort levels', () => {
    expect(parseCodexModelsCache(cache)).toEqual([
      { slug: 'gpt-a', label: 'GPT-A', efforts: ['low', 'max', 'ultra'] },
      { slug: 'gpt-b', label: 'GPT-B', efforts: ['low', 'medium', 'high', 'xhigh'] },
    ]);
    expect(parseCodexModelsCache('not json')).toEqual([]);
    expect(parseCodexModelsCache('{"models": 3}')).toEqual([]);
  });

  describe('live cache', () => {
    const saved = process.env.CODEX_HOME;
    beforeEach(() => {
      const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
      writeFileSync(join(home, 'models_cache.json'), cache);
      process.env.CODEX_HOME = home;
      resetCodexModelCatalogCache();
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
      resetCodexModelCatalogCache();
    });

    it('drives the codex model picker from CODEX_HOME/models_cache.json', () => {
      expect(supportedModels('codex').map((m) => m.value)).toEqual([DEFAULT_MODEL, 'gpt-a', 'gpt-b']);
      expect(modelLabel('codex', 'gpt-b')).toBe('GPT-B');
    });
  });

  it('falls back to a pinned catalog when the cache is missing', () => {
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'codex-empty-'));
    resetCodexModelCatalogCache();
    try {
      const values = supportedModels('codex').map((m) => m.value);
      expect(values[0]).toBe(DEFAULT_MODEL);
      expect(values).toContain('gpt-5.5');
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
      resetCodexModelCatalogCache();
    }
  });

  it('steps an over-high effort down to the model\'s highest supported level', () => {
    const catalog = parseCodexModelsCache(cache);
    expect(clampCodexEffort('gpt-b', 'max', catalog)).toBe('xhigh');
    expect(clampCodexEffort('gpt-b', 'ultra', catalog)).toBe('xhigh');
    expect(clampCodexEffort('gpt-b', 'medium', catalog)).toBe('medium');
    // gpt-a has low/max/ultra only: `high` drops to the nearest lower level.
    expect(clampCodexEffort('gpt-a', 'high', catalog)).toBe('low');
    // No explicit model (Codex config decides) or unknown model → pass through.
    expect(clampCodexEffort(undefined, 'ultra', catalog)).toBe('ultra');
    expect(clampCodexEffort('mystery', 'ultra', catalog)).toBe('ultra');
    expect(clampCodexEffort('gpt-b', undefined, catalog)).toBeUndefined();
  });
});
