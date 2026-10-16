/**
 * Language of the bridge's own words on a run's reply (footer, buttons,
 * notices). Follows the rule the agent is given for its answers: Chinese by
 * default and whenever the caller wrote any Chinese; English for a caller who
 * wrote only in another language — the agent answers those in their own
 * language, and English is the bridge chrome closest to that for everyone.
 */
export type Locale = 'zh' | 'en';

const HAN = /\p{Script=Han}/u;
const LETTER = /\p{L}/u;

export function detectLocale(texts: readonly string[]): Locale {
  const joined = texts.join('\n');
  if (HAN.test(joined)) return 'zh';
  return LETTER.test(joined) ? 'en' : 'zh';
}

export interface RunStrings {
  thinking: string;
  toolRunning: string;
  /** Footer label for a running tool: `查日志（Bash）`. */
  toolLabel(description: string, tool: string): string;
  /** Footer label when there is no usable description: `正在调用 Bash`. */
  toolRunningNamed(tool: string): string;
  /** A subagent's current step under the tool that started it. */
  subagentStep(label: string, step: string): string;
  streaming: string;
  elapsed(clock: string): string;
  lastActivity(ago: string): string;
  quietFor(minutes: number): string;
  secondsAgo(n: number): string;
  minutesAgo(n: number): string;
  stop: string;
  /** Label of a code block's copy button; `index` is 1-based, absent when the answer has one block. */
  copyCode(index?: number, lang?: string): string;
  stopConfirmTitle: string;
  stopConfirmText: string;
  interrupted: string;
  idleTimeout(minutes: number): string;
  agentFailed(message: string): string;
  noContent: string;
  noOutput: string;
  toolRunningBody: string;
  reasoningActive: string;
  reasoningDone: string;
  toolCalls(n: number, finished: boolean): string;
  summary: {
    interrupted: string;
    idleTimeout: string;
    paused: string;
    error: string;
    done: string;
    toolRunning: string;
    streaming: string;
    thinking: string;
  };
  trimmedRunning: string;
  trimmedFinal: string;
  cardBroken(code: string): string;
  pointer(code: string): string;
  resumedNote(at: string): string;
  paused(label: string, reset: string | undefined): string;
  autoResumeAt(at: string): string;
  resumeManually: string;
  limitLabels: Record<string, string>;
  limitFallback: string;
  autoResumePrompt(label: string): string;
  interruptReasons: Record<'killed' | 'restart' | 'shutdown', string>;
  interruptedResumePrompt(reason: string, ledger: string): string;
  /** Told in the chat right after a run with a ledger died. */
  interruptedWillResume(reason: string, at: string): string;
}

const zh: RunStrings = {
  thinking: '🧠 正在思考',
  toolRunning: '🧰 正在调用工具',
  toolLabel: (description, tool) => `${description}（${tool}）`,
  toolRunningNamed: (tool) => `正在调用 ${tool}`,
  subagentStep: (label, step) => `${label} › 子任务：${step}`,
  streaming: '✍️ 正在输出',
  elapsed: (clock) => `已运行 ${clock}`,
  lastActivity: (ago) => `上次动静 ${ago}`,
  quietFor: (m) => `已 ${m} 分钟没有新动静`,
  secondsAgo: (n) => `${n} 秒前`,
  minutesAgo: (n) => `${n} 分钟前`,
  stop: '⏹ 终止',
  copyCode: (i, lang) => `📋 复制${i ? ` #${i}` : '代码'}${lang ? ` ${lang.toUpperCase()}` : ''}`,
  stopConfirmTitle: '终止这个任务？',
  stopConfirmText: '任务和它启动的命令都会被结束，无法恢复。',
  interrupted: '_⏹ 已被中断_',
  idleTimeout: (m) => `_⏱ ${m} 分钟无响应,已自动终止_`,
  agentFailed: (msg) => `⚠️ agent 失败：${msg}`,
  noContent: '_（未返回内容）_',
  noOutput: '_无输出_',
  toolRunningBody: '_运行中…_',
  reasoningActive: '🧠 **思考中**',
  reasoningDone: '🧠 **思考完成，点击查看**',
  toolCalls: (n, finished) => `☕ **${n} 个工具调用${finished ? '（已结束）' : ''}**`,
  summary: {
    interrupted: '已中断',
    idleTimeout: '已超时',
    paused: '额度用完，已暂停',
    error: '出错',
    done: '已完成',
    toolRunning: '正在调用工具',
    streaming: '正在输出',
    thinking: '思考中',
  },
  trimmedRunning: '_（内容较长，卡片里只保留最新部分，完整内容会在结束后另发）_',
  trimmedFinal: '_（内容超出卡片上限，这里只保留结尾，完整内容见下一条消息）_',
  cardBroken: (code) =>
    `⚠️ 进度卡片更新不了了（飞书错误 ${code}），任务还在继续。卡片恢复不了的话，结束后结果会另发一条消息。`,
  pointer: (code) => `_卡片更新失败（飞书错误 ${code}），完整回复见下一条消息。_`,
  resumedNote: (at) => `▶️ **已于 ${at} 自动继续**，见下方新卡片。`,
  paused: (label, reset) => `⏸ **任务暂停**：Claude ${label}已用完${reset ? `（${reset} 重置）` : ''}。`,
  autoResumeAt: (at) =>
    `将在 **${at}** 自动继续，届时新开一张卡片接着做；发 \`/stop\` 可以取消自动续跑。`,
  resumeManually: '额度重置后发「继续」，我会从中断的地方接着做。',
  limitLabels: {
    five_hour: '5 小时额度',
    seven_day: '本周额度',
    seven_day_opus: '本周 Opus 额度',
    seven_day_sonnet: '本周 Sonnet 额度',
    seven_day_overage_included: '本周额度（含超额）',
    overage: '超额用量',
  },
  limitFallback: 'Claude 额度',
  autoResumePrompt: (label) =>
    `[自动续跑] 上一轮任务因 Claude ${label}用完而暂停，额度已经重置。` +
    '请从中断的地方继续完成原任务，不要重复已经完成的步骤；如果原任务其实已经完成，简短说明即可。',
  interruptReasons: { killed: '进程被终止', restart: 'bridge 重启', shutdown: 'bridge 关闭' },
  interruptedResumePrompt: (reason, ledger) =>
    `[自动续跑] 上一轮任务意外中断（${reason}）。请先读任务台账 ${ledger}，再用 git log 核对实际进度，` +
    '从台账的「下一步」继续；已经完成并提交的部分不要重做。',
  interruptedWillResume: (reason, at) =>
    `⏯ 任务意外中断（${reason}）。将在 **${at}** 按任务台账自动继续，届时新开一张卡片接着做；发 \`/stop\` 可以取消。`,
};

