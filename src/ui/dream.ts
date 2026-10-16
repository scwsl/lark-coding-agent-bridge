import { join } from 'node:path';
import { profileAppPaths } from '../config/config-ops';
import { composeDreamStatus, type DreamStatusView } from '../dream/service';
import { DreamStateStore, type DreamRun } from '../dream/state';
import { KnowledgeStore } from '../knowledge/store';
import { ApiError } from './api';
import type { ProfileTarget } from './knowledge';

/**
 * The console's 课堂精练 panel: the same status `/dream` shows — 自动整理's
 * last check included — plus run / cancel / revert for a profile this process
 * hosts. A profile run by its own daemon is shown from its state file, read
 * without writing anything back; actions for it go through Feishu (`/dream`
 * in a DM with the bot).
 */

export interface DreamRunView {
  id: string;
  status: DreamRun['status'];
  trigger: 'manual' | 'auto';
  startedAt: number;
  endedAt?: number;
  note?: string;
  sessions: number;
  memoryItems: number;
  skillItems: number;
  rejected: number;
  deferred: number;
  targets: Array<{
    label: string;
    phase: string;
    items: number;
    prUrl?: string;
    prNumber?: number;
    error?: string;
    revertPrUrl?: string;
  }>;
}

export interface DreamView extends Omit<DreamStatusView, 'running' | 'runs'> {
  live: boolean;
  running?: DreamRunView;
  runs: DreamRunView[];
  /** Outcome of the action this response is for. */
  message?: string;
}

export async function dreamView(target: ProfileTarget): Promise<DreamView> {
  const service = target.controls?.dream;
  const status = service
    ? await service.status()
    : await (async () => {
        const paths = profileAppPaths(target.state);
        const state = new DreamStateStore(join(paths.profileDir, 'dream-state.json'));
        await state.load(Date.now(), { readOnly: true });
        return composeDreamStatus({
          state,
          appConfig: target.state.cfg,
          profileConfig: target.state.profileConfig,
          knowledge: target.controls?.knowledge ?? new KnowledgeStore(paths.knowledgeDir),
        });
      })();
  const { running, runs, ...rest } = status;
  return {
    ...rest,
    live: Boolean(target.live && service),
    ...(running ? { running: runView(running) } : {}),
    runs: runs.map(runView),
  };
}

export async function mutateDream(target: ProfileTarget, body: unknown): Promise<DreamView> {
  const action = (body as { action?: unknown } | undefined)?.action;
  const service = target.live ? target.controls?.dream : undefined;
  if (!service) {
    throw new ApiError(409, '这个 profile 不由控制台托管：请在飞书里私聊 bot 发送 /dream run');
  }
  let message: string;
  if (action === 'run') {
    const started = await service.start({ id: target.controls?.botOwnerId ?? 'web-console', name: 'Web 控制台' });
    if ('error' in started) throw new ApiError(409, started.error);
    message = `已开始整理，批次 ${started.run.id}`;
  } else if (action === 'cancel') {
    message = service.cancel() ? '已请求取消，当前步骤结束后停止' : '现在没有在进行的整理';
  } else if (action === 'revert') {
    const id = (body as { id?: unknown }).id;
    if (typeof id !== 'string' || !id) throw new ApiError(400, 'revert needs the batch id');
    const reverted = await service.revert(id);
    if ('error' in reverted) throw new ApiError(409, reverted.error);
    message = reverted.results.map((item) => `${item.label}：${item.note}`).join('；');
  } else {
    throw new ApiError(400, 'action must be run, cancel or revert');
  }
  return { ...(await dreamView(target)), message };
}

function runView(run: DreamRun): DreamRunView {
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger ?? 'manual',
    startedAt: run.startedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    ...(run.note ? { note: run.note } : {}),
    sessions: run.sessions,
    memoryItems: run.memoryItems,
    skillItems: run.skillItems,
    rejected: run.rejected,
    deferred: run.deferred.length,
    targets: run.targets.map((item) => ({
      label: item.label,
      phase: item.phase,
      items: item.items,
      ...(item.prUrl ? { prUrl: item.prUrl } : {}),
      ...(item.prNumber ? { prNumber: item.prNumber } : {}),
      ...(item.error ? { error: item.error } : {}),
      ...(item.revertPrUrl ? { revertPrUrl: item.revertPrUrl } : {}),
    })),
  };
}
