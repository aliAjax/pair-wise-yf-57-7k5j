// 演示数据：站点基准、样线（站点坐标）、手机轨迹点（GCJ-02 原始读数）、
// 站里观察记录（WGS-84 原始读数）、一条缺坐标系的旧记录。
import { wgs84ToGcj02 } from './geo';
import type { DatumRevision, LngLat, Observation, PatrolState, Sample, SiteCoord, TrackPoint, Transect } from './types';
import { dedupeKey } from './reconcile';

const ORIGIN: LngLat = { lng: 103.22, lat: 30.58 };

export const datums: DatumRevision[] = [
  { id: 'd1', name: '站点基准 v1（2026 春季）', origin: ORIGIN, gridShiftE: 0, gridShiftN: 0, activeFrom: '2026-01-01' },
  // v2 网格相对 v1 平移 (-20, +35) 米：靠近带宽边界的记录会翻线
  { id: 'd2', name: '站点基准 v2（2026 秋季联测）', origin: ORIGIN, gridShiftE: -20, gridShiftN: 35, activeFrom: '2026-10-01' }
];

export const transects: Transect[] = [
  { id: 'T1', name: '东坡样线', path: [{ e: 0, n: 0 }, { e: 120, n: 30 }, { e: 240, n: 80 }], bufferM: 40 },
  { id: 'T2', name: '溪谷样线', path: [{ e: 0, n: 60 }, { e: 100, n: 120 }, { e: 220, n: 170 }], bufferM: 35 }
];

const R = 6378137;
function wgsFromSite(site: SiteCoord, datum: DatumRevision): LngLat {
  const lat0 = datum.origin.lat * Math.PI / 180;
  return {
    lng: datum.origin.lng + (site.e - datum.gridShiftE) / (R * Math.cos(lat0)) * 180 / Math.PI,
    lat: datum.origin.lat + (site.n - datum.gridShiftN) / R * 180 / Math.PI
  };
}

function observation(
  input: Omit<Observation, 'site' | 'datumId' | 'transectId' | 'distanceM' | 'prevTransectId' | 'dedupeKey' | 'uploadStatus'>
): Observation {
  return {
    site: null, datumId: null, transectId: null, distanceM: null,
    uploadStatus: 'uploaded',
    dedupeKey: dedupeKey({ at: input.time, rawLng: input.rawLng, rawLat: input.rawLat, note: input.note }),
    ...input
  };
}

function point(input: Omit<TrackPoint, 'site' | 'datumId' | 'transectId' | 'distanceM' | 'uploadStatus' | 'archived' | 'archivedTransectId'>): TrackPoint {
  return { site: null, datumId: null, transectId: null, distanceM: null, uploadStatus: 'uploaded', archived: false, ...input };
}

const d1 = datums[0];

// 设计落点（v1 站点坐标）：o1(120,30) 贴 T1；o2(125,58) 贴 T1，换 v2 后翻到 T2；
// o3(240,80) 在 T1 终点且已归档；旧记录 (40,105) 贴 T2 但缺坐标系。
const o1Wgs = wgsFromSite({ e: 120, n: 30 }, d1);
const o2Wgs = wgsFromSite({ e: 125, n: 58 }, d1);
const o3Wgs = wgsFromSite({ e: 240, n: 80 }, d1);
const legacyWgs = wgsFromSite({ e: 40, n: 105 }, d1);
// 手机轨迹点：保存的是 GCJ-02 原始读数
const p1Gcj = wgs84ToGcj02(wgsFromSite({ e: 60, n: 15 }, d1));
const p2Gcj = wgs84ToGcj02(wgsFromSite({ e: 180, n: 55 }, d1));

const observationsSeed: Observation[] = [
  observation({
    id: 'o1', time: '2026-09-29 07:20', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium',
    rawLng: o1Wgs.lng, rawLat: o1Wgs.lat, crs: 'wgs84', crsInferred: false,
    review: 'pending', archived: false
  }),
  observation({
    id: 'o2', time: '2026-09-29 08:05', note: '红外相机外壳松动，已拍照待补报', risk: 'high',
    rawLng: o2Wgs.lng, rawLat: o2Wgs.lat, crs: 'wgs84', crsInferred: false,
    review: 'done', archived: false
  }),
  observation({
    id: 'o3', time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low',
    rawLng: o3Wgs.lng, rawLat: o3Wgs.lat, crs: 'wgs84', crsInferred: false,
    review: 'done', archived: true, archivedTransectId: 'T1'
  }),
  observation({
    id: 'o-old', time: '2026-09-20 11:30', note: '旧记录：岩羊粪便（导入时缺坐标系，待补齐）', risk: 'low',
    rawLng: legacyWgs.lng, rawLat: legacyWgs.lat, crs: null, crsInferred: true,
    review: 'pending', archived: false
  })
];

const pointsSeed: TrackPoint[] = [
  point({ id: 'p1', at: '2026-09-29 07:20', source: 'gps', rawLng: p1Gcj.lng, rawLat: p1Gcj.lat, crs: 'gcj02', crsInferred: false }),
  point({ id: 'p2', at: '2026-09-29 08:05', source: 'gps', rawLng: p2Gcj.lng, rawLat: p2Gcj.lat, crs: 'gcj02', crsInferred: false })
];

const samplesSeed: Sample[] = [
  { id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, observationId: 'o2', verify: 'done' }
];

export function buildSeedState(): PatrolState {
  return {
    datums,
    activeDatumId: 'd1',
    transects,
    deviceDefaultCRS: 'wgs84',
    points: pointsSeed,
    observations: observationsSeed,
    samples: samplesSeed,
    queue: [],
    acceptedKeys: [],
    online: true,
    failNextSync: false,
    notices: ['种子数据已载入：轨迹点为手机 GCJ-02 读数，样线/观察为站点 WGS-84 读数；o-old 缺坐标系。']
  };
}
