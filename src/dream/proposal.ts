import { createHash } from 'node:crypto';
import { isSafeSkillName, parseSkillHeader, type MemoryEntry, type SkillSummary } from '../knowledge/store';
import type { DreamSourceRef } from './prompt';
import { findSecret } from './secrets';

/**
 * The deterministic gate between the agent's text and anything written to a
 * repository. The agent only suggests; every field is checked here against
 * what the run actually gave it — its scope, its source references, the
 * memory ids that exist — and anything that does not fit is dropped with a
 * reason. Nothing in a proposal can name a path, a repository or a command:
 * paths are derived from the scope and a slug, never taken verbatim.
 */

export type MemoryTarget = 'chat' | 'profile' | 'note';

export interface MemoryAddition {
  kind: 'add';
  scopeId: string;
  target: MemoryTarget;
  /** Topic slug, for `note`. */
  note?: string;
  text: string;
  reason: string;
  sources: DreamSourceRef[];
  /** Asked for `profile` without an admin's own words behind it: kept for the chat only. */
  downgraded?: boolean;
  hash: string;
}

/** Merge / conflict / stale: listed in the PR for a human, never applied to a file. */
export interface MemoryFlag {
  kind: 'merge' | 'conflict' | 'stale';
  scopeId: string;
  ids: Array<{ id: string; where: 'profile' | 'chat'; text: string }>;
  text?: string;
  reason: string;
  sources: DreamSourceRef[];
  hash: string;
}

export interface SkillProposal {
  scopeId: string;
  action: 'create' | 'update';
  name: string;
  description: string;
  body: string;
  reason: string;
  sources: DreamSourceRef[];
  /** For `update`: the library the existing skill comes from. */
  source?: string;
  hash: string;
}

export interface DreamRejection {
  scopeId: string;
  kind: 'memory' | 'skill' | 'output';
  reason: string;
}

export interface ValidatedProposals {
  additions: MemoryAddition[];
  flags: MemoryFlag[];
  skills: SkillProposal[];
  rejected: DreamRejection[];
}

export const MAX_MEMORY_PER_SCOPE = 20;
export const MAX_SKILLS_PER_SCOPE = 3;
const MAX_TEXT = 500;
const MAX_REASON = 300;
const MAX_SKILL_BODY = 20_000;
const MAX_DESCRIPTION = 300;
const NOTE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MEMORY_ID_RE = /^[0-9a-f]{6}$/;

/**
 * The JSON object in an agent's answer. Tolerates a Markdown code fence or a
 * sentence around it; anything that is not one object with array fields is an
 * error.
 */
export function parseDreamOutput(text: string): { memory: unknown[]; skills: unknown[] } | { error: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { error: '输出里没有 JSON 对象' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { error: '输出的 JSON 无法解析' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: '输出不是 JSON 对象' };
  const { memory, skills } = parsed as { memory?: unknown; skills?: unknown };
  if ((memory !== undefined && !Array.isArray(memory)) || (skills !== undefined && !Array.isArray(skills))) {
    return { error: 'memory / skills 不是数组' };
  }
  return { memory: memory ?? [], skills: skills ?? [] };
}

export interface ValidateContext {
  scopeId: string;
  refs: ReadonlyMap<string, DreamSourceRef>;
  profileMemory: readonly MemoryEntry[];
  chatMemory: readonly MemoryEntry[];
  skills: readonly SkillSummary[];
  /** Already proposed in an earlier batch (merged, open or rejected). */
  isPublished: (hash: string) => boolean;
}

export function validateDreamProposals(
  raw: { memory: unknown[]; skills: unknown[] },
  ctx: ValidateContext,
): ValidatedProposals {
  const out: ValidatedProposals = { additions: [], flags: [], skills: [], rejected: [] };
  const reject = (kind: DreamRejection['kind'], reason: string) => out.rejected.push({ scopeId: ctx.scopeId, kind, reason });
  const seen = new Set<string>();
  const existingText = {
    profile: new Set(ctx.profileMemory.map((entry) => normalizeText(entry.text))),
    chat: new Set(ctx.chatMemory.map((entry) => normalizeText(entry.text))),
  };

  for (const item of raw.memory) {
    if (out.additions.length + out.flags.length >= MAX_MEMORY_PER_SCOPE) {
      reject('memory', `超过每个会话范围 ${MAX_MEMORY_PER_SCOPE} 条的上限`);
      continue;
    }
    const result = validateMemoryItem(item, ctx, existingText);
    if ('error' in result) {
      reject('memory', result.error);
      continue;
    }
    if (seen.has(result.hash) || ctx.isPublished(result.hash)) {
      reject('memory', '与已提交过的条目重复');
      continue;
    }
    seen.add(result.hash);
    if (result.kind === 'add') out.additions.push(result);
    else out.flags.push(result);
  }

  for (const item of raw.skills) {
    if (out.skills.length >= MAX_SKILLS_PER_SCOPE) {
      reject('skill', `超过每个会话范围 ${MAX_SKILLS_PER_SCOPE} 个的上限`);
      continue;
    }
    const result = validateSkillItem(item, ctx);
    if ('error' in result) {
      reject('skill', result.error);
      continue;
    }
    if (seen.has(result.hash) || ctx.isPublished(result.hash)) {
      reject('skill', '与已提交过的 skill 提案重复');
      continue;
    }
    seen.add(result.hash);
    out.skills.push(result);
  }
  return out;
}

function validateMemoryItem(
  raw: unknown,
  ctx: ValidateContext,
  existingText: { profile: Set<string>; chat: Set<string> },
): MemoryAddition | MemoryFlag | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '条目不是对象' };
  const item = raw as Record<string, unknown>;
  const sources = resolveSources(item.sources, ctx.refs);
  if ('error' in sources) return sources;
  const reason = cleanLine(item.reason, MAX_REASON);
  if (!reason) return { error: '缺少整理理由' };
  const text = item.text === undefined ? undefined : cleanLine(item.text, MAX_TEXT);
  if (text === '') return { error: '条目内容为空或过长' };
  const secret = findSecret(`${text ?? ''}\n${reason}`);
  if (secret) return { error: `疑似包含凭证（${secret}）` };

  const action = item.action;
  if (action === 'add') {
    if (!text) return { error: '新增条目缺少内容' };
    let target = item.target;
    if (target !== 'chat' && target !== 'profile' && target !== 'note') return { error: '未知的 target' };
    let note: string | undefined;
    if (target === 'note') {
      note = typeof item.note === 'string' ? item.note.trim() : '';
      if (!NOTE_SLUG_RE.test(note)) return { error: 'note 名称不合法' };
    }
    let downgraded = false;
    if (target === 'profile' && !sources.some((source) => source.admin)) {
      // Only an admin's own words can change what every chat is told; anything
      // else stays with the chat it came from.
      target = 'chat';
      downgraded = true;
    }
    const key = normalizeText(text);
    if (target !== 'note' && (existingText.chat.has(key) || existingText.profile.has(key))) {
      return { error: '与已有记忆重复' };
    }
    return {
      kind: 'add',
      scopeId: ctx.scopeId,
      target: target as MemoryTarget,
      ...(note ? { note } : {}),
      text,
      reason,
      sources,
      ...(downgraded ? { downgraded } : {}),
      hash: hashOf(['add', target as string, target === 'profile' ? '' : ctx.scopeId, note ?? '', key]),
    };
  }
  if (action === 'merge' || action === 'conflict' || action === 'stale') {
    if (!Array.isArray(item.ids) || item.ids.length === 0 || item.ids.length > 10) return { error: 'ids 缺失或过多' };
    const ids: MemoryFlag['ids'] = [];
    for (const id of item.ids) {
      if (typeof id !== 'string' || !MEMORY_ID_RE.test(id)) return { error: 'id 格式不对' };
      const profile = ctx.profileMemory.find((entry) => entry.id === id);
      const chat = ctx.chatMemory.find((entry) => entry.id === id);
      const found = chat ? { id, where: 'chat' as const, text: chat.text } : profile ? { id, where: 'profile' as const, text: profile.text } : undefined;
      if (!found) return { error: `引用了不存在的记忆 id ${id}` };
      ids.push(found);
    }
    if (action === 'merge' && (ids.length < 2 || !text)) return { error: '合并建议需要至少两个 id 和合并后的写法' };
    if (action === 'conflict' && !text) return { error: '冲突标记需要写出新的说法' };
    return {
      kind: action,
      scopeId: ctx.scopeId,
      ids,
      ...(text ? { text } : {}),
      reason,
      sources,
      hash: hashOf([action, ctx.scopeId, ...ids.map((entry) => entry.id).sort(), text ? normalizeText(text) : '']),
    };
  }
  return { error: '未知的 action' };
}

