import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureStore } from '@reduxjs/toolkit';
import reducer, {
  addObservation, addPoint, armFailure, archiveObservation, reupload,
  retryFailed, reviewObservation, setActiveDatum, setDeviceDefaultCRS, syncQueue, verifySample
} from '../src/store/patrolSlice.ts';
import type { PatrolState } from '../src/domain/types.ts';

function makeStore() {
  const preloaded = reducer(undefined, { type: 'noop' });
  return configureStore({ reducer, preloadedState: preloaded as PatrolState });
}

test('端到端：手机点入队→失败→重试入账→重复回传只入账一次', () => {
  const store = makeStore();
  const p = store.getState().points[0];
  store.dispatch(addPoint({ rawLng: p.rawLng + 0.0001, rawLat: p.rawLat, crs: 'gcj02' }));
  assert.ok(store.getState().queue.length >= 1);

  store.dispatch(armFailure());
  store.dispatch(syncQueue());
  const failedJob = store.getState().queue.find((j) => j.status === 'failed');
  assert.ok(failedJob);

  store.dispatch(retryFailed());
  store.dispatch(syncQueue());
  assert.equal(store.getState().queue.filter((j) => j.status === 'failed').length, 0);
  const acceptedAfterFirst = store.getState().acceptedKeys.length;

  // 重复回传同一条：不再产生新的入账
  store.dispatch(reupload({ kind: 'point', refId: store.getState().points.at(-1)!.id }));
  store.dispatch(syncQueue());
  assert.equal(store.getState().acceptedKeys.length, acceptedAfterFirst);
});

test('端到端：基准切换翻线 → 复核与样本核验 stale → 处理后恢复 done', () => {
  const store = makeStore();
  const o2 = store.getState().observations.find((o) => o.id === 'o2')!;
  assert.equal(o2.transectId, 'T1');
  store.dispatch(setActiveDatum('d2'));
  const s = store.getState();
  assert.equal(s.observations.find((o) => o.id === 'o2')!.transectId, 'T2');
  assert.equal(s.observations.find((o) => o.id === 'o2')!.review, 'stale');
  assert.equal(s.samples.find((x) => x.id === 's1')!.verify, 'stale');

  store.dispatch(reviewObservation('o2'));
  store.dispatch(verifySample('s1'));
  assert.equal(store.getState().observations.find((o) => o.id === 'o2')!.review, 'done');
  assert.equal(store.getState().samples.find((x) => x.id === 's1')!.verify, 'done');
});

test('端到端：归档后切基准，归属结论保持锁定', () => {
  const store = makeStore();
  store.dispatch(archiveObservation('o1'));
  store.dispatch(setActiveDatum('d2'));
  const o1 = store.getState().observations.find((o) => o.id === 'o1')!;
  assert.equal(o1.archived, true);
  assert.equal(o1.transectId, 'T1');
});

test('端到端：设备默认坐标系变更后，缺坐标系旧记录重判', () => {
  const store = makeStore();
  const before = store.getState().observations.find((o) => o.id === 'o-old')!.transectId;
  store.dispatch(setDeviceDefaultCRS('gcj02'));
  const legacy = store.getState().observations.find((o) => o.id === 'o-old')!;
  assert.notEqual(legacy.transectId, before);
});

test('端到端：新建观察保留 wgs84 原始读数，先换算再归线并入队', () => {
  const store = makeStore();
  const d1 = store.getState().datums[0];
  // 构造一个换算后落在 T1 路径附近的 wgs84 读数（120,30 站点坐标）
  const R = 6378137;
  const lat0 = d1.origin.lat * Math.PI / 180;
  const rawLng = d1.origin.lng + 120 / (R * Math.cos(lat0)) * 180 / Math.PI;
  const rawLat = d1.origin.lat + 30 / R * 180 / Math.PI;
  store.dispatch(addObservation({ note: '测试观察读数保留', risk: 'low', rawLng, rawLat, crs: 'wgs84' }));
  const o = store.getState().observations.find((x) => x.note === '测试观察读数保留')!;
  assert.ok(Math.abs(o.rawLng - rawLng) <= 1.5e-7, `原始经度应保留（6 位小数），偏差 ${Math.abs(o.rawLng - rawLng)}`);
  assert.equal(o.crs, 'wgs84');
  assert.equal(o.transectId, 'T1');
  assert.ok(o.distanceM! <= 1);
  assert.equal(o.uploadStatus, 'queued');
});
