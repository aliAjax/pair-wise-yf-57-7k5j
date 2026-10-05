// 坐标对账核心规则（纯函数，便于单测）：
// 1) 上传保留原始读数；先换算站点坐标，再判定样线归属
// 2) 基准一变：未归档记录失效重算；已归档保留原结论
// 3) 样线归属一变：样本核验与负责人复核失效，退回待处理
// 4) 旧记录缺坐标系：按设备默认补齐，再重判
import { matchTransect, reconcileCoord } from './geo';
import type { CRS, DatumRevision, Observation, PatrolState, Sample, SiteCoord, TrackPoint, Transect, WorkflowState } from './types';

export interface RecomputeNotice {
  kind: 'reassign' | 'unassigned' | 'review-stale' | 'verify-stale' | 'crs-inferred';
  refId: string;
  message: string;
}

export interface RecomputeResult<T> {
  item: T;
  notices: RecomputeNotice[];
}

function activeTransects(state: Pick<PatrolState, 'transects'>): Transect[] {
  return state.transects;
}

function activeDatum(state: Pick<PatrolState, 'datums' | 'activeDatumId'>): DatumRevision {
  return state.datums.find((d) => d.id === state.activeDatumId) ?? state.datums[0];
}

/** 旧记录缺坐标系时按设备默认补齐。返回新 crs 及是否补齐。 */
export function resolveCRS(raw: { crs?: string | null }, deviceDefault: CRS): { crs: CRS; inferred: boolean } {
  if (raw.crs === 'gcj02' || raw.crs === 'wgs84') return { crs: raw.crs, inferred: false };
  return { crs: deviceDefault, inferred: true };
}

/**
 * 对单条轨迹点做一次完整对账。
 * @param reason 触发原因：新建/重试、基准变化、设备默认坐标系变化
 */
export function recomputePoint(
  point: TrackPoint,
  state: Pick<PatrolState, 'datums' | 'activeDatumId' | 'transects' | 'deviceDefaultCRS'>,
  reason: 'created' | 'datum' | 'device-default' = 'created'
): RecomputeResult<TrackPoint> {
  const notices: RecomputeNotice[] = [];
  const datum = activeDatum(state);
  // 旧记录缺坐标系：按设备默认补齐再换算
  const { crs, inferred } = resolveCRS(point, state.deviceDefaultCRS);
  const filled = point.crs === null ? { ...point, crs } : point;
  const site = reconcileCoord({ lng: filled.rawLng, lat: filled.rawLat }, crs, datum);
  const { transectId, distance } = matchTransect(site, activeTransects(state));

  // 已归档：保留原结论，只刷新站点坐标读数，不动归属
  if (filled.archived) {
    return {
      item: { ...filled, site, datumId: datum.id, transectId: filled.archivedTransectId ?? filled.transectId, distanceM: distance },
      notices
    };
  }

  const previous = filled.transectId;
  const firstAssignment = filled.datumId === null;
  if (previous !== null && transectId === null && !firstAssignment) {
    notices.push({ kind: 'unassigned', refId: filled.id, message: `轨迹点 ${filled.id} 超出全部样线带宽，归属已置空（原：${previous}）` });
  } else if (previous !== null && transectId !== null && previous !== transectId) {
    notices.push({ kind: 'reassign', refId: filled.id, message: `轨迹点 ${filled.id} 样线归属由 ${previous} 变为 ${transectId}` });
  }
  if (inferred && (point.crs === null || reason === 'device-default')) {
    notices.push({ kind: 'crs-inferred', refId: filled.id, message: `轨迹点 ${filled.id} 缺坐标系，按设备默认 ${crs} 补齐后重判` });
  }

  return {
    item: { ...filled, site, datumId: datum.id, transectId, distanceM: distance },
    notices
  };
}

/** 归属一变时，复核状态失效退回待处理（已归档不动）。 */
function decayReview(prev: WorkflowState, changed: boolean, archived: boolean): WorkflowState {
  if (archived || !changed) return prev;
  return prev === 'done' ? 'stale' : 'pending';
}

/** 归属一变时，关联样本核验失效退回待处理。 */
export function decaySamplesForObservation(
  samples: Sample[],
  observationId: string,
  changed: boolean
): { samples: Sample[]; notices: RecomputeNotice[] } {
  if (!changed) return { samples, notices: [] };
  const notices: RecomputeNotice[] = [];
  const next = samples.map((s) => {
    if (s.observationId !== observationId || s.verify !== 'done') return s;
    notices.push({ kind: 'verify-stale', refId: s.id, message: `样本 ${s.code} 的观察归属变化，核验失效退回待处理` });
    return { ...s, verify: 'stale' as WorkflowState };
  });
  return { samples: next, notices };
}

/**
 * 对单条观察记录做完整对账。
 * 归属变化会级联：负责人复核失效 + 关联样本核验失效。
 */