function validateSkillItem(raw: unknown, ctx: ValidateContext): SkillProposal | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'skill 提案不是对象' };
  const item = raw as Record<string, unknown>;
  const sources = resolveSources(item.sources, ctx.refs);
  if ('error' in sources) return sources;
  const action = item.action;
  if (action !== 'create' && action !== 'update') return { error: '未知的 skill action' };
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!isSafeSkillName(name) || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return { error: 'skill 名称不合法' };
  const reason = cleanLine(item.reason, MAX_REASON);
  if (!reason) return { error: '缺少整理理由' };
  const description = cleanLine(item.description, MAX_DESCRIPTION);
  if (!description) return { error: 'skill 缺少说明' };
  let body = typeof item.body === 'string' ? item.body.replace(/\r\n/g, '\n').trim() : '';
  if (!body || body.length > MAX_SKILL_BODY) return { error: 'skill 正文为空或过长' };
  if (!body.startsWith('---')) {
    body = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`;
  }
  if (parseSkillHeader(name, body).name !== name) return { error: 'skill 正文的 name 与提案不一致' };
  const secret = findSecret(`${body}\n${description}\n${reason}`);
  if (secret) return { error: `skill 疑似包含凭证（${secret}）` };
  const existing = ctx.skills.find((skill) => skill.name === name);
  if (action === 'create' && existing) return { error: `已有同名 skill ${name}，应作为更新提出` };
  if (action === 'update') {
    if (!existing) return { error: `没有名为 ${name} 的 skill 可更新` };
    if (!existing.source) return { error: `${name} 是本 profile 自带的 skill，不在共享库里，梦境整理不改它` };
  }
  return {
    scopeId: ctx.scopeId,
    action,
    name,
    description,
    body: `${body}\n`,
    reason,
    sources,
    ...(action === 'update' && existing?.source ? { source: existing.source } : {}),
    hash: hashOf(['skill', action, name, createHash('sha256').update(body).digest('hex')]),
  };
}

function resolveSources(
  raw: unknown,
  refs: ReadonlyMap<string, DreamSourceRef>,
): DreamSourceRef[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: '缺少来源' };
  if (raw.length > 20) return { error: '来源过多' };
  const out: DreamSourceRef[] = [];
  for (const ref of raw) {
    const source = typeof ref === 'string' ? refs.get(ref.trim()) : undefined;
    if (!source) return { error: `来源 ${String(ref).slice(0, 20)} 不在本次输入里` };
    if (!out.includes(source)) out.push(source);
  }
  return out;
}

/** One line, trimmed and length-capped; '' for anything unusable. */
function cleanLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? '' : clean;
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function hashOf(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 20);
}
