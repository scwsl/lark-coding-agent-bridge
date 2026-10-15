import type { CardActionEvent } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { CallbackAuth, operatorForAction } from '../../../src/card/callback-auth.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentRun } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('signed card callback dispatch', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('lets the run initiator stop it from the card', async () => {
    const h = await createHarness();
    const run = registerRun(h, ['ou_operator']);

    await h.dispatch({ cmd: 'stop', __bridge_cb: true, bridge_token: h.token('stop') });

    expect(run.stopped).toBe(true);
  });

  it('refuses a stop from someone else in the group, without spending the button', async () => {
    const h = await createHarness();
    const run = registerRun(h, ['ou_initiator']);
    const token = h.token('stop');

    await h.dispatch({ cmd: 'stop', __bridge_cb: true, bridge_token: token }, undefined, 'ou_bystander');

    expect(run.stopped).toBe(false);
    expect(JSON.stringify(h.channel.sent.at(-1)?.content)).toContain('只有任务的发起人');

    // The refused click must not have used up the token: the initiator's
    // click on the same button still works.
    await h.dispatch({ cmd: 'stop', __bridge_cb: true, bridge_token: token }, undefined, 'ou_initiator');
    expect(run.stopped).toBe(true);
  });

  it('lets the owner and the stoppers allowlist stop anyone\'s run', async () => {
    const owner = await createHarness();
    const ownerRun = registerRun(owner, ['ou_initiator']);
    await owner.dispatch(
      { cmd: 'stop', __bridge_cb: true, bridge_token: owner.token('stop') },
      undefined,
      'ou_owner',
    );
    expect(ownerRun.stopped).toBe(true);

    const guarded = await createHarness({ stoppers: ['ou_guard'] });
    const guardedRun = registerRun(guarded, ['ou_initiator']);
    await guarded.dispatch(
      { cmd: 'stop', __bridge_cb: true, bridge_token: guarded.token('stop') },
      undefined,
      'ou_guard',
    );
    expect(guardedRun.stopped).toBe(true);
  });

  it('still requires a valid bridge token from people allowed to stop', async () => {
    const h = await createHarness();
    const run = registerRun(h, ['ou_operator']);

    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop', { scope: 'oc_elsewhere' }),
    });

    expect(run.stopped).toBe(false);
  });

  it('forwards signed bridge callbacks without leaking auth fields into the agent payload', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' });
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch(
      {
        __bridge_cb: true,
        bridge_token: h.token('agent_callback', { nonce: 'nonce-agent' }),
        choice: 'a',
      },
      { note: 'from form' },
    );

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a","form_value":{"note":"from form"}}');
    expect(queued[0]?.chatType).toBe('group');
  });

  it('drops legacy Claude callback markers before command dispatch', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __claude_cb: true,
      cmd: 'stop',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });

  it('scopes topic-group callbacks by the carrier message thread_id', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    // The dispatcher must read items[0].thread_id from the raw message get to
    // compose the `${chatId}:${threadId}` scope. A regression here (e.g. using
    // channel.fetchMessage, whose normalized shape drops thread_id) would fall
    // back to the bare chatId and route the click into the wrong session.
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    h.activeRuns.register('oc_group:th_topic', h.agent.run({ runId: 'run-active', prompt: 'running' }));

    await h.dispatch({
      __bridge_cb: true,
      bridge_token: h.token('agent_callback', { nonce: 'nonce-topic', scope: 'oc_group:th_topic' }),
      choice: 'a',
    });

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    const queued = h.pending.cancel('oc_group:th_topic');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a"}');
  });

  it('stops only the carrier topic when cached chat mode still says group', async () => {
    const h = await createHarness({ chatMode: 'group' });
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    const target = h.agent.run({ runId: 'run-active', prompt: 'target' }) as FakeAgentRun;
    const chatRun = h.agent.run({ runId: 'run-chat', prompt: 'chat' }) as FakeAgentRun;
    const sibling = h.agent.run({ runId: 'run-sibling', prompt: 'sibling' }) as FakeAgentRun;
    h.activeRuns.register('oc_group:th_topic', target);
    h.activeRuns.register('oc_group', chatRun);
    h.activeRuns.register('oc_group:th_other', sibling);

    // The owner clicks: stopping someone else's run is permission-checked.
    await h.dispatch(
      {
        cmd: 'stop',
        __bridge_cb: true,
        bridge_token: h.token('stop', { scope: 'oc_group:th_topic' }),
      },
      undefined,
      'ou_owner',
    );

    expect(target.stopped).toBe(true);
    expect(chatRun.stopped).toBe(false);
    expect(sibling.stopped).toBe(false);
  });

  it('forwards callbacks to the carrier topic despite stale group mode', async () => {
    const h = await createHarness({ chatMode: 'group' });
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    h.activeRuns.register('oc_group:th_topic', h.agent.run({ runId: 'run-active', prompt: 'running' }));

    await h.dispatch({
      __bridge_cb: true,
      bridge_token: h.token('agent_callback', { scope: 'oc_group:th_topic' }),
      choice: 'a',
    });

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    const queued = h.pending.cancel('oc_group:th_topic');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.threadId).toBe('th_topic');
  });

  it('rejects bridge callbacks when callback auth is unavailable', async () => {
    const h = await createHarness({ callbackAuth: false });
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __bridge_cb: true,
      choice: 'unsafe',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });
});

