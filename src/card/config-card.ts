import { agentDescriptor } from '../agent/registry';
import { modelLabel, supportedEfforts, supportedModels } from '../agent/models';
import type { KnownChat } from '../bot/lark-info';
import type { AgentKind, LarkCliIdentityPreset, ProfileMode } from '../config/profile-schema';
import { EFFORT_LEVEL_LABELS, type CotMessagesMode, type EffortLevel, type MessageReplyMode } from '../config/schema';

export interface ConfigFormOpts {
  /** Profile's agent kind — decides which model catalog the picker shows. */
  agentKind: AgentKind;
  /** Deployment mode: 'personal' (default) or 'team'. */
  mode: ProfileMode;
  /** Current model selection (a value from {@link supportedModels}). */
  model: string;
  /** Current effort level, or `undefined` for "follow the CLI default". Options come from the profile's agent kind. */
  effort: EffortLevel | undefined;
  messageReply: MessageReplyMode;
  showToolCalls: boolean;
  cotMessages: CotMessagesMode;
  maxConcurrentRuns: number;
  /** 0 means "disabled". */
  runIdleTimeoutMinutes: number;
  requireMentionInGroup: boolean;
  larkCliIdentity: LarkCliIdentityPreset;
  /** Whether non-admins' side-effecting steps wait for an admin's approval (#6). */
  approvalsEnabled: boolean;
  /** 会话智能压缩 on/off. Optional so callers predating the switch render it as off. */
  smartSession?: boolean;
  autoWorktreeCleanup?: boolean;
  /** 课堂精练 on/off. Optional so callers predating the switch render it as off. */
  dream?: boolean;
  /** 自动整理 on/off (only acts with {@link dream} on). */
  dreamAuto?: boolean;
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  /** Groups the bot is in right now; empty when the lookup failed. */
  knownChats: KnownChat[];
  /** Per-chat @ override (`access.chatRequireMention`); absent = follows the global switch. */
  chatRequireMention?: Record<string, boolean>;
  /** Per-chat member allowlist (`access.chatAllowedUsers`); absent = everyone in the chat. */
  chatAllowedUsers?: Record<string, string[]>;
  /** URL of the running local web console (supervisor `--web-ui` mode). Shown
   * at the top of the card when present; omitted when no console is running. */
  consoleUrl?: string;
}

function collapsedAccessPanel(title: string, elements: object[]): object {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: title },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '16px 16px',
      },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements,
  };
}

/**
 * Tinted "section card" wrapping a group of form fields — same column_set
 * pattern the submit buttons already use inside the form, so interactive
 * children (select/input) remain collected by form submit.
 */
function sectionBlock(background: string, elements: object[]): object {
  return {
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        padding: '10px 12px 12px 12px',
        background_style: background,
        vertical_spacing: '8px',
        elements,
      },
    ],
  };
}

function atMentionLine(openIds: string[]): string {
  if (openIds.length === 0) return '_（暂无）_';
  return openIds.map((id) => `<at id="${id}"></at>`).join('  ');
}

function chatLabel(id: string, name: string | undefined): string {
  return `**${name ?? '(未知群)'}**（...${id.slice(-6)}）`;
}

function mentionRuleLabel(override: boolean | undefined, globalRequire: boolean): string {
  if (override === undefined) return `跟随全局（${globalRequire ? '需 @' : '无需 @'}）`;
  return override ? '需 @' : '无需 @';
}

function memberRuleLabel(members: string[] | undefined): string {
  if (members === undefined) return '群内所有人可用';
  if (members.length === 0) return '仅管理员可用';
  return `仅指定成员（${members.length}）：${atMentionLine(members)}`;
}

/**
 * Every group the bot touches, split by how it is handled: answered (on the
 * allowlist and the bot is in it), joined but not answered, and allowlisted
 * after the bot has left. Membership comes from `knownChats`; when that lookup
 * came back empty we can't tell joined from left, so only the allowlist shows.
 */
