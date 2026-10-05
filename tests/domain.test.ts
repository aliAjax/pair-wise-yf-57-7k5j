import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gcj02ToWgs84, matchTransect, reconcileCoord, wgs84ToGcj02 } from '../src/domain/geo.ts';
import { applyDeviceDefaultCRS, recomputeAll, recomputeObservation } from '../src/domain/reconcile.ts';
import { processSyncQueue } from '../src/domain/sync.ts';
import { buildSeedState } from '../src/domain/seed.ts';
import type { PatrolState } from '../src/domain/types.ts';

test('GCJ-02 ↔ WGS-84 往返误差在亚厘米量级', () => {
  const gcj = { lng: 103.2241, lat: 30.5862 };
  const wgs = gcj02ToWgs84(gcj);
  const back = wgs84ToGcj02(wgs);
  assert.ok(Math.abs(back.lng - gcj.lng) < 1e-9);
  assert.ok(Math.abs(back.lat - gcj.lat) < 1e-9);
});

test('手机 GCJ-02 轨迹点换算站点坐标后归到 T1（跨坐标系对账）', () => {
  const state = buildSeedState();
  const d1 = state.datums[0];
  const p1 = state.points[0];
  const site = reconcileCoord({ lng: p1.rawLng, lat: p1.rawLat }, 'gcj02', d1);
  const m = matchTransect(site, state.transects);
  assert.equal(m.transectId, 'T1');
  assert.ok(m.distance < 5);
});

test('基准一变：未归档 o2 由 T1 翻到 T2，已完成复核失效为 stale，关联样本核验失效', () => {
  const state0 = buildSeedState();
  // 初始全量对账（模拟载入）
  const r0 = recomputeAll(state0, 'datum');
  let state: PatrolState = { ...state0, points: r0.points, observations: r0.observations, samples: r0.samples };
  const before = state.observations.find((o) => o.id === 'o2')!;
  assert.equal(before.transectId, 'T1');
  assert.equal(before.review, 'done');

  state.activeDatumId = 'd2';
  const r = recomputeAll(state, 'datum');
  state = { ...state, points: r.points, observations: r.observations, samples: r.samples };

  const o2 = state.observations.find((o) => o.id === 'o2')!;
  assert.equal(o2.transectId, 'T2');
  assert.equal(o2.prevTransectId, 'T1');
  assert.equal(o2.review, 'stale');
  const sample = state.samples.find((s) => s.id === 's1')!;
  assert.equal(sample.verify, 'stale');
});

test('基准一变：已归档 o3 保留原结论 T1', () => {
  let state: PatrolState = buildSeedState();
  state = { ...state, ...recomputeAll(state, 'datum') } as PatrolState;
  state.activeDatumId = 'd2';
  const r = recomputeAll(state, 'datum');
  const o3 = r.observations.find((o) => o.id === 'o3')!;
  assert.equal(o3.transectId, 'T1');
  assert.equal(o3.review, 'done');
});

test('旧记录缺坐标系：按设备默认 wgs84 补齐后归到 T2', () => {
  let state: PatrolState = buildSeedState();
  state = { ...state, ...recomputeAll(state, 'datum') } as PatrolState;
  const legacy = state.observations.find((o) => o.id === 'o-old')!;
  assert.equal(legacy.crs, 'wgs84');
  assert.equal(legacy.crsInferred, true);
  assert.equal(legacy.transectId, 'T2');
});

test('设备默认坐标系改 gcj02：缺坐标系旧记录按 gcj02 重判，归属随之变化', () => {
  let state: PatrolState = buildSeedState();
  state = { ...state, ...recomputeAll(state, 'datum') } as PatrolState;
  const byWgs = state.observations.find((o) => o.id === 'o-old')!.transectId;
  const r = applyDeviceDefaultCRS(state, 'gcj02');
  const legacy = r.observations.find((o) => o.id === 'o-old')!;
  assert.notEqual(legacy.transectId, byWgs);
  assert.equal(legacy.crs, 'gcj02');
});

test('同步：首作业失败保留 failed，下轮重试成功', () => {
  let state: PatrolState = buildSeedState();
  state.queue = [{
    id: 'j1', kind: 'point', refId: 'p1', dedupeKey: 'k1', attempts: 0,
    status: 'queued', lastError: null, queuedAt: 't'
  }];
  state.failNextSync = true;
  const first = processSyncQueue(state);
  assert.equal(first.failed, 1);
  assert.equal(first.queue[0].status, 'failed');
  assert.equal(first.queue[0].attempts, 1);
  assert.equal(first.acceptedKeys.includes('k1'), false);

  let next: PatrolState = {
    ...state, queue: first.queue.map((j) => ({ ...j, status: 'queued' as const })),
    points: first.points, observations: first.observations,
    acceptedKeys: first.acceptedKeys, failNextSync: false
  };
  const second = processSyncQueue(next);
  assert.equal(second.synced, 1);
  assert.equal(second.queue[0].status, 'done');
  assert.equal(second.acceptedKeys.includes('k1'), true);
  next = { ...next, queue: second.queue, points: second.points, observations: second.observations, acceptedKeys: second.acceptedKeys };

  // 同一键再次回传：不重复入账
  next.queue = [...next.queue, { id: 'j2', kind: 'point', refId: 'p1', dedupeKey: 'k1', attempts: 0, status: 'queued', lastError: null, queuedAt: 't2' }];
  const third = processSyncQueue(next);
  assert.equal(third.synced, 0);
  assert.equal(third.skipped, 1);
  assert.equal(third.acceptedKeys.filter((k) => k === 'k1').length, 1);
});

test('归属未变时复核不失效；未复核记录归属变化保持 pending', () => {
  const state = buildSeedState();
  const r0 = recomputeAll(state, 'datum');
  const o1 = r0.observations.find((o) => o.id === 'o1')!;
  assert.equal(o1.transectId, 'T1');
  assert.equal(o1.review, 'pending');
  // 同基准再算一次，无变化
  const again = recomputeObservation(o1, { ...state, samples: r0.samples }, 'created');
  assert.equal(again.item.review, 'pending');
});
