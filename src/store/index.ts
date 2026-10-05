import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';
import type { Attribution, DatumParams, GeoPoint, OutboxEntry, StationPoint, Transect } from '../coord/types';
import { toStation, withDefaultSystem } from '../coord/transform';
import { attributionChanged, judgeTransect } from '../coord/attribution';
import { idempotencyKey, processOutbox } from '../coord/outbox';

export type SyncState = 'local' | 'queued' | 'synced' | 'conflict';
export interface PatrolObservation {
  id: string; time: string; note: string; risk: 'low' | 'medium' | 'high'; sync: SyncState; reviewed: boolean;
  /** 原始读数（手机坐标），上传时原样保留 */
  raw: GeoPoint | null;
  /** 换算后的站点坐标 */
  station: StationPoint | null;
  /** 样线归属结论 */
  attribution: Attribution | null;
  /** 已归档：基准变化时保留原结论 */
  archived: boolean;
}
export interface TrackPoint {
  id: string; latitude: number; longitude: number; at: string; source: 'gps' | 'manual';
  raw: GeoPoint | null;
  station: StationPoint | null;
  attribution: Attribution | null;
}
export interface Sample {
  id: string; code: string; species: string; count: number; status: 'draft' | 'submitted' | 'verified';
  /** 关联观察记录：样线归属一变，核验退回待处理 */
  observationId: string | null;
}
interface State {
  observations: PatrolObservation[];
  points: TrackPoint[];
  samples: Sample[];
  transects: Transect[];
  datum: DatumParams;
  outbox: OutboxEntry[];
  conflict: string | null;
}

const STATION_ORIGIN = { lat: 30.58, lng: 103.21 };

const seedTransects: Transect[] = [
  { id: 't1', name: '东坡样线', coords: [{ lat: 100, lng: 0 }, { lat: 900, lng: 0 }] },
  { id: 't2', name: '溪谷样线', coords: [{ lat: 100, lng: 400 }, { lat: 900, lng: 400 }] },
];

const seedDatum: DatumParams = {
  id: 'd1', name: '站点基准 2026', originLat: STATION_ORIGIN.lat, originLng: STATION_ORIGIN.lng,
  dLat: 0, dLng: 0, scale: 1, rotation: 0, updatedAt: '2026-09-29T00:00:00.000Z',
};

function rawPoint(lat: number, lng: number, system: GeoPoint['system'] = 'gcj02'): GeoPoint {
  return { lat, lng, system };
}

