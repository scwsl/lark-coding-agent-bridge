interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`当前 cwd：\`${escapeCode(current ?? '(未设置)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无命名工作目录。'));
    elements.push(
      divMd('💡 发送 `/ws save <name>` 把当前 cwd 存为命名工作目录'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← 当前' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: '切换到此处', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell('📂 工作目录', elements);
}

export interface StatusInfo {
  profileName: string;
  cwd?: string;
  sessionId?: string;
  emptySessionText?: string;
  sessionStale: boolean;
  agentName: string;
  runtimeAccess: {
    label: string;
    value: string;
  };
  larkCliStatus?: 'app' | 'user-ready' | 'user-missing' | 'check-failed';
  /** One-line git summary of `cwd`; absent when it is not a repository. */
  git?: string;
  /** One-line knowledge summary (memory counts, skills, sync state). */
  knowledge?: string;
  activeRun: boolean;
  /** What this scope's run is doing right now, when one is running. */
  activeRunDetail?: string;
  activeScopes?: string[];
  activeCommentScopes?: string[];
  queue?: { active: number; waiting: number; cap: number };
  ownerState: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ 旧 cwd，下一条会新建' : ''}`
    : (info.emptySessionText ?? '(无)');
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _（话题独立 session）_`
      : `\`${escapeCode(info.scope)}\``;
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : '(未设置)';
  const queueLine = info.queue
    ? `${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting`
    : 'unknown';
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `🧩 **profile**: ${escapeMd(info.profileName)}`,
    `📁 **cwd**: ${cwdLine}`,
    ...(info.git ? [`🌿 **git**: ${info.git}`] : []),
    ...(info.knowledge ? [`📚 **knowledge**: ${info.knowledge}`] : []),
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...(info.larkCliStatus ? [`🔐 **lark-cli**: ${info.larkCliStatus}`] : []),
    `🏃 **active run**: ${info.activeRun ? (info.activeRunDetail ? escapeMd(info.activeRunDetail) : 'yes') : 'no'}`,
    ...(info.activeScopes && info.activeScopes.length > 0
      ? [
          `🏃 **active scopes**: ${info.activeScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    ...(info.activeCommentScopes && info.activeCommentScopes.length > 0
      ? [
          `📝 **comment runs**: ${info.activeCommentScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    `🚦 **queue**: ${queueLine}`,
    `👤 **owner API**: ${escapeMd(info.ownerState)}`,
  ];
  return shell('📊 当前状态', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

export interface ResumeEntry {
  sessionId: string;
  displayId?: string;
  preview: string;
  relTime: string;
  lineCount?: number;
  detail?: string;
  current?: boolean;
}

export function resumeCard(cwd: string, entries: ResumeEntry[]): object {
  const elements: object[] = [];
  elements.push(divMd(`当前 cwd：\`${escapeCode(cwd)}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('此 cwd 下没有历史会话。'));
    return shell('🔁 恢复历史会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    const detail = e.detail ?? `${e.lineCount ?? 0} 条`;
    const displayId = e.displayId ?? e.sessionId;
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${displayId.slice(0, 8)}…\` · ${e.relTime} · ${escapeMd(detail)}`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current ? '已是当前会话' : '▸ 恢复此会话',
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current ? 'default' : 'primary',
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('🔁 恢复历史会话', elements);
}

/**
 * Tinted section block for the help card — the same `column_set` + tinted
 * column the `/config` card uses, so the two read as one family instead of
 * "the old card and the new card".
 */
function helpSection(background: string, title: string, lines: string[]): object {
  return {
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        padding: '10px 12px 12px 12px',
        background_style: background,
        vertical_spacing: '6px',
        elements: [
          { tag: 'markdown', content: `**${title}**` },
          { tag: 'markdown', content: lines.join('\n') },
        ],
      },
    ],
  };
}

/** One row of callback buttons, laid out as equal-width columns. */
function helpButtonRow(buttons: Array<{ text: string; cmd: string; primary?: boolean }>): object {
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: buttons.map((button) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: button.text },
          ...(button.primary ? { type: 'primary' } : {}),
          width: 'fill',
          behaviors: [{ type: 'callback', value: { cmd: button.cmd } }],
        },
      ],
    })),
  };
}

