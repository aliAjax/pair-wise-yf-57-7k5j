// 坐标对账底层数学：
// - GCJ-02（火星坐标，手机读数）与 WGS-84 互转，标准公开算法
// - WGS-84 经纬度 → 站点局部网格（站心正东/正北，单位米），基准(datum)变化时网格随之平移
// - 点到样线折线距离，按容差带宽判定样线归属
import type { CRS, DatumRevision, LngLat, SiteCoord, Transect } from './types';

// ---- GCJ-02 常量 ----
const GCJ_A = 6378245;
const GCJ_EE = 0.00669342162296594323;
const OUT_OF_CHINA = (lng: number, lat: number) => lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;

function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.15 * x * y + 0.05 * y * y;
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return ret;
}

/** WGS-84 → GCJ-02 */
export function wgs84ToGcj02(p: LngLat): LngLat {
  const { lng, lat } = p;
  if (OUT_OF_CHINA(lng, lat)) return { lng, lat };
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = lat / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = dLat * 180 / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = dLng * 180 / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lng: lng + dLng, lat: lat + dLat };
}

/** GCJ-02 → WGS-84（迭代反算，2 次足够亚厘米） */
export function gcj02ToWgs84(p: LngLat): LngLat {
  if (OUT_OF_CHINA(p.lng, p.lat)) return { ...p };
  let wgs: LngLat = { ...p };
  for (let i = 0; i < 2; i += 1) {
    const gcj = wgs84ToGcj02(wgs);
    wgs = { lng: wgs.lng + (p.lng - gcj.lng), lat: wgs.lat + (p.lat - gcj.lat) };
  }
  return wgs;
}

/** 按读数坐标系统一换算为 WGS-84 经纬度。站点坐标读数直接视为 WGS-84。 */
export function toWgs84(raw: LngLat, crs: CRS): LngLat {
  return crs === 'gcj02' ? gcj02ToWgs84(raw) : { ...raw };
}

const EARTH_R = 6378137;

/**
 * WGS-84 经纬度 → 站点坐标（站心正东/正北米）。
 * datum.gridShiftE/N 是基准修订相对旧网格原点的平移量：基准一变，
 * 同一点的站点坐标整体平移，归属结论随之重算。
 */
export function toSiteCoord(wgs: LngLat, datum: DatumRevision): SiteCoord {
  const lat0 = datum.origin.lat * Math.PI / 180;
  const dLng = (wgs.lng - datum.origin.lng) * Math.PI / 180;
  const dLat = (wgs.lat - datum.origin.lat) * Math.PI / 180;
  const e = EARTH_R * dLng * Math.cos(lat0) + datum.gridShiftE;
  const n = EARTH_R * dLat + datum.gridShiftN;
  return { e: Math.round(e * 100) / 100, n: Math.round(n * 100) / 100 };
}

/** 读数 → 站点坐标的完整对账换算（原始读数保留在外层）。 */
export function reconcileCoord(raw: LngLat, crs: CRS, datum: DatumRevision): SiteCoord {
  return toSiteCoord(toWgs84(raw, crs), datum);
}

function pointSegDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

export interface MatchResult {
  transectId: string | null;
  distance: number; // 米；null 归属时为到最近样线的距离
}

/** 站点坐标下判定样线归属：取带宽内最近样线；全部超出容差则未归线。 */
export function matchTransect(site: SiteCoord, transects: Transect[]): MatchResult {
  let nearestD = Number.POSITIVE_INFINITY;
  let bestId: string | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  transects.forEach((line) => {
    const pts = line.path;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const dSq = pointSegDistSq(site.e, site.n, pts[i].e, pts[i].n, pts[i + 1].e, pts[i + 1].n);
      const d = Math.sqrt(dSq);
      if (d < nearestD) nearestD = d;
      if (d <= line.bufferM && d < bestD) {
        bestId = line.id;
        bestD = d;
      }
    }
  });
  return { transectId: bestId, distance: Math.round(nearestD * 10) / 10 };
}
