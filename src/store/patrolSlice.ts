import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { buildSeedState } from '../domain/seed';
import { applyDeviceDefaultCRS, dedupeKey, recomputeAll, recomputeObservation, recomputePoint } from '../domain/reconcile';
import { isDuplicateUpload, makeJob, pointDedupeKey, processSyncQueue } from '../domain/sync';
import type { CRS, DatumRevision, Observation, PatrolState, Risk, Sample, Transect } from '../domain/types';
import { storage } from '../platform/storage';

const STORAGE_KEY = 'yf57-coordinate-reconcile-state';

function readState(): PatrolState {
  const saved = storage.get<PatrolState>(STORAGE_KEY);
  if (saved) return migrate(saved);
  const seed = buildSeedState();
  return runInitialReconcile(seed);
}

/** 载入后按当前基准做一次全量对账（保留归档结论）。 */
function runInitialReconcile(state: PatrolState): PatrolState {
  const r = recomputeAll(state, 'datum');
  // 初次载入不弹一屏重算通知，只保留数据
  return { ...state, points: r.points, observations: r.observations, samples: r.samples };
}

/** 旧版本状态补齐新字段。 */
function migrate(raw: PatrolState): PatrolState {
  const base = buildSeedState();
  const merged: PatrolState = { ...base, ...raw };
  merged.points = (raw.points ?? base.points).map((p) => ({
    ...p,
    crs: p.crs ?? null,
    crsInferred: p.crsInferred ?? p.crs == null,
    site: p.site ?? null,
    datumId: p.datumId ?? null,
    transectId: p.transectId ?? null,
    distanceM: p.distanceM ?? null,
    uploadStatus: p.uploadStatus ?? 'uploaded',
    archived: p.archived ?? false
  }));
  merged.observations = (raw.observations ?? base.observations).map((o) => ({
    ...o,
    crs: o.crs ?? null,
    crsInferred: o.crsInferred ?? o.crs == null,
    site: o.site ?? null,
    datumId: o.datumId ?? null,
    transectId: o.transectId ?? null,
    distanceM: o.distanceM ?? null,
    review: o.review ?? 'pending',
    archived: o.archived ?? false,
    uploadStatus: o.uploadStatus ?? 'uploaded',
    dedupeKey: o.dedupeKey ?? dedupeKey({ at: o.time, rawLng: o.rawLng, rawLat: o.rawLat, note: o.note })
  }));
  merged.samples = (raw.samples ?? base.samples).map((s) => ({ ...s, verify: s.verify ?? 'pending' }));
  merged.queue = raw.queue ?? [];
  merged.acceptedKeys = raw.acceptedKeys ?? [];
  merged.notices = [];
  return runInitialReconcile(merged);
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

const slice = createSlice({
  name: 'coordinateReconcile',
  initialState: readState(),
  reducers: {
    /** 巡护员离线记轨迹点：保留手机原始读数（默认 gcj02），换算站点坐标后判归属并入队。 */
    addPoint: (state, action: PayloadAction<{ rawLng: number; rawLat: number; source?: 'gps' | 'manual'; crs?: CRS }>) => {
      const at = new Date().toLocaleString();
      const point = {
        id: nextId('p'),
        at,
        source: action.payload.source ?? 'gps',
        rawLng: round6(action.payload.rawLng),
        rawLat: round6(action.payload.rawLat),
        crs: action.payload.crs ?? 'gcj02',
        crsInferred: false,
        site: null,
        datumId: null,
        transectId: null,
        distanceM: null,
        uploadStatus: 'queued' as const,
        archived: false
      };
      const r = recomputePoint(point, state, 'created');
      state.points.push(r.item);
      const key = pointDedupeKey(r.item);
      if (!isDuplicateUpload(state, key)) {
        state.queue.push(makeJob('point', r.item.id, key));
      } else {
        pushNotice(state, '重复轨迹点已拦截，只保留首次入账记录');
      }
    },

    /** 站里观察记录：保留站点原始读数（wgs84），换算后判归属并入队。可同时登记样本。 */
    addObservation: (
      state,
      action: PayloadAction<{
        note: string; risk: Risk; rawLng: number; rawLat: number; crs?: CRS;
        legacyMissingCRS?: boolean; sample?: { species: string; count: number };
      }>
    ) => {
      const time = new Date().toLocaleString();
      const a = action.payload;
      const missing = a.legacyMissingCRS === true;
      const obs: Observation = {
        id: nextId('o'),
        time,
        note: a.note,
        risk: a.risk,
        rawLng: round6(a.rawLng),
        rawLat: round6(a.rawLat),
        crs: missing ? null : (a.crs ?? 'wgs84'),
        crsInferred: missing,
        site: null,
        datumId: null,
        transectId: null,
        prevTransectId: null,
        distanceM: null,
        review: 'pending',
        archived: false,
        uploadStatus: 'queued',
        dedupeKey: dedupeKey({ at: time, rawLng: round6(a.rawLng), rawLat: round6(a.rawLat), note: a.note })
      };
      const r = recomputeObservation(obs, { ...state, samples: state.samples }, 'created');
      state.observations.unshift(r.item);
      state.samples = r.samples;
      if (a.sample) {
        state.samples.unshift({
          id: nextId('s'),
          code: `WD-${Date.now().toString().slice(-5)}`,
          species: a.sample.species,
          count: a.sample.count,
          observationId: r.item.id,
          verify: 'pending'
        });
      }
      state.notices.push(...r.notices.map((n) => n.message));
      if (!isDuplicateUpload(state, obs.dedupeKey)) {
        state.queue.push(makeJob('observation', r.item.id, obs.dedupeKey));
      } else {
        pushNotice(state, '重复回传的观察记录已拦截，服务器只入账一次');
      }
    },

    /** 登记样本并挂到观察记录上。 */
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number; observationId: string | null }>) => {
      const sample: Sample = { id: nextId('s'), ...action.payload, verify: 'pending' };
      state.samples.unshift(sample);
    },

    /** 基准一变：未归档全部失效重算；已归档保留原结论。 */
    setActiveDatum: (state, action: PayloadAction<string>) => {
      if (state.activeDatumId === action.payload) return;
      state.activeDatumId = action.payload;
      const r = recomputeAll(state, 'datum');
      state.points = r.points;
      state.observations = r.observations;
      state.samples = r.samples;
      state.notices.push(...r.notices.map((n) => n.message));
      const datumName = state.datums.find((d) => d.id === action.payload)?.name ?? action.payload;
      pushNotice(state, `基准切换为「${datumName}」：未归档记录已按新基准重算，已归档保留原结论`);
    },

    /** 样线几何/带宽编辑后全量重算归属，归属变化级联失效。 */
    updateTransect: (state, action: PayloadAction<Transect>) => {
      state.transects = state.transects.map((t) => (t.id === action.payload.id ? action.payload : t));
      const r = recomputeAll(state, 'transects');
      state.points = r.points;
      state.observations = r.observations;
      state.samples = r.samples;
      state.notices.push(...r.notices.map((n) => n.message));
    },

    /** 设备默认坐标系变化：缺坐标系的旧记录按新默认补齐再重判。 */
    setDeviceDefaultCRS: (state, action: PayloadAction<CRS>) => {
      if (state.deviceDefaultCRS === action.payload) return;
      state.deviceDefaultCRS = action.payload;
      const r = applyDeviceDefaultCRS(state, action.payload);
      state.points = r.points;
      state.observations = r.observations;
      state.samples = r.samples;
      state.notices.push(...r.notices.map((n) => n.message));
    },

    /** 回驻地同步：重复入账一次，失败作业保留，下次接着重试。 */
    syncQueue: (state) => {
      const r = processSyncQueue(state);
      state.queue = r.queue;
      state.points = r.points;
      state.observations = r.observations;
      state.acceptedKeys = r.acceptedKeys;
      state.failNextSync = r.failNextSync;
      if (!r.online) {
        pushNotice(state, '仍处于离线，队列保留，联网后接着同步');
      } else {
        const parts: string[] = [];
        if (r.synced) parts.push(`入账 ${r.synced} 条`);
        if (r.skipped) parts.push(`重复跳过 ${r.skipped} 条`);
        if (r.failed) parts.push(`失败 ${r.failed} 条（保留队列，下次接着重试）`);
        pushNotice(state, parts.length ? `同步完成：${parts.join('，')}` : '队列暂无待传记录');
      }
    },

    retryFailed: (state) => {
      state.queue = state.queue.map((j) => (j.status === 'failed' ? { ...j, status: 'queued', lastError: null } : j));
    },

    /** 模拟下一轮同步首个作业失败一次。 */
    armFailure: (state) => {
      state.failNextSync = true;
    },

    setOnline: (state, action: PayloadAction<boolean>) => {
      state.online = action.payload;
    },

    /** 模拟同一条记录再次回传（验证只入账一次）。 */
    reupload: (state, action: PayloadAction<{ kind: 'observation' | 'point'; refId: string }>) => {
      if (action.payload.kind === 'point') {
        const p = state.points.find((x) => x.id === action.payload.refId);
        if (!p) return;
        const key = pointDedupeKey(p);
        if (isDuplicateUpload(state, key)) {
          pushNotice(state, '重复回传被拦截：该轨迹点已入账，不会重复计数');
          return;
        }
        state.queue.push(makeJob('point', p.id, key));
      } else {
        const o = state.observations.find((x) => x.id === action.payload.refId);
        if (!o) return;
        if (isDuplicateUpload(state, o.dedupeKey)) {
          pushNotice(state, '重复回传被拦截：该观察记录已入账，不会重复计数');
          return;
        }
        state.queue.push(makeJob('observation', o.id, o.dedupeKey));
      }
    },

    reviewObservation: (state, action: PayloadAction<string>) => {
      const o = state.observations.find((x) => x.id === action.payload);
      if (o) o.review = 'done';
    },

    verifySample: (state, action: PayloadAction<string>) => {
      const s = state.samples.find((x) => x.id === action.payload);
      if (s) s.verify = 'done';
    },

    /** 归档：锁定当前归属结论，之后基准变化不再重算。 */
    archiveObservation: (state, action: PayloadAction<string>) => {
      const o = state.observations.find((x) => x.id === action.payload);
      if (o && !o.archived) {
        o.archived = true;
        o.archivedTransectId = o.transectId;
        o.review = 'done';
      }
    },

    addDatum: (state, action: PayloadAction<DatumRevision>) => {
      state.datums.push(action.payload);
    },

    clearNotices: (state) => {
      state.notices = [];
    },

    resetDemo: () => runInitialReconcile(buildSeedState())
  }
});

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function pushNotice(state: PatrolState, message: string): void {
  state.notices.push(message);
}

export const {
  addDatum,
  addObservation,
  addPoint,
  addSample,
  archiveObservation,
  armFailure,
  clearNotices,
  reupload,
  retryFailed,
  reviewObservation,
  setActiveDatum,
  setDeviceDefaultCRS,
  setOnline,
  syncQueue,
  updateTransect,
  verifySample,
  resetDemo
} = slice.actions;

export const patrolActions = slice.actions;
export default slice.reducer;