/**
 * `/help` — grouped by what you are trying to do rather than by one long
 * alphabetical list. The command set outgrew a single bullet list once the
 * git / knowledge / scheduler commands landed; grouping is what keeps it
 * scannable on a phone.
 */
export function helpCard(agentName = 'Agent'): object {
  const escapedAgentName = escapeMd(agentName);
  return {
    schema: '2.0',
    config: { width_mode: 'fill', summary: { content: '使用帮助' } },
    header: {
      title: { tag: 'plain_text', content: '使用帮助' },
      subtitle: { tag: 'plain_text', content: `其他内容直接交给 ${agentName}` },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'help_outlined' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 16px 12px',
      vertical_spacing: '10px',
      elements: [
        helpSection('blue-50', '🗣 会话', [
          '`/new` `/reset` — 清空当前会话',
          '`/new chat [名字]` — 新建群 + 新会话，自动拉你进群',
          '`/resume [N]` — 列出并恢复历史会话',
          '`/stop` — 结束正在跑的任务（也可点卡片上的 ⏹ 终止）',
          '`/timeout [N|off|default]` — 本会话的探活分钟数',
        ]),
        helpSection('turquoise-50', '📂 工作目录与 Git', [
          '`/cd <路径>` — 切换工作目录（会重置会话）',
          '`/ws list|save|use|remove <名字>` — 命名工作目录',
          '`/diff [staged|<ref>]` — 看改动，长 patch 附带文件',
          '`/worktree [add|use|remove]` — 任务级 worktree，会话自动跟着切',
          '`/pr [编号|链接]` — 当前分支的 PR、CI 与评审状态',
        ]),
        helpSection('violet-50', '🧠 记忆与 skills', [
          '`/memory [add|forget|clear]` — 跨会话记忆，`--global` 写到全局',
          '`/skills [show <名字>]` — skill 索引，agent 按需读取正文',
          '`/knowledge [bind|sync]` — 记忆与 skill 的 git 同步',
        ]),
        helpSection('green-50', '🧪 联调', [
          '`/joint-debug <单号>` — 把 JIRA 单合入 devops、触发 Jenkins 部署到联调环境（8.221）并走 web 冒烟，如 `/joint-debug ANTELOPE-6747`',
        ]),
        helpSection('orange-50', '⏰ 定时任务', [
          '`/cron add <时间> | <任务>` — 新建，如 `0 9 * * 1-5`、`@daily`、`in 30m`',
          '`/cron list|show|run|pause|resume|remove` — 管理已有任务',
        ]),
        helpSection('grey-50', '⚙️ 运维与诊断', [
          '`/status` — 当前 profile、会话、工作目录、git、知识库状态',
          '`/config` — 偏好、访问控制、lark-cli 身份策略',
          '`/account` — 查看当前应用；`/account change` 换 appId/secret',
          '`/ps` · `/exit <id|#>` — 列出 / 关掉本机的 bot',
          '`/reconnect` — 强制重连（网络抖动后没反应时用）',
          `\`/doctor [描述]\` — 把日志交给 ${escapedAgentName} 自助诊断`,
        ]),
        { tag: 'hr' },
        helpButtonRow([
          { text: '📊 状态', cmd: 'status', primary: true },
          { text: '📚 知识库', cmd: 'knowledge' },
          { text: '⏰ 定时任务', cmd: 'cron.list' },
        ]),
        helpButtonRow([
          { text: '🔍 改动', cmd: 'diff' },
          { text: '📂 工作目录', cmd: 'ws.list' },
          { text: '🆕 新会话', cmd: 'new' },
        ]),
        {
          tag: 'markdown',
          content:
            "<font color='grey'>管理员专用：`/invite` `/remove` 管访问名单 · " +
            '`/stop comment:<hash>`、`/timeout comment:<hash> N` 管云文档评论任务 · ' +
            "`/coffee` 来一杯 ☕</font>",
        },
      ],
    },
  };
}

