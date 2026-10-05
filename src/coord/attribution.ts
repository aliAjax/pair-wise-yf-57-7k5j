import type { Attribution, DatumParams, GeoPoint, Transect } from './types';
import { toStation, withDefaultSystem } from './transform';

/**
 * 样线归属判断：把换算后的站点坐标点，配到距离最近的样线。
 * 归属只依据站点坐标，不直接用手机原始坐标判断。
 */

/** 点到线段的平面距离（米），站点坐标系下 x=东 y=北 */
export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 点到样线折线的最短距离（米） */
export function distanceToTransect(station: { lat: number; lng: number }, transect: Transect): number {
  let min = Infinity;
  for (let i = 0; i < transect.coords.length - 1; i++) {
    const a = transect.coords[i];
    const b = transect.coords[i + 1];
    const d = distanceToSegment(station.lng, station.lat, a.lng, a.lat, b.lng, b.lat);
    if (d < min) min = d;
  }
  return min;
}

export interface JudgeResult {
  transectId: string | null;
  distance: number | null;
}

/** 判断归属：无坐标则无法判断；否则取最近样线 */
export function judgeTransect(station: { lat: number; lng: number } | null, transects: Transect[]): JudgeResult {
  if (!station) return { transectId: null, distance: null };
  let best: { id: string; d: number } | null = null;
  for (const transect of transects) {
    const d = distanceToTransect(station, transect);
    if (!best || d < best.d) best = { id: transect.id, d };
  }
  if (!best) return { transectId: null, distance: null };
  return { transectId: best.id, distance: Math.round(best.d) };
}

/**
 * 重算单条记录的归属结论。
 * - 保留原始读数：缺坐标系先按设备默认补齐；
 * - 已归档记录保留原结论（status=archived），不覆盖；
 * - 未归档记录用当前基准换算后重新判断。
 */
export function recomputeAttribution(
  raw: (Omit<GeoPoint, 'system'> & { system?: GeoPoint['system'] }) | null | undefined,
  prev: Attribution | undefined,
  datum: DatumParams,
  transects: Transect[],
  now: string,
): Attribution {
  if (prev?.status === 'archived') return prev;
  if (!raw) return { transectId: null, distance: null, status: 'pending', datumVersion: 0, judgedAt: null };
  const point = withDefaultSystem(raw);
  const station = toStation(point, datum);
  const judged = judgeTransect(station, transects);
  return {
    transectId: judged.transectId,
    distance: judged.distance,
    status: 'judged',
    datumVersion: datumVersionOf(datum),
    judgedAt: now,
  };
}

/** 基准版本号：用更新时间戳标识，基准一变版本号即变 */
export function datumVersionOf(datum: DatumParams): number {
  return Date.parse(datum.updatedAt) || 0;
}

/** 归属是否发生变化（用于触发复核/核验失效） */
export function attributionChanged(prev: Attribution | null | undefined, next: Attribution | null | undefined): boolean {
  if (prev?.status === 'archived') return false;
  return (prev?.transectId ?? null) !== (next?.transectId ?? null);
}