const seed: State = {
  observations: [
    { id: 'o1', time: '2026-09-29 07:20', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', sync: 'synced', reviewed: false, raw: rawPoint(30.582, 103.213), station: null, attribution: null, archived: false },
    { id: 'o2', time: '2026-09-29 08:05', note: '红外相机外壳松动，已拍照待补报', risk: 'high', sync: 'queued', reviewed: false, raw: rawPoint(30.586, 103.2105), station: null, attribution: null, archived: false },
    { id: 'o3', time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low', sync: 'synced', reviewed: true, raw: rawPoint(30.584, 103.218), station: null, attribution: null, archived: true },
    { id: 'o4', time: '2026-09-29 09:10', note: '样线边界附近发现可疑痕迹，待负责人复核', risk: 'medium', sync: 'synced', reviewed: true, raw: rawPoint(30.583617, 103.212732), station: null, attribution: null, archived: false },
  ],
  points: [
    { id: 'p1', latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps', raw: rawPoint(30.5821, 103.2174), station: null, attribution: null },
    { id: 'p2', latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps', raw: rawPoint(30.5856, 103.2211), station: null, attribution: null },
  ],
  samples: [
    { id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted', observationId: 'o1' },
    { id: 's2', code: 'WD-0929-02', species: '可疑痕迹拍照样本', count: 1, status: 'verified', observationId: 'o4' },
  ],
  transects: seedTransects,
  datum: seedDatum,
  outbox: [],
  conflict: null,
};

/** 用当前基准重算一条记录的站点坐标与归属 */
function reproject(raw: GeoPoint | null, datum: DatumParams, transects: Transect[]): { station: StationPoint | null; attribution: Attribution | null } {
  if (!raw) return { station: null, attribution: null };
  const station = toStation(raw, datum);
  const judged = judgeTransect(station, transects);
  return { station, attribution: { ...judged, status: 'judged', datumVersion: Date.parse(datum.updatedAt) || 0, judgedAt: new Date().toISOString() } };
}

/** 旧记录补齐坐标系后重判：缺坐标系按设备默认，原始读数不变 */
function backfillRaw(raw: GeoPoint | null): GeoPoint | null {
  if (!raw) return raw;
  if (raw.system) return raw;
  return withDefaultSystem(raw);
}

function readState(): State {
  try {
    const saved = Taro.getStorageSync('yf57-patrol-state');
    const parsed = saved ? JSON.parse(saved) as Partial<State> : null;
    // 合并种子默认值，避免旧版本存储缺字段
    const merged: State = {
      ...seed,
      ...parsed,
      transects: parsed?.transects ?? seed.transects,
      datum: parsed?.datum ?? seed.datum,
    };
    // 初始化重算：有原始读数但缺站点坐标/归属的记录（含种子数据与旧记录），
    // 缺坐标系先按设备默认补齐，再用当前基准换算并判断归属
    for (const obs of merged.observations) {
      if (obs.raw && (!obs.station || !obs.attribution)) {
        const raw = backfillRaw(obs.raw);
        if (raw) obs.raw = raw;
        const { station, attribution } = reproject(raw, merged.datum, merged.transects);
        obs.station = station;
        // 已归档记录即使缺结论，补齐后仍保持 archived（结论冻结）
        obs.attribution = obs.archived && attribution ? { ...attribution, status: 'archived' } : attribution;
      }
    }
    for (const point of merged.points) {
      if (point.raw && (!point.station || !point.attribution)) {
        const raw = backfillRaw(point.raw);
        if (raw) point.raw = raw;
        const { station, attribution } = reproject(raw, merged.datum, merged.transects);
        point.station = station;
        point.attribution = attribution;
      }
    }
    return merged;
  } catch { return seed; }
}

const slice = createSlice({
  name: 'patrol', initialState: readState(),
  reducers: {
    addObservation: (state, action: PayloadAction<Omit<PatrolObservation, 'id' | 'time' | 'sync' | 'reviewed' | 'raw' | 'station' | 'attribution' | 'archived'> & { raw?: GeoPoint | null }>) => {
      const raw = action.payload.raw ?? null;
      const { station, attribution } = reproject(raw, state.datum, state.transects);
      const id = `o-${Date.now()}`;
      state.observations.unshift({ id, time: new Date().toLocaleString(), note: action.payload.note, risk: action.payload.risk, sync: 'queued', reviewed: false, raw, station, attribution, archived: false });
      state.outbox.push({ key: idempotencyKey('observation', id, 'local'), kind: 'observation', refId: id, status: 'pending', attempts: 0, lastError: null, createdAt: new Date().toISOString() });
    },
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number; system?: GeoPoint['system'] }>) => {
      const raw = rawPoint(action.payload.latitude, action.payload.longitude, action.payload.system ?? 'gcj02');
      const { station, attribution } = reproject(raw, state.datum, state.transects);
      const id = `p-${Date.now()}`;
      state.points.push({ id, latitude: action.payload.latitude, longitude: action.payload.longitude, at: new Date().toLocaleTimeString(), source: 'gps', raw, station, attribution });
      state.outbox.push({ key: idempotencyKey('point', id, 'local'), kind: 'point', refId: id, status: 'pending', attempts: 0, lastError: null, createdAt: new Date().toISOString() });
    },
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number; observationId?: string | null }>) => {
      const id = `s-${Date.now()}`;
      state.samples.unshift({ id, code: action.payload.code, species: action.payload.species, count: action.payload.count, status: 'draft', observationId: action.payload.observationId ?? null });
      state.outbox.push({ key: idempotencyKey('sample', id, 'local'), kind: 'sample', refId: id, status: 'pending', attempts: 0, lastError: null, createdAt: new Date().toISOString() });
    },
    syncQueue: (state) => {
      const { entries, newlySent } = processOutbox(state.outbox, new Date().toISOString());
      state.outbox = entries;
      for (const sent of newlySent) {
        if (sent.kind === 'observation') {
          const item = state.observations.find((entry) => entry.id === sent.refId);
          if (item) item.sync = 'synced';
        }
      }
      const failed = entries.filter((e) => e.status === 'failed');
      if (failed.length > 0) state.conflict = `有 ${failed.length} 条回传失败，已保留在队列中，可再次同步重试。`;
      else state.conflict = null;
    },
    retryFailed: (state) => {
      const { entries, newlySent } = processOutbox(state.outbox, new Date().toISOString());
      state.outbox = entries;
      for (const sent of newlySent) {
        if (sent.kind === 'observation') {
          const item = state.observations.find((entry) => entry.id === sent.refId);
          if (item) item.sync = 'synced';
        }
      }
      const failed = entries.filter((e) => e.status === 'failed');
      state.conflict = failed.length > 0 ? `仍有 ${failed.length} 条回传失败，已接着重试。` : null;
    },
    resolveConflict: (state, action: PayloadAction<'local' | 'remote'>) => {
      state.observations = state.observations.map((item) => item.sync === 'conflict' ? { ...item, sync: 'synced' } : item);
      state.conflict = null;
      Taro.setStorageSync('yf57-conflict-resolution', action.payload);
    },
    reviewObservation: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((entry) => entry.id === action.payload);
      if (item) item.reviewed = true;
    },
    verifySample: (state, action: PayloadAction<string>) => {
      const item = state.samples.find((entry) => entry.id === action.payload);
      if (item) item.status = 'verified';
    },
    /** 归档：已归档记录在基准变化时保留原结论 */
    archiveObservation: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((entry) => entry.id === action.payload);
      if (item) {
        item.archived = true;
        if (item.attribution) item.attribution = { ...item.attribution, status: 'archived' };
      }
    },
    /**
     * 基准一变：未归档记录失效重算，已归档保留原结论；
     * 样线归属一变，样本核验和负责人复核失效退回待处理。
     */
    changeDatum: (state, action: PayloadAction<Partial<DatumParams>>) => {
      state.datum = { ...state.datum, ...action.payload, updatedAt: new Date().toISOString() };
      for (const obs of state.observations) {
        if (obs.archived) continue; // 已归档保留原结论
        const prev = obs.attribution ?? undefined;
        const raw = backfillRaw(obs.raw);
        if (raw && !obs.raw) obs.raw = raw;
        const { station, attribution } = reproject(raw, state.datum, state.transects);
        obs.station = station;
        obs.attribution = attribution;
        if (attributionChanged(prev, attribution)) {
          obs.reviewed = false; // 负责人复核失效，退回待处理
          for (const sample of state.samples) {
            if (sample.observationId === obs.id && sample.status === 'verified') sample.status = 'submitted'; // 样本核验失效
          }
        }
      }
      for (const point of state.points) {
        const raw = backfillRaw(point.raw);
        if (raw && !point.raw) point.raw = raw;
        const { station, attribution } = reproject(raw, state.datum, state.transects);
        point.station = station;
        point.attribution = attribution;
      }
    },
    /** 旧记录缺坐标系：按设备默认补齐后重判 */
    backfillCoordSystems: (state) => {
      for (const obs of state.observations) {
        if (obs.archived) continue;
        const raw = backfillRaw(obs.raw);
        if (raw && raw.system !== obs.raw?.system) {
          obs.raw = raw;
          const { station, attribution } = reproject(raw, state.datum, state.transects);
          obs.station = station;
          obs.attribution = attribution;
        }
      }
      for (const point of state.points) {
        const raw = backfillRaw(point.raw);
        if (raw && raw.system !== point.raw?.system) {
          point.raw = raw;
          const { station, attribution } = reproject(raw, state.datum, state.transects);
          point.station = station;
          point.attribution = attribution;
        }
      }
    },
  },
});

export const patrolApi = createApi({ reducerPath: 'patrolApi', baseQuery: fakeBaseQuery(), endpoints: (builder) => ({ connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }) }) });
export const { useConnectionQuery } = patrolApi;
export const { addObservation, addPoint, addSample, archiveObservation, backfillCoordSystems, changeDatum, resolveConflict, reviewObservation, retryFailed, syncQueue, verifySample } = slice.actions;
export const store = configureStore({ reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer }, middleware: (getDefault) => getDefault().concat(patrolApi.middleware) });
if (typeof window !== 'undefined') store.subscribe(() => Taro.setStorageSync('yf57-patrol-state', JSON.stringify(store.getState().patrol)));

export type RootState = ReturnType<typeof store.getState>;
