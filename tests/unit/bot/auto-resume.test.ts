import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { translateEvent } from '../../../src/agent/claude/stream-json.js';
import {
  AutoResumer,
  MAX_AUTO_RESUMES,
  RESUME_GRACE_MS,
  UNKNOWN_RESET_RETRY_MS,
  limitLabel,
  resumeAtFor,
  type PendingResume,
} from '../../../src/bot/auto-resume.js';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce(reduce, initialState);
}

const RESET = Date.UTC(2026, 9, 2, 15, 40); // 23:40 Asia/Shanghai

describe('Claude quota signals', () => {
  it('reads rate_limit_event, converting the reset from seconds', () => {
    const [evt] = translateEvent({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: RESET / 1000, rateLimitType: 'five_hour' },
    });
    expect(evt).toMatchObject({
      type: 'rate_limit',
      blocked: true,
      limitType: 'five_hour',
      resetsAt: RESET,
    });
    const [ok] = translateEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
    expect(ok).toMatchObject({ type: 'rate_limit', blocked: false });
  });

  it('turns the "hit your limit" assistant message into a block, not answer text', () => {
    const events = [
      ...translateEvent({
        type: 'assistant',
        error: 'rate_limit',
        message: { content: [{ type: 'text', text: "You've hit your limit · resets 11:40pm" }] },
      }),
    ];
    expect(events).toEqual([
      {
        type: 'rate_limit',
        blocked: true,
        message: "You've hit your limit · resets 11:40pm",
        at: expect.any(Number),
      },
    ]);
  });
});

describe('paused runs', () => {
  const blocked: AgentEvent[] = [
    { type: 'text', delta: 'half done' },
    { type: 'rate_limit', blocked: false, limitType: 'five_hour', resetsAt: RESET, at: 1 },
    { type: 'rate_limit', blocked: true, message: 'You have hit your limit', at: 2 },
    { type: 'done', terminationReason: 'normal' },
  ];

  it('ends paused, keeping the window and reset time reported earlier', () => {
    const state = stateFrom(blocked);
    expect(state.terminal).toBe('paused');
    expect(state.limit).toEqual({
      limitType: 'five_hour',
      resetsAt: RESET,
      message: 'You have hit your limit',
      at: 2,
    });
  });

  it('is not paused when the agent keeps working after a refusal', () => {
    const state = stateFrom([
      { type: 'rate_limit', blocked: true, limitType: 'seven_day_opus', at: 1 },
      { type: 'text', delta: 'fell back to another model' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(state.terminal).toBe('done');
    expect(state.limit).toBeUndefined();
  });

  it('a failed exit after a refusal is a pause, not an error', () => {
    const state = stateFrom([
      { type: 'rate_limit', blocked: true, at: 1 },
      { type: 'error', message: 'exit 1', terminationReason: 'failed' },
    ]);
    expect(state.terminal).toBe('paused');
  });

  it('says on the card why it stopped and when it goes on', () => {
    const state = stateFrom(blocked);
    const auto = renderCard(
      { ...state, limit: { ...state.limit!, autoResumeAt: RESET + 60_000 } },
      { meta: { title: 'Occam' } },
    );
    const text = JSON.stringify(auto);
    expect(text).toContain('任务暂停');
    expect(text).toContain('5 小时额度已用完');
    expect(text).toContain('自动继续');
    expect(text).toContain('"template":"orange"');
    expect(text).toContain('half done');

    const manual = renderText(state);
    expect(manual).toContain('额度重置后发「继续」');
    expect(manual).not.toContain('自动继续');
  });
});

describe('resume timing', () => {
  it('resumes a minute after the reset, or retries later when the reset is unknown', () => {
    expect(resumeAtFor({ resetsAt: RESET, at: RESET - 3_600_000 })).toBe(RESET + RESUME_GRACE_MS);
    expect(resumeAtFor({ at: 1000 })).toBe(1000 + UNKNOWN_RESET_RETRY_MS + RESUME_GRACE_MS);
    // A reset already in the past still waits out the grace.
    expect(resumeAtFor({ resetsAt: 500, at: 1000 })).toBe(1000 + RESUME_GRACE_MS);
  });

  it('names the windows in Chinese', () => {
    expect(limitLabel('five_hour')).toBe('5 小时额度');
    expect(limitLabel('seven_day')).toBe('本周额度');
    expect(limitLabel(undefined)).toBe('Claude 额度');
  });
});

describe('AutoResumer', () => {
  function pending(overrides: Partial<PendingResume> = {}): PendingResume {
    return {
      scope: 'oc_dm',
      chatId: 'oc_dm',
      chatType: 'p2p',
      senderId: 'ou_user',
      originMessageId: 'om_origin',
      resumeAt: 5_000,
      limitType: 'five_hour',
      attempt: 1,
      createdAt: 0,
      ...overrides,
    };
  }

  it('fires once a resume is due, survives a restart through its file, and chains attempts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auto-resume-'));
    dirs.push(dir);
    const file = join(dir, 'auto-resume.json');
    const fire = vi.fn(async () => {});

    const first = new AutoResumer({ file, fire });
    await first.schedule(pending());
    expect(JSON.parse(await readFile(file, 'utf8')).resumes.oc_dm.resumeAt).toBe(5_000);

    // A new process picks it up from disk.
    const second = new AutoResumer({ file, fire });
    await second.load();
    await second.tick(4_999);
    expect(fire).not.toHaveBeenCalled();
    await second.tick(5_000);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(second.get('oc_dm')).toBeUndefined();
    expect(JSON.parse(await readFile(file, 'utf8')).resumes).toEqual({});

    // The resumed run pausing again counts as the next attempt; a fresh pause does not.
    expect(second.nextAttempt('oc_dm', true)).toBe(2);
    expect(second.nextAttempt('oc_dm', false)).toBe(1);
  });

  it('cancel drops the pending resume and resets the attempt chain', async () => {
    const r = new AutoResumer({ fire: async () => {} });
    await r.schedule(pending({ attempt: MAX_AUTO_RESUMES }));
    await r.tick(10_000);
    expect(r.nextAttempt('oc_dm', true)).toBe(MAX_AUTO_RESUMES + 1);
    await r.schedule(pending());
    expect((await r.cancel('oc_dm', 'test'))?.scope).toBe('oc_dm');
    expect(r.get('oc_dm')).toBeUndefined();
    expect(r.nextAttempt('oc_dm', true)).toBe(1);
  });

  it('a newer pause in the same chat replaces the older one', async () => {
    const r = new AutoResumer({ fire: async () => {} });
    await r.schedule(pending({ resumeAt: 1 }));
    await r.schedule(pending({ resumeAt: 2 }));
    expect(r.get('oc_dm')?.resumeAt).toBe(2);
  });
});