export function recomputeObservation(
  obs: Observation,
  state: Pick<PatrolState, 'datums' | 'activeDatumId' | 'transects' | 'deviceDefaultCRS' | 'samples'>,
  reason: 'created' | 'datum' | 'device-default' = 'created'
): RecomputeResult<Observation> & { samples: Sample[] } {
  const notices: RecomputeNotice[] = [];
  const datum = activeDatum(state);
  const { crs, inferred } = resolveCRS(obs, state.deviceDefaultCRS);
  const filled = obs.crs === null ? { ...obs, crs } : obs;
  const site = reconcileCoord({ lng: filled.rawLng, lat: filled.rawLat }, crs, datum);
  const { transectId, distance } = matchTransect(site, activeTransects(state));

  // 已归档：保留原结论
  if (filled.archived) {
    return {
      item: { ...filled, site, datumId: datum.id, transectId: filled.archivedTransectId ?? filled.transectId, distanceM: distance },
      samples: state.samples,
      notices
    };
  }

  const previous = filled.transectId;
  // 首次判定（此前从未对账过，datumId 为空）不算归属变化；基准/样线重算时的翻线才算
  const firstAssignment = filled.datumId === null;
  const changed = !firstAssignment && previous !== transectId;

  if (previous !== null && transectId === null && !firstAssignment) {
    notices.push({ kind: 'unassigned', refId: filled.id, message: `观察「${filled.note}」超出全部样线带宽，归属已置空（原：${previous}）` });
  } else if (transectId !== null && previous !== transectId) {
    notices.push({
      kind: 'reassign',
      refId: filled.id,
      message: previous === null
        ? `观察「${filled.note}」新归入样线 ${transectId}`
        : `观察「${filled.note}」样线归属由 ${previous} 变为 ${transectId}`
    });
  }
  if (inferred && (filled.crs === null || reason === 'device-default')) {
    notices.push({ kind: 'crs-inferred', refId: filled.id, message: `观察「${filled.note}」缺坐标系，按设备默认 ${crs} 补齐后重判` });
  }

  const review = decayReview(filled.review, changed, filled.archived);
  if (changed && review === 'stale') {
    notices.push({ kind: 'review-stale', refId: filled.id, message: `观察「${filled.note}」归属变化，负责人复核失效退回待处理` });
  }

  const { samples, notices: sampleNotices } = decaySamplesForObservation(state.samples, filled.id, changed);
  notices.push(...sampleNotices);

  return {
    item: {
      ...filled,
      site,
      datumId: datum.id,
      transectId,
      prevTransectId: changed ? previous : filled.prevTransectId,
      distanceM: distance,
      review
    },
    samples,
    notices
  };
}

/** 基准变化（或样线几何变化）后的全量重算：未归档失效重算，已归档保留原结论。 */
export function recomputeAll(
  state: PatrolState,
  reason: 'datum' | 'transects'
): { points: TrackPoint[]; observations: Observation[]; samples: Sample[]; notices: RecomputeNotice[] } {
  const notices: RecomputeNotice[] = [];
  const points: TrackPoint[] = [];
  for (const p of state.points) {
    const r = recomputePoint(p, state, reason === 'datum' ? 'datum' : 'created');
    points.push(r.item);
    notices.push(...r.notices);
  }
  let samples = state.samples;
  const observations: Observation[] = [];
  for (const o of state.observations) {
    const r = recomputeObservation(o, { ...state, samples }, reason === 'datum' ? 'datum' : 'created');
    observations.push(r.item);
    samples = r.samples;
    notices.push(...r.notices);
  }
  return { points, observations, samples, notices };
}

/** 设备默认坐标系变化：旧记录缺坐标系的按新默认补齐后重判。 */
export function applyDeviceDefaultCRS(
  state: PatrolState,
  crs: Exclude<TrackPoint['crs'], null>
): { points: TrackPoint[]; observations: Observation[]; samples: Sample[]; notices: RecomputeNotice[] } {
  const notices: RecomputeNotice[] = [];
  let work: PatrolState = { ...state, deviceDefaultCRS: crs };
  // crsInferred 的记录此前可能已被旧默认补齐，重算前先清空，强制按新默认补齐
  const points = state.points.map((p) => {
    if (!p.crsInferred) return p;
    const r = recomputePoint({ ...p, crs: null }, work, 'device-default');
    notices.push(...r.notices);
    return r.item;
  });
  work = { ...work, points };
  let samples = work.samples;
  const observations = state.observations.map((o) => {
    if (!o.crsInferred) return o;
    const r = recomputeObservation({ ...o, crs: null }, { ...work, samples }, 'device-default');
    samples = r.samples;
    notices.push(...r.notices);
    return r.item;
  });
  return { points, observations, samples, notices };
}

/** 去重键：时间+原始读数+笔记，重复回传命中即不再入账。 */
export function dedupeKey(input: { at: string; rawLng: number; rawLat: number; note?: string }): string {
  const body = `${input.at}|${input.rawLng.toFixed(6)}|${input.rawLat.toFixed(6)}|${input.note ?? ''}`;
  let hash = 0;
  for (let i = 0; i < body.length; i += 1) {
    hash = (hash << 5) - hash + body.charCodeAt(i);
    hash |= 0;
  }
  return `dup-${(hash >>> 0).toString(36)}`;
}

export function siteLabel(site: SiteCoord | null): string {
  return site ? `E${site.e.toFixed(1)} / N${site.n.toFixed(1)}` : '未换算';
}
