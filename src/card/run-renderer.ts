import { deepMaskEmails } from './mask-email';
import { pauseNotice } from './pause-notice';
import type { Block, FooterStatus, RunState, Terminal, ToolEntry } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';

const REASONING_MAX = 1500;
const COLLAPSE_TOOL_THRESHOLD = 3;

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

/**
 * Identity shown in the card's header bar and footer byline. Optional so the
 * command cards (`/doctor`) can keep rendering a bare body.
 */
export interface RunCardMeta {
  /** Header bar title — the bot's own IM name, e.g. `CC`. */
  title: string;
  agent?: string;
  model?: string;
  /** Reasoning effort, omitted when the profile leaves it at the CLI default. */
  effort?: string;
  provider?: string;
  /** Account paying for the run, e.g. the logged-in Claude account name. */
  sponsor?: string;
}

export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
  meta?: RunCardMeta;
  /** Live clock for the running footer. See {@link RunActivity}. */
  activity?: RunActivity;
}

/**
 * How long the run has been going and how long since the agent last did
 * anything. The bridge re-renders the card with a fresh one on a timer, so a
 * footer that keeps ticking proves the bridge and the card are alive even
 * while the agent is quiet inside a long tool call — and a frozen one means
 * they are not.
 */
export interface RunActivity {
  elapsedMs: number;
  idleMs: number;
  /** What the in-flight tool is doing, e.g. `查 bridge 日志（Bash）`. */
  toolLabel?: string;
}

/** Quiet this long and the footer turns into a warning. */
export const STALL_WARN_MS = 3 * 60_000;

export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  const elements: object[] = [];

  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        elements.push(markdown(group.content));
      }
    } else {
      elements.push(...renderToolGroup(group.tools, state.terminal !== 'running'));
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'paused') {
    elements.push(markdown(pauseNotice(state.limit)));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state.footer, options.activity));
    elements.push(stopButton(options));
  } else {
    elements.push(...byline(options.meta));
  }

  // Mask raw emails across every text field so the Feishu tenant audit doesn't
  // reject the (streamed) card with a 400 EMAIL_ADDRESS — see mask-email.ts.
  return deepMaskEmails({
    schema: '2.0',
    config: {
      // `fill` widens the card to the chat column; without it long answers get
      // squeezed into a narrow strip on desktop.
      width_mode: 'fill',
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    ...(options.meta ? { header: cardHeader(options.meta.title, state.terminal) } : {}),
    body: { elements },
  });
}

/** Coloured title bar: wathet while healthy, red on failure, orange while
 * paused for quota, grey when cut short. */
function cardHeader(title: string, terminal: Terminal): object {
  const template =
    terminal === 'error'
      ? 'red'
      : terminal === 'paused'
        ? 'orange'
        : terminal === 'running' || terminal === 'done'
          ? 'wathet'
          : 'grey';
  return {
    template,
    title: { tag: 'plain_text', content: title },
  };
}

/** `hr` + grey agent/model line, mirroring what other bridge bots sign with. */
function byline(meta: RunCardMeta | undefined): object[] {
  if (!meta) return [];
  const parts = [
    meta.agent ? `Agent: ${meta.agent}` : undefined,
    meta.model ? `Model: ${meta.model}` : undefined,
    meta.effort ? `Effort: ${meta.effort}` : undefined,
    meta.provider ? `Provider: ${meta.provider}` : undefined,
    meta.sponsor ? `Sponsor: ${meta.sponsor}` : undefined,
  ].filter((p): p is string => p !== undefined);
  if (parts.length === 0) return [];
  return [
    { tag: 'hr' },
    { tag: 'markdown', content: `<font color='grey'>${parts.join(' | ')}</font>` },
  ];
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  // Running: collapse prior tools, keep latest visible.
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

function reasoningPanel(content: string, active: boolean): object {
  const title = active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**';
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_无输出_',
  });
}

/**
 * Render N tool calls as a single collapsed panel. **Body content is dropped**
 * — only the per-tool header line (icon + name + short summary) is kept.
 *
 * Why no bodies: with full input/output panels nested, the serialized JSON
 * can easily exceed Feishu's per-element size limit (~30KB), causing 400
 * errors that abort the entire card stream. Tool details are still in the
 * file log; users who really need them can `/doctor` to inspect.
 *
 * The latest-running tool, when applicable, is rendered separately via
 * `toolPanel(latest, true)` so live observation isn't sacrificed.
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): object {
  const suffix = finalized ? '（已结束）' : '';
  const title = `☕ **${tools.length} 个工具调用${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join('\n');
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: headerList, text_size: 'notation' }],
  };
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  body: string;
}

function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function stopButton(options: RunCardRenderOptions): object {
  const value: Record<string, unknown> = { cmd: 'stop' };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback('stop');
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    // Feishu asks for confirmation before the click is sent: a stop kills the
    // agent and every command it started, and can't be undone.
    confirm: {
      title: { tag: 'plain_text', content: '终止这个任务？' },
      text: { tag: 'plain_text', content: '任务和它启动的命令都会被结束，无法恢复。' },
    },
    behaviors: [{ type: 'callback', value }],
  };
}

function footerStatus(status: Exclude<FooterStatus, null>, activity?: RunActivity): object {
  const base =
    status === 'thinking'
      ? '🧠 正在思考'
      : status === 'tool_running'
        ? activity?.toolLabel
          ? `🧰 ${activity.toolLabel}`
          : '🧰 正在调用工具'
        : '✍️ 正在输出';
  if (!activity) return noteMd(base);
  const clock = `已运行 ${formatClock(activity.elapsedMs)}`;
  if (activity.idleMs >= STALL_WARN_MS) {
    const mins = Math.floor(activity.idleMs / 60_000);
    return noteMd(`⚠️ ${base} · ${clock} · 已 ${mins} 分钟没有新动静`);
  }
  return noteMd(`${base} · ${clock} · 上次动静 ${formatAgo(activity.idleMs)}`);
}

/** `6:12`, `1:02:03`. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** `8 秒前`, `2 分钟前`. */
export function formatAgo(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs} 秒前`;
  return `${Math.floor(secs / 60)} 分钟前`;
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'paused') return '额度用完，已暂停';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
