import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { AutoResumer } from '../bot/auto-resume';
import type { ChatModeCache } from '../bot/chat-mode-cache';
import type { PendingQueue } from '../bot/pending-queue';
import type { ProcessPool } from '../bot/process-pool';
import { operatorForAction, type CallbackAuth } from './callback-auth';
import { runCommandHandler, type CommandContext, type Controls } from '../commands';
import { log } from '../core/logger';
import { canStopRun, canUseDm, canUseGroup } from '../policy/access';
import type { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { commandSessionCatalogIdentity } from '../bot/session-catalog-identity';
import { lookupMessageThreadId } from '../bot/thread-id';

/** Marker key on a button's value object that flags the cardAction as
 * a callback that should be forwarded back to the agent instead
 * of dispatched to a built-in command handler. The double-underscore
 * sigils make it virtually impossible to collide with normal payload
 * fields the agent might set.
 */
const BRIDGE_CALLBACK_MARKER = '__bridge_cb';
const LEGACY_CLAUDE_CALLBACK_MARKER = '__claude_cb';

/** Marker on buttons a skill's script put on its own card (antelope:deploy's
 * confirm / cancel), whose value is the skill name. These are clicked long
 * after the run that sent the card has ended, so there is no run to sign a
 * token against; the click goes to the agent unsigned, as the clicker, and
 * the skill re-checks who clicked against its own state (the deploy script
 * only lets the plan's operator confirm it). To keep a forged card from
 * smuggling instructions in under someone else's name, the value may only
 * carry a few short identifier fields — no free text.
 */
const SKILL_CALLBACK_MARKER = '__skill_cb';
const SKILL_NAME = /^[a-z0-9-]{1,40}:[a-z0-9-]{1,40}$/;
const SKILL_FIELD_KEY = /^[a-z_]{1,32}$/;
const SKILL_FIELD_VALUE = /^[A-Za-z0-9_.:,/@-]{1,120}$/;
const SKILL_MAX_FIELDS = 6;
/** A skill card may also be a form (antelope:deploy's branch picker: one
 * checkbox per branch plus a launch-order box). Its values ride along under
 * form_value with the same no-free-text rule: keys are short identifiers,
 * values are booleans, short identifier strings (spaces allowed, for a list
 * of numbers) or arrays of those. */
const SKILL_FORM_KEY = /^[a-z0-9_]{1,32}$/;
const SKILL_FORM_VALUE = /^[A-Za-z0-9_.:,/@ -]{0,120}$/;
const SKILL_FORM_MAX_FIELDS = 40;
/** The one exception to the no-free-text rule: a form field whose name ends
 * in `_text` (antelope:jira-dev's 「补充分析」 textarea) may carry what the
 * clicker typed — any language, line breaks included — up to
 * SKILL_FORM_TEXT_MAX characters, at most SKILL_FORM_TEXT_MAX_FIELDS of them
 * per click. It reaches the agent as the clicker's own words, the same as a
 * message they sent, so it borrows no one else's authority; a skill that
 * accepts it must still check that the card is one its own script sent
 * (message id in the skill's state) and that the clicker is the person the
 * card is waiting on, and must never pre-fill the box (default_value) with
 * text it did not get from that person. Button values stay identifier-only. */
const SKILL_FORM_TEXT_KEY = /^[a-z0-9_]{1,27}_text$/;
const SKILL_FORM_TEXT_MAX = 2000;
const SKILL_FORM_TEXT_MAX_FIELDS = 2;
// Control characters other than tab / line feed / carriage return.
// eslint-disable-next-line no-control-regex
const SKILL_FORM_TEXT_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export interface CardDispatchDeps {
  channel: LarkChannel;
  evt: CardActionEvent;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: AgentAdapter;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  pending: PendingQueue;
  chatModeCache: ChatModeCache;
  callbackAuth?: CallbackAuth;
  autoResumer?: AutoResumer;
  callbackPolicyFingerprint?: string;
  callbackPolicyFingerprintForScope?: (scope: string) => string | undefined;
}

export async function handleCardAction(deps: CardDispatchDeps): Promise<void> {
  const value = deps.evt.action.value;
  if (!value || typeof value !== 'object') return;
  const payload = value as Record<string, unknown>;

  const operatorId = deps.evt.operator.openId;
  const chatId = deps.evt.chatId;

  // CardKit 2.0 form submits drop user-input values from action.value; they
  // arrive on raw.action.form_value. The SDK forwards the raw event when
  // includeRawEvent: true is set on the channel options.
  const raw = (deps.evt as CardActionEvent & { raw?: unknown }).raw as
    | { action?: { form_value?: Record<string, unknown> } }
    | undefined;
  const formValue = raw?.action?.form_value;

  // Resolve the click's session scope. For group cards we need to know
  // the message's thread_id so the action targets the right topic's
  // session — look up the carrier message (the card lives on it) once.
  // Done before the access check so we know the chat mode (p2p vs group)
  // and can skip the chat allowlist for DMs.
  const { scope, threadId, mode, isP2p } = await resolveScope(deps);

  const accessDecision =
    isP2p
      ? canUseDm(deps.controls.profileConfig, deps.controls, operatorId)
      : canUseGroup(deps.controls.profileConfig, deps.controls, chatId, operatorId);
  if (!accessDecision.ok) {
    log.info('cardAction', 'skip-not-allowed-user', {
      operator: operatorId.slice(-6),
      reason: accessDecision.reason,
    });
    return;
  }

  if (LEGACY_CLAUDE_CALLBACK_MARKER in payload) {
    log.info('cardAction', 'skip-legacy-callback-marker', { scope });
    return;
  }

  if (SKILL_CALLBACK_MARKER in payload) {
    const click = skillClick(payload);
    if (!click) {
      log.warn('cardAction', 'skip-bad-skill-callback', {
        scope,
        payload: JSON.stringify(payload).slice(0, 200),
      });
      return;
    }
    const form = formValue === undefined ? undefined : skillForm(formValue);
    if (form === null) {
      log.warn('cardAction', 'skip-bad-skill-form', {
        scope,
        form: JSON.stringify(formValue).slice(0, 200),
      });
      return;
    }
    forwardToAgent(deps, click, form, scope, threadId, isP2p);
    return;
  }

  const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';
  if (cmd) {
    // A stop click from someone who may not stop this run skips the token
    // check and goes straight to /stop, which refuses it with a reply.
    // Verifying first would spend the button's one-time nonce and leave the
    // stop button dead for the people who are allowed to use it.
    const refusedStop = cmd === 'stop' && !mayStopRun(deps, scope, operatorId);
    if (
      !refusedStop &&
      isSignedBridgeCallback(payload) &&
      !verifyBridgeToken(deps, payload, scope, cmd)
    ) {
      return;
    }
    log.info('cardAction', 'cmd', { cmd, scope });
    const msg = makeFakeMsg(deps.evt, threadId);

    const ctx: CommandContext = {
      channel: deps.channel,
      msg,
      scope,
      chatMode: mode,
      sessions: deps.sessions,
      sessionCatalog: deps.sessionCatalog,
      sessionCatalogIdentity: await commandSessionCatalogIdentity({
        msg,
        scope,
        mode,
        workspaces: deps.workspaces,
        controls: deps.controls,
        access: accessDecision,
      }),
      workspaces: deps.workspaces,
      activeRuns: deps.activeRuns,
      agent: deps.agent,
      processPool: deps.processPool,
      runExecutor: deps.runExecutor,
      controls: deps.controls,
      ...(deps.autoResumer ? { autoResumer: deps.autoResumer } : {}),
      formValue,
      fromCardAction: true,
    };

    const [name, ...rest] = cmd.split('.');
    const sub = rest.join(' ');
    const args = composeArgs(sub, payload);

    try {
      const ok = await runCommandHandler(name ?? '', args, ctx);
      if (!ok) log.warn('cardAction', 'unknown', { cmd });
    } catch (err) {
      log.fail('cardAction', err, { cmd });
    }
    return;
  }

  // Agent-driven callback: the button was rendered by an agent via lark-cli,
  // with `__bridge_cb` set on the value. Forward the click back into the
  // scope's pending queue so the agent resumes its session and sees the click
  // as a follow-up message, with full context of what it sent.
  if (BRIDGE_CALLBACK_MARKER in payload) {
    if (!verifyBridgeToken(deps, payload, scope, 'agent_callback')) return;
    forwardToAgent(deps, payload, formValue, scope, threadId, isP2p);
    return;
  }

  return;
}

async function resolveScope(
  deps: CardDispatchDeps,
): Promise<{
  scope: string;
  threadId: string | undefined;
  mode: 'p2p' | 'group' | 'topic';
  isP2p: boolean;
}> {
  const chatId = deps.evt.chatId;
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  const isP2p = mode === 'p2p';
  // Match message intake: a carrier thread_id is stronger than cached chat
  // mode (groups converted to topics can still resolve as ordinary groups,
  // and DMs have topics too — /new-topic opens them). One API call per
  // click; could cache by messageId if it ever becomes hot.
  const threadId = await lookupMessageThreadId(deps.channel, deps.evt.messageId);
  if (!threadId) {
    // Fall back to plain chatId. Better to land in the chat's "default"
    // scope than fail the click silently.
    return { scope: chatId, threadId: undefined, mode, isP2p };
  }
  return { scope: `${chatId}:${threadId}`, threadId, mode: 'topic', isP2p };
}

function forwardToAgent(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
  scope: string,
  threadId: string | undefined,
  isP2p: boolean,
): void {
  // Strip the marker so the agent only sees the meaningful fields it set.
  const {
    [BRIDGE_CALLBACK_MARKER]: _marker,
    bridge_token: _token,
    ...agentPayload
  } = payload;
  const merged = formValue ? { ...agentPayload, form_value: formValue } : agentPayload;
  log.info('cardAction', 'forward-agent', {
    scope,
    payload: JSON.stringify(merged).slice(0, 200),
  });
  const synthetic: NormalizedMessage = {
    messageId: deps.evt.messageId,
    chatId: deps.evt.chatId,
    chatType: isP2p ? 'p2p' : 'group',
    threadId,
    senderId: deps.evt.operator.openId,
    senderName: deps.evt.operator.name,
    content: `[card-click] ${JSON.stringify(merged)}`,
    rawContentType: 'card_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  deps.pending.push(scope, synthetic);
}

function verifyBridgeToken(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  action: string,
): boolean {
  const token = typeof payload.bridge_token === 'string' ? payload.bridge_token : '';
  const active = deps.activeRuns.get(scope);
  if (!deps.callbackAuth || !token || !active) {
    log.info('cardAction', 'skip-callback-auth-missing', { scope, action });
    log.warn('callback', 'denied', { scope, action, reason: 'missing-token-or-run' });
    return false;
  }
  const result = deps.callbackAuth.verify(token, {
    runId: active.run.runId,
    scope,
    chatId: deps.evt.chatId,
    operatorOpenId: operatorForAction(action, deps.evt.operator.openId),
    action,
    policyFingerprint:
      deps.callbackPolicyFingerprintForScope?.(scope) ??
      deps.callbackPolicyFingerprint ??
      '',
  });
  if (!result.ok) {
    log.info('cardAction', 'skip-callback-auth-failed', {
      scope,
      action,
      reason: result.reason,
    });
    log.warn('callback', 'denied', { scope, action, reason: result.reason });
    return false;
  }
  return true;
}

function mayStopRun(deps: CardDispatchDeps, scope: string, operatorId: string): boolean {
  const running = deps.activeRuns.get(scope);
  if (!running) return true;
  return canStopRun(
    deps.controls.profileConfig,
    deps.controls,
    operatorId,
    running.supplement?.initiators,
  ).ok;
}

/** `{__skill_cb: 'antelope:deploy', action: 'confirm', plan: '…'}` →
 * `{skill: 'antelope:deploy', action: 'confirm', plan: '…'}`, or undefined
 * when the value is anything but a skill name plus a few short identifiers
 * (or also carries a command or bridge-callback fields). */
function skillClick(payload: Record<string, unknown>): Record<string, string> | undefined {
  const { [SKILL_CALLBACK_MARKER]: skill, ...fields } = payload;
  if (typeof skill !== 'string' || !SKILL_NAME.test(skill)) return undefined;
  if ('cmd' in fields || 'skill' in fields || isSignedBridgeCallback(fields)) return undefined;
  const entries = Object.entries(fields);
  if (entries.length === 0 || entries.length > SKILL_MAX_FIELDS) return undefined;
  const click: Record<string, string> = { skill };
  for (const [key, value] of entries) {
    if (!SKILL_FIELD_KEY.test(key) || typeof value !== 'string' || !SKILL_FIELD_VALUE.test(value)) {
      return undefined;
    }
    click[key] = value;
  }
  return click;
}

/** The form values of a skill card, or null when any of them is free text,
 * too long, or not a boolean / short identifier (see SKILL_FORM_VALUE) —
 * except the `_text` fields, which may hold what the clicker typed (see
 * SKILL_FORM_TEXT_KEY). */
function skillForm(form: Record<string, unknown>): Record<string, unknown> | null {
  const entries = Object.entries(form);
  if (entries.length > SKILL_FORM_MAX_FIELDS) return null;
  const okValue = (v: unknown): boolean =>
    typeof v === 'boolean' || (typeof v === 'string' && SKILL_FORM_VALUE.test(v));
  let texts = 0;
  for (const [key, value] of entries) {
    if (!SKILL_FORM_KEY.test(key)) return null;
    if (SKILL_FORM_TEXT_KEY.test(key)) {
      texts += 1;
      if (
        texts > SKILL_FORM_TEXT_MAX_FIELDS ||
        typeof value !== 'string' ||
        value.length > SKILL_FORM_TEXT_MAX ||
        SKILL_FORM_TEXT_BAD.test(value)
      ) {
        return null;
      }
      continue;
    }
    if (Array.isArray(value) ? value.length > SKILL_FORM_MAX_FIELDS || !value.every(okValue) : !okValue(value)) {
      return null;
    }
  }
  return form;
}

function isSignedBridgeCallback(payload: Record<string, unknown>): boolean {
  return BRIDGE_CALLBACK_MARKER in payload || typeof payload.bridge_token === 'string';
}

/** Turn a button payload like {cmd:'ws.use', name:'proj-a'} into the arg
 * string the text-command handler expects: 'use proj-a'. Accepts `arg`
 * (preferred, generic) or `name` (legacy ws cards). */
function composeArgs(sub: string, payload: Record<string, unknown>): string {
  if (!sub) return '';
  const arg =
    (typeof payload.arg === 'string' && payload.arg) ||
    (typeof payload.name === 'string' && payload.name) ||
    '';
  return arg ? `${sub} ${arg}` : sub;
}

function makeFakeMsg(
  evt: CardActionEvent,
  threadId: string | undefined,
): NormalizedMessage {
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    chatType: 'p2p',
    threadId,
    senderId: evt.operator.openId,
    senderName: evt.operator.name,
    content: '',
    rawContentType: 'interactive',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}
