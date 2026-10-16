import { extractCodeBlocks } from './code-snippets';
import { deepMaskEmails } from './mask-email';
import { runStrings, type Locale, type RunStrings } from './i18n';
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
  /** This turn's consumption, e.g. `24.8k in / 51 out · ≈$0.03`. */
  usage?: string;
  /** One-off note about the conversation itself, e.g. that 会话智能压缩 started a fresh one. */
  notice?: string;
}

export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
  meta?: RunCardMeta;
  /** Live clock for the running footer. See {@link RunActivity}. */
  activity?: RunActivity;
  /** Language of the bridge's own words on the card; Chinese when absent. */
  locale?: Locale;
  /**
   * Keep a code block for its copy button and return the key the button
   * carries. When set, a finished card gets one 「复制代码」 button per fenced
   * block in the answer (see {@link copyButtons}).
   */
  copyCode?: (code: string) => string;
}

/** Copy buttons past this many would crowd the card; later blocks get none. */
export const MAX_COPY_BUTTONS = 6;

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
  const t = runStrings(options.locale);

  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active, t));
  }

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        elements.push(markdown(group.content));
      }
    } else {
      elements.push(...renderToolGroup(group.tools, state.terminal !== 'running', t));
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd(t.interrupted));
  } else if (state.terminal === 'idle_timeout') {
    elements.push(noteMd(t.idleTimeout(state.idleTimeoutMinutes ?? 0)));
  } else if (state.terminal === 'paused') {
    elements.push(markdown(pauseNotice(state.limit, options.locale)));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(t.agentFailed(state.errorMsg)));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd(t.noContent));
  }

  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state.footer, t, options.activity));
    elements.push(stopButton(options, t));
  } else {
    if (options.copyCode) elements.push(...copyButtons(state, options.copyCode, t));
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
      summary: { content: summaryText(state, t) },
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
    meta.usage ? `Usage: ${meta.usage}` : undefined,
  ].filter((p): p is string => p !== undefined);
  if (parts.length === 0 && !meta.notice) return [];
  return [
    { tag: 'hr' },
    ...(meta.notice ? [{ tag: 'markdown', content: `<font color='grey'>🔄 ${meta.notice}</font>` }] : []),
    ...(parts.length > 0 ? [{ tag: 'markdown', content: `<font color='grey'>${parts.join(' | ')}</font>` }] : []),
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

function renderToolGroup(tools: ToolEntry[], finalized: boolean, t: RunStrings): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((tool) => toolPanel(tool, false, t));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true, t)];
  }
  // Running: collapse prior tools, keep latest visible.
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false, t));
  if (latest) out.push(toolPanel(latest, true, t));
  return out;
}

function reasoningPanel(content: string, active: boolean, t: RunStrings): object {
  const title = active ? t.reasoningActive : t.reasoningDone;
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean, t: RunStrings): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool, t.toolRunningBody) || t.noOutput,
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
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean, t: RunStrings): object {
  const title = t.toolCalls(tools.length, finalized);
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

function stopButton(options: RunCardRenderOptions, t: RunStrings): object {
  const value: Record<string, unknown> = { cmd: 'stop' };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback('stop');
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: t.stop },
    type: 'danger',
    // Feishu asks for confirmation before the click is sent: a stop kills the
    // agent and every command it started, and can't be undone.
    confirm: {
      title: { tag: 'plain_text', content: t.stopConfirmTitle },
      text: { tag: 'plain_text', content: t.stopConfirmText },
    },
    behaviors: [{ type: 'callback', value }],
  };
}

/**
 * Feishu cards can't write the clipboard, and their code blocks have no copy
 * icon, so each code block gets a button: a click makes the bridge send that
 * block alone as a plain-text message, which long-press / right-click 复制
 * copies whole. The button carries only the snippet's key.
 */
function copyButtons(state: RunState, copyCode: (code: string) => string, t: RunStrings): object[] {
  const text = state.blocks
    .filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.content)
    .join('\n');
  const blocks = extractCodeBlocks(text).slice(0, MAX_COPY_BUTTONS);
  if (blocks.length === 0) return [];
  const columns = blocks.map((block, i) => ({
    tag: 'column',
    width: 'auto',
    elements: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t.copyCode(blocks.length > 1 ? i + 1 : undefined, block.lang) },
        type: 'default',
        size: 'small',
        behaviors: [{ type: 'callback', value: { cmd: `copycode.${copyCode(block.code)}` } }],
      },
    ],
  }));
  return [{ tag: 'column_set', flex_mode: 'flow', horizontal_spacing: '8px', columns }];
}

function footerStatus(
  status: Exclude<FooterStatus, null>,
  t: RunStrings,
  activity?: RunActivity,
): object {
  const base =
    status === 'thinking'
      ? t.thinking
      : status === 'tool_running'
        ? activity?.toolLabel
          ? `🧰 ${activity.toolLabel}`
          : t.toolRunning
        : t.streaming;
  if (!activity) return noteMd(base);
  const clock = t.elapsed(formatClock(activity.elapsedMs));
  if (activity.idleMs >= STALL_WARN_MS) {
    return noteMd(`⚠️ ${base} · ${clock} · ${t.quietFor(Math.floor(activity.idleMs / 60_000))}`);
  }
  return noteMd(`${base} · ${clock} · ${t.lastActivity(formatAgo(activity.idleMs, t))}`);
}

/** `6:12`, `1:02:03`. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** `8 秒前`, `2 分钟前` (or the locale's wording). */
export function formatAgo(ms: number, t: RunStrings = runStrings('zh')): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return t.secondsAgo(secs);
  return t.minutesAgo(Math.floor(secs / 60));
}

function summaryText(state: RunState, t: RunStrings): string {
  if (state.terminal === 'interrupted') return t.summary.interrupted;
  if (state.terminal === 'idle_timeout') return t.summary.idleTimeout;
  if (state.terminal === 'paused') return t.summary.paused;
  if (state.terminal === 'error') return t.summary.error;
  if (state.terminal === 'done') return t.summary.done;
  if (state.footer === 'tool_running') return t.summary.toolRunning;
  if (state.footer === 'streaming') return t.summary.streaming;
  return t.summary.thinking;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
