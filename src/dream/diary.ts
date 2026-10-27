/**
 * 梦境日记: one short entry per run, for a human to read what the night
 * did — what was read (浅睡), which themes kept coming back (REM), what was
 * written, pooled, consolidated or archived (深睡), and how many proposals
 * were turned down and why. Rejections are counted by kind only: a diary
 * never repeats what was turned down.
 *
 * The entry goes to the knowledge repository's `DREAMS.md` (newest first)
 * when the run wrote anything there, and is kept with the run for
 * `/practice diary` either way. It is for reading, not a source of memory:
 * the knowledge injection never loads it.
 */
import type { DreamRejection } from './proposal';
import { prependEntry } from './publish';
import { localTime } from './report';

export interface DiaryInput {
  batchId: string;
  at: number;
  timezone: string;
  trigger: 'manual' | 'auto';
  /** 续跑 round (absent: the first). */
  round?: number;
  light: {
    sessions: number;
    scopes: number;
    exchanges: number;
    /** Conversations left for a later run. */
    deferred: number;
    external: ReadonlyArray<{ library: string; files: number; pending: number; error?: string }>;
    recall?: { sessions: number; exchanges: number; reads: number };
    /** Most read notes / skills of the last days (`note:<scope>/<topic>`, `skill:<dir>`). */
    topNotes?: ReadonlyArray<{ key: string; reads: number }>;
    topSkills?: ReadonlyArray<{ key: string; reads: number }>;
  };
  rem?: {
    /** Two or three sentences on the night's themes. */
    narrative?: string;
    themes: number;
    /** Themes seen in more than one conversation or on more than one day. */
    recurring: number;
    error?: string;
  };
  deep: {
    /** Written tonight: conventions (chat / profile memory), notes, skills, review flags. */
    memory: number;
    notes: number;
    skills: number;
    flags: number;
    /** `publish: pr`: tonight's writes wait in a Draft PR instead of taking effect. */
    viaPr?: boolean;
    /** Targets that did not get through (`label：error`); retried next run. */
    problems?: readonly string[];
    pool?: { entered: number; promoted: number; expired: number; size: number };
    consolidation?: {
      prUrl?: string;
      updated: number;
      merged: number;
      deleted: number;
      dismissed: number;
      /** Why it did not run (a review still open, nothing pending…). */
      skipped?: string;
      error?: string;
    };
    notesMerge?: { notes: number; into: number; lifted: number; dropped: number; error?: string };
    archived?: number;
  };
  rejected: readonly DreamRejection[];
}

/** Rejection reasons by kind, for counting; the first pattern that matches names it. */
const REJECTION_KINDS: ReadonlyArray<[RegExp, string]> = [
  [/重复/, '重复'],
  [/上限|过多/, '超出数量上限'],
  [/凭证/, '疑似含凭证'],
  [/来源/, '来源不对'],
  [/理由/, '缺少理由'],
  [/argument-hint/, '缺参数说明'],
  [/名称|简称|重名|同名|项目:技能|不一致/, '技能命名不合规'],
  [/\bid\b|ids/, '引用了不存在的条目'],
  [/外部|自己的库|自带/, '越权修改'],
  [/为空|过长|缺少内容|缺少说明/, '内容为空或过长'],
];

