// 上传/回传：重复回传入账一次；失败作业保留在队列，下次同步接着重试。
import type { Observation, PatrolState, TrackPoint, UploadJob } from './types';

export interface SyncOutcome {
  queue: UploadJob[];
  points: TrackPoint[];
  observations: Observation[];
  acceptedKeys: string[];
  failNextSync: boolean;
  online: boolean;
  synced: number;
  skipped: number;
  failed: number;
}

function setStatus<T extends { id: string; uploadStatus: TrackPoint['uploadStatus'] }>(
  items: T[],
  id: string,
  status: T['uploadStatus']
): T[] {
  if (!id) return items;
  return items.map((it) => (it.id === id ? { ...it, uploadStatus: status } : it));
}

/**
 * 处理同步队列。
 * - online=false：不动队列，等恢复网络
 * - 重复键：已入账则幂等跳过（重复回传只入账一次）
 * - failNextSync：本轮首个作业强制失败一次，作业保留为 failed，下次同步接着重试
 */
export function processSyncQueue(state: PatrolState): SyncOutcome {
  const base: SyncOutcome = {
    queue: state.queue,
    points: state.points,
    observations: state.observations,
    acceptedKeys: state.acceptedKeys,
    failNextSync: state.failNextSync,
    online: state.online,
    synced: 0,
    skipped: 0,
    failed: 0
  };
  if (!state.online) return base;

  let points = state.points;
  let observations = state.observations;
  const acceptedKeys = [...state.acceptedKeys];
  let failArmed = state.failNextSync;

  const queue = state.queue.map((job) => {
    if (job.status === 'done') return job;

    // 重复回传：服务器已有该键 → 幂等完成，不再重复入账
    if (acceptedKeys.includes(job.dedupeKey)) {
      base.skipped += 1;
      return { ...job, status: 'done' as const };
    }

    // 失败注入（演示弱网）：只让本轮第一个在途作业失败，之后接着重试
    if (failArmed) {
      failArmed = false;
      base.failed += 1;
      const next: UploadJob = { ...job, attempts: job.attempts + 1, status: 'failed', lastError: '网络中断，服务器未确认' };
      points = setStatus(points, job.kind === 'point' ? job.refId : '', 'failed') as TrackPoint[];
      observations = setStatus(observations, job.kind === 'observation' ? job.refId : '', 'failed') as Observation[];
      return next;
    }

    acceptedKeys.push(job.dedupeKey);
    base.synced += 1;
    points = setStatus(points, job.kind === 'point' ? job.refId : '', 'uploaded') as TrackPoint[];
    observations = setStatus(observations, job.kind === 'observation' ? job.refId : '', 'uploaded') as Observation[];
    return { ...job, status: 'done' as const, attempts: job.attempts + 1, lastError: null };
  });

  return { ...base, queue, points, observations, acceptedKeys, failNextSync: failArmed };
}

/** 入队前去重：服务器已入账，或队列中已有同键在途作业，都不再重复入账。 */
export function isDuplicateUpload(state: PatrolState, key: string): boolean {
  if (state.acceptedKeys.includes(key)) return true;
  return state.queue.some((j) => j.dedupeKey === key && j.status !== 'done');
}

export function pointDedupeKey(p: { id?: string; at: string; rawLng: number; rawLat: number }): string {
  return `dup-p|${p.id ?? ''}|${p.at}|${p.rawLng.toFixed(6)}|${p.rawLat.toFixed(6)}`;
}

export function makeJob(kind: UploadJob['kind'], refId: string, key: string): UploadJob {
  return {
    id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    refId,
    dedupeKey: key,
    attempts: 0,
    status: 'queued',
    lastError: null,
    queuedAt: new Date().toLocaleString()
  };
}