type Harness = {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: FakeAgentAdapter;
  controls: Controls;
  pending: PendingQueue;
  auth: CallbackAuth;
  dispatch(
    value: Record<string, unknown>,
    formValue?: Record<string, unknown>,
    operatorOpenId?: string,
  ): Promise<void>;
  token(
    action: string,
    overrides?: { operatorOpenId?: string; nonce?: string; scope?: string },
  ): string;
};

async function createHarness(
  opts: {
    callbackAuth?: boolean;
    chatMode?: 'p2p' | 'group' | 'topic';
    stoppers?: string[];
  } = {},
): Promise<Harness> {
  const access = {
    allowedChats: ['oc_group'],
    ...(opts.stoppers ? { stoppers: opts.stoppers } : {}),
  };
  const tmp = await createTmpProfile('callback-dispatch-test-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const pending = new PendingQueue(60_000, () => {});
  const store = new CallbackNonceStore(`${tmp.profile}/callback-nonces.json`);
  const controls = {
    profile: 'claude',
    profileConfig: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access,
    }),
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    cfg: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access,
    }),
    processId: 'proc-1',
  } satisfies Controls;
  let nonce = 'nonce-stop';
  const auth = new CallbackAuth({
    keys: [{ version: 1, secret: 'secret-1' }],
    nonceStore: store,
    now: () => 1000,
    createNonce: () => nonce,
  });
  const chatModeCache = {
    resolve: async () => opts.chatMode ?? 'group',
  } as unknown as ChatModeCache;
  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), store.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    activeRuns,
    agent,
    controls,
    pending,
    auth,
    token: (action, overrides = {}) => {
      nonce = overrides.nonce ?? `nonce-${action}`;
      return auth.sign({
        runId: 'run-active',
        scope: overrides.scope ?? 'oc_group',
        chatId: 'oc_group',
        operatorOpenId: operatorForAction(action, overrides.operatorOpenId ?? 'ou_operator'),
        action,
        policyFingerprint: 'fp-1',
        ttlMs: 60_000,
      });
    },
    dispatch: (value, formValue, operatorOpenId) =>
      handleCardAction({
        channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
        evt: cardEvent(value, formValue, operatorOpenId),
        sessions,
        workspaces,
        activeRuns,
        agent,
        controls,
        pending,
        chatModeCache,
        ...(opts.callbackAuth === false ? {} : { callbackAuth: auth }),
        callbackPolicyFingerprint: 'fp-1',
      }),
  };
}

/** Register a running scope whose run was started by `initiators`. */
function registerRun(h: Harness, initiators: string[]): FakeAgentRun {
  const run = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
  const handle = h.activeRuns.register('oc_group', run);
  handle.supplement = {
    originIds: new Set(),
    replyIds: new Set(),
    initiators: new Set(initiators),
  };
  return run;
}

function cardEvent(
  value: Record<string, unknown>,
  formValue?: Record<string, unknown>,
  operatorOpenId = 'ou_operator',
): CardActionEvent {
  return {
    action: { value },
    chatId: 'oc_group',
    messageId: 'om_card',
    operator: {
      openId: operatorOpenId,
      name: 'Operator',
    },
    raw: formValue ? { action: { form_value: formValue } } : undefined,
  } as unknown as CardActionEvent;
}