/** Fixed schema-2.0 card — same output everywhere `/coffee` is sent, unlike
 * the ad-hoc cards an agent session would otherwise improvise per-chat. */
export function coffeeCard(): object {
  return {
    schema: '2.0',
    config: { width_mode: 'default', summary: { content: '☕ Antelope 电子咖啡' } },
    header: {
      title: { tag: 'plain_text', content: '☕ Antelope 电子咖啡' },
      subtitle: { tag: 'plain_text', content: 'Antelope · 不含咖啡因,但管用' },
      template: 'orange',
      icon: { tag: 'standard_icon', token: 'gift_outlined' },
    },
    body: {
      direction: 'vertical',
      padding: '16px 16px 20px 16px',
      vertical_spacing: '10px',
      elements: [
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              padding: '24px',
              background_style: 'orange-50',
              elements: [
                { tag: 'markdown', content: '# ☕', text_align: 'center' },
                { tag: 'markdown', content: '**Antelope 电子咖啡一杯**', text_align: 'center' },
                {
                  tag: 'markdown',
                  content: "<font color='grey'>🦌 Antelope Roast · 现磨现发</font>",
                  text_align: 'center',
                  text_size: 'notation',
                },
              ],
            },
          ],
        },
        HR,
        {
          tag: 'markdown',
          content: "<font color='grey'>零卡路里 · 零等待 · 续杯免费 · 熬夜专用</font>",
        },
      ],
    },
  };
}