/** Rejections counted by kind, most frequent first. */
export function rejectionCounts(rejected: readonly DreamRejection[]): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of rejected) {
    const kind = REJECTION_KINDS.find(([pattern]) => pattern.test(item.reason))?.[1] ?? '其他';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/** Whether a run did anything worth a diary entry in the repository. */
export function diaryWorthWriting(input: DiaryInput): boolean {
  const { deep } = input;
  return (
    deep.memory + deep.notes + deep.skills + deep.flags > 0 ||
    (deep.pool ? deep.pool.entered + deep.pool.promoted + deep.pool.expired > 0 : false) ||
    Boolean(deep.consolidation?.prUrl) ||
    (deep.notesMerge?.notes ?? 0) > 0 ||
    (deep.archived ?? 0) > 0
  );
}

export function diaryEntry(input: DiaryInput): string {
  const { light, rem, deep } = input;
  const title = `## ${localTime(input.at, input.timezone)} · 批次 \`${input.batchId}\`${input.trigger === 'auto' ? '（自动）' : ''}${
    input.round && input.round > 1 ? ` · 续跑第 ${input.round} 轮` : ''
  }`;

  const read = [
    light.sessions > 0 ? `读了 ${light.sessions} 个会话（${light.scopes} 个范围、${light.exchanges} 轮）` : '没有新的已结束会话',
    ...light.external.map((item) =>
      item.error
        ? `外部库 ${item.library} 没读成（${item.error}）`
        : item.files > 0
          ? `课前学习 ${item.library} ${item.files} 个文件${item.pending > 0 ? `（还剩 ${item.pending} 个）` : ''}`
          : undefined,
    ),
    light.deferred > 0 ? `${light.deferred} 个会话延后` : undefined,
  ].filter(Boolean);
  const recall = light.recall
    ? `召回统计：新统计到 ${light.recall.reads} 次读取（${light.recall.sessions} 个会话、${light.recall.exchanges} 轮）`
    : undefined;
  const top = [
    light.topNotes?.length ? `近 7 天最常读的笔记：${light.topNotes.map((item) => `${item.key.replace(/^note:/, '')}（${item.reads}）`).join('、')}` : undefined,
    light.topSkills?.length ? `技能：${light.topSkills.map((item) => `${item.key.replace(/^skill:/, '')}（${item.reads}）`).join('、')}` : undefined,
  ].filter(Boolean);

  const lines = [title, '', `**浅睡**：${read.join('；')}。${recall ? `${recall}。` : ''}${top.length ? `${top.join('；')}。` : ''}`];

  if (rem) {
    const parts = rem.error
      ? [`没做成（${rem.error}）`]
      : [rem.narrative?.trim().replace(/[。.！!？?\s]+$/, '') || '没有归纳出值得一提的主题', `主题 ${rem.themes} 个，其中跨会话或跨天复现的 ${rem.recurring} 个`];
    lines.push('', `**REM**：${parts.join('。')}。`);
  }

  const wrote = [
    deep.memory > 0 ? `记忆 ${deep.memory} 条` : undefined,
    deep.notes > 0 ? `笔记 ${deep.notes} 条` : undefined,
    deep.skills > 0 ? `技能 ${deep.skills} 个` : undefined,
    deep.flags > 0 ? `待处理标记 ${deep.flags} 条` : undefined,
  ].filter(Boolean);
  const deepParts = [
    wrote.length > 0 ? `${deep.viaPr ? '写进待审 Draft PR' : '当晚生效'}：${wrote.join('、')}` : '当晚没有新内容写入',
  ];
  if (deep.problems?.length) deepParts.push(`没走通的（下一轮重试）：${deep.problems.map((item) => clip(item, 160)).join('；')}`);
  if (deep.pool) {
    deepParts.push(
      `候选池：新进 ${deep.pool.entered} 条、晋升 ${deep.pool.promoted} 条、过期 ${deep.pool.expired} 条，池中现有 ${deep.pool.size} 条`,
    );
  }
  const c = deep.consolidation;
  if (c) {
    if (c.error) deepParts.push(`记忆整合没做成（${c.error}）`);
    else if (c.skipped) deepParts.push(`记忆整合跳过（${c.skipped}）`);
    else {
      deepParts.push(
        `记忆整合：改写 ${c.updated} 条、合并 ${c.merged} 组、删除 ${c.deleted} 条、关闭标记 ${c.dismissed} 条${c.prUrl ? `，待审 Draft PR ${c.prUrl}` : ''}`,
      );
    }
  }
  const n = deep.notesMerge;
  if (n) {
    if (n.error) deepParts.push(`笔记整合没做成（${n.error}）`);
    else if (n.notes > 0) {
      deepParts.push(`笔记整合：${n.notes} 篇合成 ${n.into} 篇${n.lifted > 0 ? `，${n.lifted} 篇提升到主会话` : ''}${n.dropped > 0 ? `，去掉重复条目 ${n.dropped} 条` : ''}`);
    }
  }
  if (deep.archived) deepParts.push(`归档长期没人读的笔记 ${deep.archived} 篇（archive/notes/，可随时移回）`);
  lines.push('', `**深睡**：${deepParts.join('；')}。`);

  const counts = rejectionCounts(input.rejected);
  if (counts.length > 0) {
    const total = counts.reduce((sum, item) => sum + item.count, 0);
    lines.push('', `**未采纳**：${total} 条——${counts.map((item) => `${item.kind} ${item.count}`).join('、')}（只计数，不列内容）。`);
  }
  return lines.join('\n');
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export const DIARY_FILE = 'DREAMS.md';
export const DIARY_HEADER =
  '# 梦境日记\n\n课堂精练每一轮的小结，最新的在最前面：浅睡读了什么、REM 归纳出什么主题、深睡写进了什么、整合和归档了什么、多少提案没采纳。只给人看，不会被当作记忆加载。由 lark-channel-bridge 自动写入。\n';

/** Put an entry at the top of the checkout's `DREAMS.md`. */
export function writeDiary(dir: string, entry: string): Promise<{ file: string } | { error: string }> {
  return prependEntry(dir, DIARY_FILE, DIARY_HEADER, entry);
}