function groupPanel(opts: ConfigFormOpts): object {
  const membershipKnown = opts.knownChats.length > 0;
  const names = new Map(opts.knownChats.map((chat) => [chat.id, chat.name]));
  const allowed = new Set(opts.allowedChats);
  const answered = opts.allowedChats.filter((id) => !membershipKnown || names.has(id));
  const idle = opts.knownChats.filter((chat) => !allowed.has(chat.id));
  const left = membershipKnown ? opts.allowedChats.filter((id) => !names.has(id)) : [];
  const mentionOverrides = opts.chatRequireMention ?? {};
  const memberLists = opts.chatAllowedUsers ?? {};

  const title = membershipKnown
    ? `👥 **群管理**（bot 在 ${opts.knownChats.length} 个群，响应 ${answered.length} 个 · 点击展开）`
    : `👥 **群管理**（响应 ${answered.length} 个 · 点击展开）`;

  const notes: string[] = [];
  if (opts.mode === 'team') {
    notes.push('_⚠️ 团队版已开启：任何群里 @ bot 都会响应，下面的名单和成员限制暂不生效；切回个人版后恢复。_');
  }
  if (!membershipKnown) {
    notes.push('_⚠️ bot 所在的群列表为空（bot 不在任何群，或飞书接口没取到），下面只列响应名单，看不出 bot 是否还在群里。_');
  }

  const sections: string[] = [
    `**响应中**（${answered.length}）\n` +
      (answered.length === 0
        ? '_（暂无）_'
        : answered
            .map(
              (id) =>
                `- ${chatLabel(id, names.get(id))}\n` +
                `  ${mentionRuleLabel(mentionOverrides[id], opts.requireMentionInGroup)} · ${memberRuleLabel(memberLists[id])}`,
            )
            .join('\n')),
  ];
  if (idle.length > 0) {
    sections.push(
      `**在群里但不响应**（${idle.length}）\n` +
        idle.map((chat) => `- ${chatLabel(chat.id, chat.name)}`).join('\n') +
        '\n_在该群发 `/invite group` 开启；私聊发 `/invite all group` 一键全部开启。_',
    );
  }
  if (left.length > 0) {
    sections.push(
      `**名单里但 bot 已不在群**（${left.length}）\n` +
        left.map((id) => `- ${chatLabel(id, undefined)}`).join('\n') +
        '\n_bot 被拉回群后自动恢复响应；不再需要的私聊发 `/remove group <ID 末 6 位>` 移除。_',
    );
  }

  const howTo =
    '**管理方式**（在目标群里发）\n' +
    '- `/invite group`：开启该群，群内所有人可用\n' +
    '- `/invite group restricted @某人…`：开启该群，只对指定成员生效\n' +
    '- `/invite member @某人` / `/remove member @某人`：增删该群的指定成员\n' +
    '- `/remove group`：停止响应该群；私聊里发 `/remove group <ID 末 6 位>` 按 ID 移除\n' +
    '_管理员在任何已开启的群里都可用。' +
    (opts.consoleUrl
      ? '单个群的「是否需要 @」在 Web 控制台里设置。_'
      : '单个群的「是否需要 @」暂无群内命令，改配置文件里的 `access.chatRequireMention`。_');

  const elements: object[] = [];
  for (const note of notes) elements.push({ tag: 'markdown', content: note });
  for (const section of sections) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: section });
  }
  elements.push({ tag: 'hr' }, { tag: 'markdown', content: howTo });
  return collapsedAccessPanel(title, elements);
}

