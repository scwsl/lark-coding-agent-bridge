import {
  allowedRungs,
  classify,
  decideRung,
  forcedRung,
  isShortFollowUp,
  type AutoEffortSettings,
  type AutoEffortStore,
  type ClassifierInput,
  type RungDecision,
} from '../agent/auto-effort';
import type { EffortLevel } from '../config/schema';
import { log } from '../core/logger';

/** The rung one run landed on, for submit and the reply card. */
export interface AutoEffortPick {
  label: string;
  model: string;
  effort: EffortLevel;
  via: RungDecision['via'];
  /** The rung the conversation was on before; undefined on a new one. */
  from?: string;
  reason?: string;
}

export interface AutoEffortPlan {
  /** Set when the message opens with `/<rung>`: tell the agent it is not a request. */
  forcedLabel?: string;
  /** Where the run lands, given the conversation it resumes (undefined: a new one). Never throws. */
  pick(resumeFrom: string | undefined, liveProcess: boolean): Promise<AutoEffortPick | undefined>;
  /** Record how the run ended, for the next rating. */
  finish(outcome: { handle?: string; terminal?: string; durationMs: number }): void;
}

export interface StartAutoEffortInput {
  settings: AutoEffortSettings;
  store: AutoEffortStore;
  scope: string;
  /** The batch's messages, oldest first. */
  texts: string[];
  attachments: number;
  quoted?: string;
  chatType: 'p2p' | 'group';
  owner: boolean;
  /** The chat's effort (`chatEffort`, else `effort`): the ceiling for runs the owner didn't start. */
  cap?: EffortLevel;
  classify: { cwd: string; env: () => Record<string, string>; binary?: string };
  now?: () => number;
}

/** `xhigh（自动↑）` for the reply card's Effort line. */
export function autoEffortByline(pick: AutoEffortPick): string {
  const how =
    pick.via === 'forced' ? '指定' : pick.via === 'up' ? '自动↑' : pick.via === 'down' ? '自动↓' : '自动';
  return `${pick.effort}（${how}）`;
}

/**
 * Start rating the batch right away (the call takes a few seconds; the run
 * is prepared meanwhile) and settle the rung once the conversation the run
 * resumes is known.
 */
export function startAutoEffort(input: StartAutoEffortInput): AutoEffortPlan {
  const { settings, store, scope } = input;
  const { ladder } = settings;
  const now = input.now ?? Date.now;
  const text = input.texts.join('\n').trim();
  let forced: number | undefined;
  for (const t of [...input.texts].reverse()) {
    forced = forcedRung(ladder, t);
    if (forced !== undefined) break;
  }
  const short = isShortFollowUp(text, input.attachments);
  const known = store.get(scope);
  const startedAt = now();
  const rating: Promise<{ rung: number; reason?: string } | undefined> =
    forced === undefined && !short
      ? classify(
          settings,
          {
            text,
            chatType: input.chatType,
            ...(input.quoted ? { quoted: input.quoted } : {}),
            ...(known ? { current: ladder[known.rung]?.label, ...(known.last ? { last: known.last } : {}) } : {}),
          } satisfies ClassifierInput,
          { cwd: input.classify.cwd, env: input.classify.env(), ...(input.classify.binary ? { binary: input.classify.binary } : {}) },
        ).catch(() => undefined)
      : Promise.resolve(undefined);
  let picked: { rung: number; downVotes: number } | undefined;

  return {
    ...(forced !== undefined ? { forcedLabel: ladder[forced]!.label } : {}),
    async pick(resumeFrom, liveProcess) {
      try {
        const current = store.forConversation(scope, resumeFrom);
        const allowed = allowedRungs(ladder, {
          owner: input.owner,
          ...(input.cap ? { cap: input.cap } : {}),
          blockedModels: store.blockedModels(now()),
        });
        if (allowed.length === 0) return undefined;
        let decision: RungDecision;
        let reason: string | undefined;
        if (liveProcess && current) {
          // The message goes to the process this scope still runs: it keeps its model and effort.
          decision = { rung: current.rung, downVotes: current.downVotes, via: 'stay' };
        } else if (forced === undefined && short) {
          // A follow-up keeps the rung; a short opener starts at the bottom.
          decision = current
            ? decideRung({ ladder, allowed, current, target: current.rung })
            : decideRung({ ladder, allowed });
        } else {
          const rated = await rating;
          reason = rated?.reason;
          decision = decideRung({
            ladder,
            allowed,
            ...(current ? { current: { rung: current.rung, downVotes: current.downVotes } } : {}),
            ...(rated ? { target: rated.rung } : {}),
            ...(forced !== undefined ? { forced } : {}),
          });
        }
        const rung = ladder[decision.rung]!;
        const from = current ? ladder[current.rung]?.label : undefined;
        picked = { rung: decision.rung, downVotes: decision.downVotes };
        store.set(
          scope,
          {
            rung: decision.rung,
            downVotes: decision.downVotes,
            ...(resumeFrom ? { handle: resumeFrom } : {}),
            ...(current?.last ? { last: current.last } : {}),
          },
          now(),
        );
        log.info('auto-effort', 'picked', {
          scope,
          rung: rung.label,
          via: decision.via,
          ...(from ? { from } : {}),
          ...(reason ? { reason } : {}),
          short,
          waitedMs: now() - startedAt,
        });
        return {
          label: rung.label,
          model: rung.model,
          effort: rung.effort,
          via: decision.via,
          ...(from ? { from } : {}),
          ...(reason ? { reason } : {}),
        };
      } catch (err) {
        log.warn('auto-effort', 'pick-failed', { scope, err: String(err) });
        return undefined;
      }
    },
    finish(outcome) {
      if (!picked) return;
      const rung = ladder[picked.rung];
      // A failed run on a model other than the bottom one (Fable): its quota
      // may be spent, so skip it for a while instead of failing again.
      if (outcome.terminal === 'error' && rung && rung.model !== ladder[0]?.model) {
        store.blockModel(rung.model, now());
        log.warn('auto-effort', 'model-blocked', { scope, model: rung.model });
      }
      store.set(
        scope,
        {
          rung: picked.rung,
          downVotes: picked.downVotes,
          ...(outcome.handle ? { handle: outcome.handle } : {}),
          last: { ...(outcome.terminal ? { terminal: outcome.terminal } : {}), durationMs: outcome.durationMs },
        },
        now(),
      );
    },
  };
}