const en: RunStrings = {
  thinking: '🧠 Thinking',
  toolRunning: '🧰 Running a tool',
  toolLabel: (description, tool) => `${description} (${tool})`,
  toolRunningNamed: (tool) => `Running ${tool}`,
  subagentStep: (label, step) => `${label} › subtask: ${step}`,
  streaming: '✍️ Writing',
  elapsed: (clock) => `running ${clock}`,
  lastActivity: (ago) => `last activity ${ago}`,
  quietFor: (m) => `no activity for ${m} min`,
  secondsAgo: (n) => `${n}s ago`,
  minutesAgo: (n) => `${n} min ago`,
  stop: '⏹ Stop',
  copyCode: (i, lang) => `📋 Copy${i ? ` #${i}` : ' code'}${lang ? ` ${lang.toUpperCase()}` : ''}`,
  stopConfirmTitle: 'Stop this task?',
  stopConfirmText: 'The task and every command it started will be ended. This cannot be undone.',
  interrupted: '_⏹ Stopped_',
  idleTimeout: (m) => `_⏱ No response for ${m} min, stopped automatically_`,
  agentFailed: (msg) => `⚠️ Agent failed: ${msg}`,
  noContent: '_(no content)_',
  noOutput: '_no output_',
  toolRunningBody: '_running…_',
  reasoningActive: '🧠 **Thinking**',
  reasoningDone: '🧠 **Reasoning (click to expand)**',
  toolCalls: (n, finished) => `☕ **${n} tool call${n === 1 ? '' : 's'}${finished ? ' (finished)' : ''}**`,
  summary: {
    interrupted: 'Stopped',
    idleTimeout: 'Timed out',
    paused: 'Paused: quota used up',
    error: 'Failed',
    done: 'Done',
    toolRunning: 'Running a tool',
    streaming: 'Writing',
    thinking: 'Thinking',
  },
  trimmedRunning: '_(Long output: the card keeps only the latest part; the full text follows when done.)_',
  trimmedFinal: '_(Too long for a card: only the end is shown here; the full text is in the next message.)_',
  cardBroken: (code) =>
    `⚠️ The progress card can no longer be updated (Feishu error ${code}). The task is still running; if the card doesn't recover, the result will follow as a separate message.`,
  pointer: (code) => `_The card could not be updated (Feishu error ${code}); the full reply is in the next message._`,
  resumedNote: (at) => `▶️ **Resumed automatically at ${at}**, see the new card below.`,
  paused: (label, reset) => `⏸ **Task paused**: the Claude ${label} is used up${reset ? ` (resets ${reset})` : ''}.`,
  autoResumeAt: (at) =>
    `It will resume automatically at **${at}** in a new card; send \`/stop\` to cancel.`,
  resumeManually: 'Once the quota resets, say "continue" and I will pick up where I stopped.',
  limitLabels: {
    five_hour: '5-hour quota',
    seven_day: 'weekly quota',
    seven_day_opus: 'weekly Opus quota',
    seven_day_sonnet: 'weekly Sonnet quota',
    seven_day_overage_included: 'weekly quota (incl. overage)',
    overage: 'overage allowance',
  },
  limitFallback: 'quota',
  autoResumePrompt: (label) =>
    `[auto-resume] The previous task paused because the Claude ${label} was used up; it has reset now. ` +
    'Continue the original task from where it stopped without repeating finished steps; if it is actually done, just say so briefly.',
  interruptReasons: { killed: 'the process was killed', restart: 'the bridge restarted', shutdown: 'the bridge shut down' },
  interruptedResumePrompt: (reason, ledger) =>
    `[auto-resume] The previous run was interrupted (${reason}). Read the task ledger ${ledger}, check the real progress ` +
    'with git log, and continue from its next step; do not redo work that is already done and committed.',
  interruptedWillResume: (reason, at) =>
    `⏯ The task was interrupted (${reason}). It will resume from its task ledger at **${at}** in a new card; send \`/stop\` to cancel.`,
};

const TABLE: Record<Locale, RunStrings> = { zh, en };

/** `10-02 23:40`, in the bridge host's local time. */
export function formatMoment(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function runStrings(locale: Locale | undefined): RunStrings {
  return TABLE[locale ?? 'zh'];
}