/** Form card for `/config`. */
export function configFormCard(opts: ConfigFormOpts): object {
  const teamMode = opts.mode === 'team';
  const teamOverrideNote =
    '\n\n_⚠️ 团队版已开启：本项被覆盖 —— 身份强制为「只允许应用身份」、访问控制不生效。切回个人版后恢复。_';
  const accessElements: object[] = [
    ...(teamMode
      ? [
          {
            tag: 'markdown',
            content:
              '_⚠️ **团队版已开启**：访问控制暂不生效 —— 任何人 @ bot 都能使用（管理命令仍限 owner/管理员）。切回个人版后以下白名单恢复生效。_',
          },
          { tag: 'hr' },
        ]
      : []),
    {
      tag: 'markdown',
      content: '_控制谁能通过私聊和群聊使用 bot。**留空 = 不响应聊天消息**。云文档评论按文档权限生效。_',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**允许私聊的用户**（共 ${opts.allowedUsers.length} 人）\n` +
        `${atMentionLine(opts.allowedUsers)}\n\n` +
        '_加 / 删：_ `/invite user @某人`  `/remove user @某人`',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**允许响应的群**（共 ${opts.allowedChats.length} 个）\n` +
        '_每个群的 @ 规则、成员限制和管理方式见下方「👥 群管理」。_',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**管理员**（共 ${opts.admins.length} 人）\n` +
        `${atMentionLine(opts.admins)}\n\n` +
        '_可以跑敏感命令：`/account` `/config` `/exit` `/reconnect` `/doctor` `/cd` `/ws` `/invite` `/remove`。管理员也自动获得私聊权限，并可在未白名单群里管理访问控制。_\n\n' +
        '_加 / 删：_ `/invite admin @某人`  `/remove admin @某人`',
    },
  ];

  return {
    schema: '2.0',
    config: { summary: { content: '偏好设置' } },
    header: {
      title: { tag: 'plain_text', content: '偏好设置' },
      subtitle: { tag: 'plain_text', content: '写入当前 profile · 提交后立即生效' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'setting_outlined' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 16px 12px',
      vertical_spacing: '8px',
      elements: [
        ...(opts.consoleUrl
          ? [
              {
                tag: 'markdown',
                content: `🖥️ Web 控制台（本机）：[${opts.consoleUrl}](${opts.consoleUrl})`,
              },
              { tag: 'hr' },
            ]
          : []),
        {
          tag: 'form',
          name: 'config_form',
          elements: [
            sectionBlock('blue-50', [
              { tag: 'markdown', content: '🧠 **模型与推理**' },
              {
                tag: 'markdown',
                content:
                  '**运行模式**\n' +
                  '<font color="grey">个人版=仅白名单可用、可带个人授权；团队版=任何人 @ 可用、强制应用身份</font>',
              },
              {
                tag: 'select_static',
                name: 'deploy_mode',
                initial_option: opts.mode,
                options: [
                  { text: { tag: 'plain_text', content: '个人版(默认)' }, value: 'personal' },
                  { text: { tag: 'plain_text', content: '团队版' }, value: 'team' },
                ],
              },
              {
                tag: 'markdown',
                content:
                  '**模型**\n<font color="grey">「跟随默认」= 不指定，由 CLI/账号决定；「始终最新」由 CLI 自动解析到当前最新版本</font>',
              },
              {
                tag: 'select_static',
                name: 'model',
                initial_option: opts.model,
                options: supportedModels(opts.agentKind, opts.model).map((m) => ({
                  text: { tag: 'plain_text', content: m.label },
                  value: m.value,
                })),
              },
              {
                tag: 'markdown',
                content:
                  '**Effort（推理强度）**\n<font color="grey">越高越慢越贵；' +
                  agentDescriptor(opts.agentKind).effortDefaultHint +
                  '</font>',
              },
              {
                tag: 'select_static',
                name: 'effort',
                initial_option: opts.effort && supportedEfforts(opts.agentKind).includes(opts.effort) ? opts.effort : '',
                options: [
                  { text: { tag: 'plain_text', content: '跟随默认' }, value: '' },
                  ...supportedEfforts(opts.agentKind).map((level) => ({
                    text: { tag: 'plain_text', content: EFFORT_LEVEL_LABELS[level] },
                    value: level,
                  })),
                ],
              },
            ]),
            sectionBlock('turquoise-50', [
              { tag: 'markdown', content: '💬 **消息展示**' },
              {
                tag: 'markdown',
                content:
                  '**消息回复方式**\n' +
                  '<font color="grey">纯文本=跑完一次性发 / 消息卡片=流式 markdown / 交互卡片=带工具面板与 ⏹ 停止按钮</font>',
              },
              {
                tag: 'select_static',
                name: 'message_reply',
                initial_option: opts.messageReply,
                options: [
                  { text: { tag: 'plain_text', content: '纯文本' }, value: 'text' },
                  { text: { tag: 'plain_text', content: '消息卡片(默认)' }, value: 'markdown' },
                  { text: { tag: 'plain_text', content: '交互卡片' }, value: 'card' },
                ],
              },
              {
                tag: 'markdown',
                content:
                  '**工具调用显示**\n<font color="grey">是否展示 bot 跑的命令、读写的文件等过程块</font>',
              },
              {
                tag: 'select_static',
                name: 'show_tool_calls',
                initial_option: opts.showToolCalls ? 'show' : 'hide',
                options: [
                  { text: { tag: 'plain_text', content: '显示(默认)' }, value: 'show' },
                  { text: { tag: 'plain_text', content: '隐藏' }, value: 'hide' },
                ],
              },
              {
                tag: 'markdown',
                content:
                  '**COT 过程消息**\n<font color="grey">关闭=只发最终回复 / 简略=过程文本+工具摘要 / 详细=含参数与输出摘要</font>',
              },
              {
                tag: 'select_static',
                name: 'cot_messages',
                initial_option: opts.cotMessages,
                options: [
                  { text: { tag: 'plain_text', content: '关闭' }, value: 'off' },
                  { text: { tag: 'plain_text', content: '简略' }, value: 'brief' },
                  { text: { tag: 'plain_text', content: '详细' }, value: 'detailed' },
                ],
              },
            ]),
            sectionBlock('violet-50', [
              { tag: 'markdown', content: '⚙️ **运行与权限**' },
              {
                tag: 'markdown',
                content:
                  '**并发上限**（1–50，默认 10）\n<font color="grey">全局同时运行的 agent 数，超出 FIFO 排队</font>',
              },
              {
                tag: 'input',
                name: 'max_concurrent_runs',
                default_value: String(opts.maxConcurrentRuns),
                placeholder: { tag: 'plain_text', content: '10（范围 1-50）' },
                input_type: 'text',
              },
              {
                tag: 'markdown',
                content:
                  '**run 探活**（分钟，0=关闭，1–120）\n<font color="grey">agent 长时间无输出自动 kill；可被 /timeout 按 scope 覆盖</font>',
              },
              {
                tag: 'input',
                name: 'run_idle_timeout_minutes',
                default_value: String(opts.runIdleTimeoutMinutes),
                placeholder: { tag: 'plain_text', content: '0（关闭）' },
                input_type: 'text',
              },
              {
                tag: 'markdown',
                content:
                  '**群里需要 @ bot**\n<font color="grey">是=群内仅 @ 触发；否=群内任意消息都触发。私聊永远不需要 @，@全员 永远不响应</font>',
              },
              {
                tag: 'select_static',
                name: 'require_mention_in_group',
                initial_option: opts.requireMentionInGroup ? 'yes' : 'no',
                options: [
                  { text: { tag: 'plain_text', content: '是(默认)' }, value: 'yes' },
                  { text: { tag: 'plain_text', content: '否' }, value: 'no' },
                ],
              },
              {
                tag: 'markdown',
                content:
                  '**非管理员操作审批**\n<font color="grey">开=非管理员让 bot 跑命令、写文件、调外部工具前，先发卡片给管理员审批；免审批清单在配置文件 approvals 段</font>',
              },
              {
                tag: 'select_static',
                name: 'approvals_enabled',
                initial_option: opts.approvalsEnabled ? 'on' : 'off',
                options: [
                  { text: { tag: 'plain_text', content: '开' }, value: 'on' },
                  { text: { tag: 'plain_text', content: '关(默认)' }, value: 'off' },
                ],
              },
              {
                tag: 'markdown',
                content:
                  '**会话智能压缩**\n<font color="grey">开=空闲超 1 小时且上下文超 15 万 token、或空闲超 8 小时，下一条消息自动开新会话；agent 判断事情做完也会收尾；长会话提前自动压缩。旧会话 /resume 可找回</font>',
              },
              {
                tag: 'select_static',
                name: 'smart_session',
                initial_option: opts.smartSession ? 'on' : 'off',
                options: [
                  { text: { tag: 'plain_text', content: '开' }, value: 'on' },
                  { text: { tag: 'plain_text', content: '关(默认)' }, value: 'off' },
                ],
              },
              {
                tag: 'markdown',
                content: '**Worktree 自动清理**\n<font color="grey">每小时检查 bridge 创建的 worktree；默认闲置 7 天、分支已合入主工作区且无会话引用才清理。改动、未跟踪/忽略文件、锁定目录会保留。只删除 bridge 新建的分支；天数可在配置文件调整</font>',
              },
              {
                tag: 'select_static',
                name: 'auto_worktree_cleanup',
                initial_option: opts.autoWorktreeCleanup ? 'on' : 'off',
                options: [
                  { text: { tag: 'plain_text', content: '开' }, value: 'on' },
                  { text: { tag: 'plain_text', content: '关(默认)' }, value: 'off' },
                ],
              },
              {
                tag: 'markdown',
                content:
                  '**课堂精练**\n<font color="grey">开=管理员可用 /dream run 把已结束的会话整理成记忆 / 笔记 / skill 草稿，以 Draft PR 提交到知识库和自有 skill 库，审核合并后才生效；不推送日报</font>',
              },
              {
                tag: 'select_static',
                name: 'dream',
                initial_option: opts.dream ? 'on' : 'off',
                options: [
                  { text: { tag: 'plain_text', content: '开' }, value: 'on' },
                  { text: { tag: 'plain_text', content: '关(默认)' }, value: 'off' },
                ],
              },
              {
                tag: 'markdown',
                content:
                  '**自动整理**\n<font color="grey">需先开课堂精练。不按天跑：新内容攒够、距上次够久、上一批 PR 审完、在允许时段且 bot 空闲时才自己整理一轮，有用户消息就让路；条件在配置文件 dreamTuning 里调</font>',
              },
              {
                tag: 'select_static',
                name: 'dream_auto',
                initial_option: opts.dreamAuto ? 'on' : 'off',
                options: [
                  { text: { tag: 'plain_text', content: '开' }, value: 'on' },
                  { text: { tag: 'plain_text', content: '关(默认)' }, value: 'off' },
                ],
              },
              {
                tag: 'markdown',
                content:
                  '**lark-cli 身份策略**\n<font color="grey">只允许应用身份=不碰个人资源；允许用户身份=可用已授权的个人日历/邮箱/云盘</font>' +
                  (teamMode ? teamOverrideNote : ''),
              },
              {
                tag: 'select_static',
                name: 'lark_cli_identity',
                initial_option: opts.larkCliIdentity,
                options: [
                  { text: { tag: 'plain_text', content: '只允许应用身份' }, value: 'bot-only' },
                  { text: { tag: 'plain_text', content: '允许用户身份' }, value: 'user-default' },
                ],
              },
            ]),
            collapsedAccessPanel('🔒 **访问控制**（点击展开）', accessElements),
            groupPanel(opts),
            {
              tag: 'column_set',
              flex_mode: 'flow',
              horizontal_spacing: 'small',
              columns: [
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'submit_btn',
                      text: { tag: 'plain_text', content: '提交' },
                      type: 'primary',
                      form_action_type: 'submit',
                      behaviors: [{ type: 'callback', value: { cmd: 'config.submit' } }],
                    },
                  ],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'cancel_btn',
                      text: { tag: 'plain_text', content: '取消' },
                      behaviors: [{ type: 'callback', value: { cmd: 'config.cancel' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

export function configSavedCard(opts: ConfigFormOpts): object {
  const replyLabel =
    opts.messageReply === 'card'
      ? '交互卡片'
      : opts.messageReply === 'markdown'
        ? '消息卡片'
        : '纯文本';
  const summarize = (list: string[]): string =>
    list.length === 0 ? '无' : `${list.length} 项`;
  const cotLabel = cotMessagesLabel(opts.cotMessages);
  const kvBlock = (title: string, rows: [string, string][]): object => ({
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        padding: '8px 10px',
        background_style: 'grey-50',
        elements: [
          {
            tag: 'markdown',
            content:
              `${title}\n` + rows.map(([k, v]) => `${k}：**${v}**`).join('\n'),
          },
        ],
      },
    ],
  });
  return {
    schema: '2.0',
    config: { summary: { content: '偏好已保存' } },
    header: {
      title: { tag: 'plain_text', content: '偏好已保存' },
      subtitle: { tag: 'plain_text', content: '下条消息开始生效' },
      template: 'green',
      icon: { tag: 'standard_icon', token: 'done_outlined' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 16px 12px',
      vertical_spacing: '8px',
      elements: [
        kvBlock('🧠 **模型与推理**', [
          ['运行模式', opts.mode === 'team' ? '团队版' : '个人版'],
          ['模型', modelLabel(opts.agentKind, opts.model)],
          [
            'Effort',
            opts.effort && supportedEfforts(opts.agentKind).includes(opts.effort)
              ? EFFORT_LEVEL_LABELS[opts.effort]
              : '跟随默认',
          ],
        ]),
        kvBlock('💬 **消息展示**', [
          ['消息回复方式', replyLabel],
          ['工具调用显示', opts.showToolCalls ? '显示' : '隐藏'],
          ['COT 过程消息', cotLabel],
        ]),
        kvBlock('⚙️ **运行与权限**', [
          ['并发上限', String(opts.maxConcurrentRuns)],
          ['run 探活', opts.runIdleTimeoutMinutes > 0 ? `${opts.runIdleTimeoutMinutes} 分钟` : '关闭'],
          ['群里需要 @ bot', opts.requireMentionInGroup ? '是' : '否'],
          ['非管理员审批', opts.approvalsEnabled ? '开' : '关'],
          ['会话智能压缩', opts.smartSession ? '开' : '关'],
          ['Worktree 自动清理', opts.autoWorktreeCleanup ? '开' : '关'],
          ['课堂精练', opts.dream ? '开' : '关'],
          ['自动整理', opts.dreamAuto ? (opts.dream ? '开' : '开（课堂精练关着，不生效）') : '关'],
          [
            'lark-cli 身份策略',
            opts.mode === 'team'
              ? '只允许应用身份(团队版强制)'
              : opts.larkCliIdentity === 'user-default'
                ? '允许用户身份'
                : '只允许应用身份',
          ],
        ]),
        kvBlock(
          '🔒 **访问控制**' + (opts.mode === 'team' ? '（团队版下不生效）' : ''),
          [
            ['允许私聊的用户', summarize(opts.allowedUsers)],
            ['允许响应的群', summarize(opts.allowedChats)],
            ['管理员', summarize(opts.admins)],
          ],
        ),
      ],
    },
  };
}

function cotMessagesLabel(value: CotMessagesMode): string {
  if (value === 'brief') return '简略';
  if (value === 'detailed') return '详细';
  return '关闭';
}

/**
 * Shown after `/config` saves "群里不需要 @ bot" but the app is missing the
 * `im:message.group_msg` scope. Guides the user through one-click incremental
 * authorization via the link from `requestScopeGrantLink`.
 */
export function groupMsgScopeGrantCard(url: string, expireMins: number): object {
  return {
    schema: '2.0',
    config: { summary: { content: '需要补授权' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '⚠️ **「群里不需要 @ bot」还差一个权限**\n\n' +
            '你已开启「不 @ bot 也回复」，但当前应用没有 **获取群组中所有消息**（`im:message.group_msg`）权限。' +
            '没有它，飞书不会把群里非 @ 的消息推给 bot，所以这个设置暂时不生效。\n\n' +
            `**点下面的链接补授权**（约 ${expireMins} 分钟内有效）：\n` +
            `[🔗 点此一键授权](${url})\n\n` +
            '_扫码/点击后会进入确认页，新权限已预填好，确认即可。授权成功后，群里新消息开始自动生效，无需重启。_\n' +
            `_若链接打不开，可复制：_\n\`${url}\`\n\n` +
            '_授权后若群里仍收不到非 @ 消息，发 `/reconnect` 重连一次即可。_',
        },
      ],
    },
  };
}

/** Replaces {@link groupMsgScopeGrantCard} in place once authorization completes. */
export function groupMsgScopeGrantedCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '授权成功' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **授权成功**\n\n' +
            '`im:message.group_msg` 权限已生效，群里非 @ bot 的消息从现在开始会触发回复。\n\n' +
            '_若仍未生效，发 `/reconnect` 重连一次。_',
        },
      ],
    },
  };
}

export function configCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: {
      elements: [{ tag: 'markdown', content: '已取消,未做任何修改。' }],
    },
  };
}

export function configFailedCard(reason: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '保存失败' } },
    body: {
      elements: [{ tag: 'markdown', content: `保存失败：${reason}` }],
    },
  };
}