export interface DiffFileView {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface DiffCardView {
  scope: string;
  files: DiffFileView[];
  added: number;
  removed: number;
  untracked: string[];
  /** Inline excerpt of the patch; empty when there is nothing to show. */
  preview: string;
  omittedLines: number;
  /** True when the full patch is being sent as a separate file message. */
  attached: boolean;
}

/** Cap on files listed inline — a long list is unreadable on a phone. */
const DIFF_FILE_LIMIT = 15;

export function diffCard(view: DiffCardView): object {
  const elements: object[] = [];
  elements.push(
    divMd(`${view.scope} · **${view.files.length}** 个文件 <font color='green'>+${view.added}</font> <font color='red'>-${view.removed}</font>`),
  );

  if (view.files.length === 0 && view.untracked.length === 0) {
    elements.push(divMd('没有改动。'));
    return shell('\u{1f50d} 改动', elements);
  }

  if (view.files.length > 0) {
    elements.push(HR);
    const shown = view.files.slice(0, DIFF_FILE_LIMIT);
    elements.push(
      divMd(
        shown
          .map((f) =>
            f.binary
              ? `\`${escapeCode(f.path)}\` (二进制)`
              : `\`${escapeCode(f.path)}\` <font color='green'>+${f.added}</font> <font color='red'>-${f.removed}</font>`,
          )
          .join('\n'),
      ),
    );
    if (view.files.length > shown.length) {
      elements.push(divMd(`<font color='grey'>… 还有 ${view.files.length - shown.length} 个文件</font>`));
    }
  }

  if (view.untracked.length > 0) {
    elements.push(
      divMd(
        `<font color='grey'>未跟踪 ${view.untracked.length} 个：${view.untracked
          .slice(0, 5)
          .map((p) => escapeMd(p))
          .join('、')}${view.untracked.length > 5 ? ' …' : ''}</font>`,
      ),
    );
  }

  if (view.preview) {
    elements.push(HR);
    elements.push(divMd(`\`\`\`diff\n${escapeCode(view.preview)}\n\`\`\``));
    if (view.omittedLines > 0) {
      elements.push(
        divMd(
          `<font color='grey'>… 还有 ${view.omittedLines} 行${view.attached ? '，完整 patch 见下一条消息' : ''}</font>`,
        ),
      );
    }
  }

  return shell('\u{1f50d} 改动', elements);
}

export interface WorktreeView {
  path: string;
  branch?: string;
  head?: string;
  main: boolean;
  current: boolean;
}

export function worktreeCard(entries: WorktreeView[]): object {
  const elements: object[] = [];
  if (entries.length === 0) {
    elements.push(divMd('当前目录不是 git 仓库，或者没有可用的 worktree。'));
    return shell('\u{1f333} Worktree', elements);
  }

  entries.forEach((entry, i) => {
    const label = entry.branch ? `\`${escapeCode(entry.branch)}\`` : `游离 @ ${entry.head ?? '?'}`;
    const marks = [entry.main ? '主 checkout' : '', entry.current ? '← 当前' : ''].filter(Boolean);
    elements.push(
      divMd(`**${label}** ${marks.join(' · ')}\n\`${escapeCode(entry.path)}\``),
    );
    elements.push(
      actions([
        ...(entry.current
          ? []
          : [{ text: '切换到这里', value: { cmd: 'worktree.use', arg: entry.path }, style: 'primary' as const }]),
        ...(entry.main
          ? []
          : [{ text: '删除', value: { cmd: 'worktree.remove', arg: entry.path }, style: 'danger' as const }]),
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('\u{1f333} Worktree', elements);
}

export interface PullRequestCardView {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  checksLabel: string;
  failingChecks: string[];
  reviewLabel: string;
  mergeable?: string;
}

export function pullRequestCard(view: PullRequestCardView): object {
  const state = view.isDraft ? '草稿' : view.state === 'OPEN' ? '开放' : view.state === 'MERGED' ? '已合并' : '已关闭';
  const elements: object[] = [
    divMd(`[#${view.number} ${escapeMd(view.title)}](${view.url})`),
    divMd(
      [
        `\`${escapeCode(view.headRefName)}\` → \`${escapeCode(view.baseRefName)}\``,
        `${state}${view.author ? ` · @${escapeMd(view.author)}` : ''}`,
        `${view.changedFiles} 个文件 <font color='green'>+${view.additions}</font> <font color='red'>-${view.deletions}</font>`,
      ].join('\n'),
    ),
    HR,
    divMd(`**CI**：${view.checksLabel}\n**评审**：${view.reviewLabel}${view.mergeable === 'CONFLICTING' ? '\n**合并**：⚠️ 有冲突' : ''}`),
  ];
  if (view.failingChecks.length > 0) {
    elements.push(
      divMd(`<font color='red'>失败：${view.failingChecks.map((c) => escapeMd(c)).join('、')}</font>`),
    );
  }
  // `cmd` carries the number as its own segment: the dispatcher turns
  // `pr.123` into `/pr 123`, so the refresh button keeps pointing at this PR.
  elements.push(actions([{ text: '刷新', value: { cmd: `pr.${view.number}` }, style: 'primary' }]));

  return shell(`\u{1f500} PR #${view.number}`, elements);
}

export interface MemoryEntryView {
  id: string;
  text: string;
}

export interface MemoryCardView {
  chat: MemoryEntryView[];
  profile: MemoryEntryView[];
  /** Where the notes live on disk, so a power user can edit them directly. */
  dir: string;
}

export function memoryCard(view: MemoryCardView): object {
  const elements: object[] = [];

  const section = (title: string, entries: MemoryEntryView[], scopeHint: string): void => {
    elements.push(divMd(`**${title}**（${entries.length}）`));
    if (entries.length === 0) {
      elements.push(divMd(`<font color='grey'>暂无。${scopeHint}</font>`));
      return;
    }
    for (const entry of entries) {
      elements.push(divMd(`\`${escapeCode(entry.id)}\` ${escapeMd(entry.text)}`));
      elements.push(
        actions([{ text: '删除', value: { cmd: 'memory.forget', arg: entry.id }, style: 'danger' }]),
      );
    }
  };

  section('本会话记忆', view.chat, '用 `/memory add <内容>` 添加。');
  elements.push(HR);
  section('全局记忆', view.profile, '管理员可用 `/memory add --global <内容>` 添加。');
  elements.push(HR);
  elements.push(divMd(`<font color='grey'>存放在 \`${escapeCode(view.dir)}\`，可直接用编辑器改</font>`));

  return shell('\u{1f9e0} 记忆', elements);
}

export interface SkillView {
  name: string;
  description: string;
}

export function skillsCard(skills: SkillView[], dir: string): object {
  const elements: object[] = [];
  if (skills.length === 0) {
    elements.push(divMd('还没有 skill。'));
    elements.push(
      divMd(`在 \`${escapeCode(dir)}\` 下新建 \`<名字>/SKILL.md\` 就行，或者用 \`/knowledge bind <仓库地址>\` 从现成的仓库同步一份。`),
    );
    return shell('\u{1f9f0} Skills', elements);
  }

  elements.push(divMd(`共 **${skills.length}** 个，agent 会按需读取正文。`));
  elements.push(HR);
  for (const skill of skills) {
    elements.push(
      divMd(
        `**${escapeMd(skill.name)}**${skill.description ? `\n<font color='grey'>${escapeMd(skill.description)}</font>` : ''}`,
      ),
    );
  }
  return shell('\u{1f9f0} Skills', elements);
}

export interface KnowledgeStatusView {
  dir: string;
  chatMemories: number;
  profileMemories: number;
  skills: number;
  remote?: string;
  branch?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
}

export function knowledgeCard(view: KnowledgeStatusView): object {
  const lines = [
    `📁 **目录**：\`${escapeCode(view.dir)}\``,
    `🧠 **记忆**：本会话 ${view.chatMemories} · 全局 ${view.profileMemories}`,
    `🧰 **skills**：${view.skills}`,
  ];
  if (view.remote) {
    const divergence =
      view.ahead !== undefined && view.behind !== undefined ? ` ↑${view.ahead} ↓${view.behind}` : '';
    lines.push(`🔗 **远端**：\`${escapeCode(view.remote)}\``);
    lines.push(`🌿 **分支**：\`${escapeCode(view.branch ?? '?')}\`${divergence}${view.dirty ? ' · 有未同步改动' : ''}`);
  } else {
    lines.push("🔗 **远端**：<font color='grey'>未绑定，用 `/knowledge bind <仓库地址>` 开启同步</font>");
  }

  return shell('\u{1f4da} 知识库', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '同步', value: { cmd: 'knowledge.sync' }, style: 'primary' },
      { text: '记忆', value: { cmd: 'memory' } },
      { text: 'Skills', value: { cmd: 'skills' } },
    ]),
  ]);
}

export interface CronJobView {
  id: string;
  schedule: string;
  status: string;
  lastRun?: string;
  prompt: string;
  enabled: boolean;
}

/**
 * `/cron list` panel. Each job carries the three actions worth one tap —
 * run it now, pause/resume it, delete it — so the common edits never need
 * anyone to retype an id.
 */
export function cronCard(jobs: CronJobView[], hint: string): object {
  const elements: object[] = [];

  if (jobs.length === 0) {
    elements.push(divMd('本会话还没有定时任务。'));
    elements.push(divMd(hint));
    return shell('⏰ 定时任务', elements);
  }

  jobs.forEach((job, i) => {
    elements.push(
      divMd(`**\`${escapeCode(job.id)}\`** · ${job.schedule}\n${job.status}`),
    );
    elements.push(divMd(escapeMd(job.prompt)));
    if (job.lastRun) elements.push(divMd(`<font color='grey'>${escapeMd(job.lastRun)}</font>`));
    elements.push(
      actions([
        { text: '立即运行', value: { cmd: 'cron.run', arg: job.id }, style: 'primary' },
        job.enabled
          ? { text: '暂停', value: { cmd: 'cron.pause', arg: job.id } }
          : { text: '恢复', value: { cmd: 'cron.resume', arg: job.id } },
        { text: '删除', value: { cmd: 'cron.remove', arg: job.id }, style: 'danger' },
      ]),
    );
    if (i < jobs.length - 1) elements.push(HR);
  });

  return shell('⏰ 定时任务', elements);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
