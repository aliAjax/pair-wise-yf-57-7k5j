import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
  addObservation, addPoint, archiveObservation, armFailure, clearNotices,
  patrolActions, reupload, retryFailed, reviewObservation, setActiveDatum, setDeviceDefaultCRS,
  setOnline, syncQueue, verifySample
} from '../../store/patrolSlice';
import type { RootState } from '../../store';
import { siteLabel } from '../../domain/reconcile';
import { storage } from '../../platform/storage';
import type { Observation, TrackPoint } from '../../domain/types';
import './index.scss';

interface ObsForm { note: string; risk: 'low' | 'medium' | 'high'; lng: string; lat: string; species: string; count: string; }
interface PointForm { lng: string; lat: string; crs: 'gcj02' | 'wgs84'; }

const crsLabel = (crs: TrackPoint['crs']) => (crs === null ? '缺失·待补齐' : crs === 'gcj02' ? '手机 GCJ-02' : '站点 WGS-84');
const uploadLabel: Record<TrackPoint['uploadStatus'], string> = { local: '本地', queued: '待传', failed: '失败待重试', uploaded: '已入账' };
const reviewLabel: Record<Observation['review'], string> = { pending: '待复核', done: '已复核', stale: '复核失效·待处理' };

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const { register: regObs, handleSubmit: submitObs, reset: resetObs } = useForm<ObsForm>({
    defaultValues: { note: '', risk: 'medium', lng: '103.22131', lat: '30.58054', species: '', count: '1' }
  });
  const { register: regPoint, handleSubmit: submitPoint, reset: resetPoint } = useForm<PointForm>({
    defaultValues: { lng: '', lat: '', crs: 'gcj02' }
  });

  const queuedJobs = state.queue.filter((j) => j.status !== 'done').length;
  const failedJobs = state.queue.filter((j) => j.status === 'failed').length;
  const transectName = (id: string | null) => state.transects.find((x) => x.id === id)?.name ?? (id ?? '— 未归线 —');

  const recordGpsPoint = async () => {
    let raw = { latitude: 30.5856, longitude: 103.2219 };
    try { raw = await Taro.getLocation({ type: 'gcj02' }); } catch { /* H5 无定位时用演示读数 */ }
    dispatch(addPoint({ rawLng: raw.longitude, rawLat: raw.latitude, source: 'gps', crs: 'gcj02' }));
  };

  const onObservation = (v: ObsForm) => {
    const rawLng = Number(v.lng);
    const rawLat = Number(v.lat);
    if (!Number.isFinite(rawLng) || !Number.isFinite(rawLat)) return;
    dispatch(addObservation({
      note: v.note, risk: v.risk, rawLng, rawLat, crs: 'wgs84',
      ...(v.species ? { sample: { species: v.species, count: Number(v.count) || 1 } } : {})
    }));
    resetObs();
  };

  const onManualPoint = (v: PointForm) => {
    const rawLng = Number(v.lng);
    const rawLat = Number(v.lat);
    if (!Number.isFinite(rawLng) || !Number.isFinite(rawLat)) return;
    dispatch(addPoint({ rawLng, rawLat, source: 'manual', crs: v.crs }));
    resetPoint({ lng: '', lat: '', crs: 'gcj02' });
  };

  return <View className="page">
    <View className="hero">
      <Text className="eyebrow">COORDINATE RECONCILIATION / 坐标对账</Text>
      <Text className="title">{t.title}</Text>
      <Text className="sub">原始读数保留 → 换算站点坐标 → 判定样线归属；基准/样线变化自动重算并级联失效。</Text>
    </View>

    {/* 对账控制 */}
    <View className="card">
      <View className="card-title">对账基准与坐标系</View>
      <View className="ctl-row">
        <Text className="ctl-label">站点基准</Text>
        <select className="ctl-select" value={state.activeDatumId} onChange={(e) => dispatch(setActiveDatum(e.target.value))}>
          {state.datums.map((d) => <option key={d.id} value={d.id}>{d.name}{d.id === state.activeDatumId ? '（生效中）' : ''}</option>)}
        </select>
      </View>
      <View className="ctl-row">
        <Text className="ctl-label">设备默认坐标系</Text>
        <select className="ctl-select" value={state.deviceDefaultCRS} onChange={(e) => dispatch(setDeviceDefaultCRS(e.target.value as 'gcj02' | 'wgs84'))}>
          <option value="wgs84">WGS-84（站点读数默认）</option>
          <option value="gcj02">GCJ-02（手机读数默认）</option>
        </select>
      </View>
      <View className="ctl-row">
        <Text className="ctl-label">网络</Text>
        <View className="seg">
          <button className={state.online ? 'seg-btn on' : 'seg-btn'} onClick={() => dispatch(setOnline(true))}>在线</button>
          <button className={!state.online ? 'seg-btn on' : 'seg-btn'} onClick={() => dispatch(setOnline(false))}>离线</button>
        </View>
      </View>
      <Text className="hint">切换基准：未归档记录全部失效重算；已归档记录保留原结论。切换设备默认：缺坐标系的旧记录按新默认补齐重判。</Text>
    </View>

    {/* 记录入口 */}
    <View className="metrics">
      <View><Text>轨迹点</Text><Text className="metric">{state.points.length}</Text></View>
      <View><Text>待传队列</Text><Text className="metric warn">{queuedJobs}</Text></View>
      <View><Text>失效待处理</Text><Text className="metric stale">{state.observations.filter((o) => o.review === 'stale').length + state.samples.filter((s) => s.verify === 'stale').length}</Text></View>
    </View>

    <View className="card">
      <View className="card-title">站里观察记录<Text className="count">读数 WGS-84</Text></View>
      <form onSubmit={submitObs(onObservation)}>
        <Textarea className="textarea" placeholder="观察、痕迹、设备问题或现场风险" {...regObs('note', { required: true })} />
        <View className="two">
          <Input className="input" placeholder="经度" {...regObs('lng')} />
          <Input className="input" placeholder="纬度" {...regObs('lat')} />
        </View>
        <View className="two">
          <Input className="input" placeholder="物种/样本（可空）" {...regObs('species')} />
          <Input className="input" type="number" placeholder="数量" {...regObs('count')} />
        </View>
        <View className="risk"><Text>风险等级</Text>
          <select {...regObs('risk')}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select>
        </View>
        <Button className="primary" formType="submit">{t.save}</Button>
      </form>
    </View>

    <View className="card">
      <View className="card-title">巡护员轨迹点<Text className="count">读数 GCJ-02</Text></View>
      <Button className="secondary" onClick={recordGpsPoint}>记录当前手机轨迹点（GCJ-02 原始读数）</Button>
      <form onSubmit={submitPoint(onManualPoint)} className="manual-point">
        <View className="two">
          <Input className="input" placeholder="手机经度 gcj02" {...regPoint('lng')} />
          <Input className="input" placeholder="手机纬度 gcj02" {...regPoint('lat')} />
        </View>
        <View className="risk"><Text>读数坐标系</Text>
          <select {...regPoint('crs')}><option value="gcj02">GCJ-02 手机</option><option value="wgs84">WGS-84 站点</option></select>
        </View>
        <Button className="secondary" formType="submit">手工补录轨迹点</Button>
      </form>
    </View>

    {/* 同步 */}
    <View className="card">
      <View className="card-title">回驻地同步<Text className="count">{queuedJobs} 待传 · {failedJobs} 失败</Text></View>
      <View className="btn-row">
        <Button className="primary" onClick={() => dispatch(syncQueue())}>{state.online ? '立即同步' : '离线暂存（恢复网络后同步）'}</Button>
        <Button className="secondary" disabled={failedJobs === 0} onClick={() => { dispatch(retryFailed()); dispatch(syncQueue()); }}>失败重试</Button>
      </View>
      <View className="btn-row">
        <Button className="ghost" onClick={() => dispatch(armFailure())}>模拟下轮首个作业失败</Button>
        <Button className="ghost" onClick={() => {
          const target = state.observations[0];
          if (target) dispatch(reupload({ kind: 'observation', refId: target.id }));
        }}>模拟重复回传最近观察</Button>
      </View>
      <Text className="hint">重复回传只入账一次（按时间+原始读数+笔记去重）；失败作业保留在队列，下次同步接着重试。</Text>
      {state.queue.filter((j) => j.status !== 'done').length > 0 && <ScrollView scrollY className="queue">
        {state.queue.filter((j) => j.status !== 'done').map((j) => (
          <View className="queue-item" key={j.id}>
            <Text>{j.kind === 'point' ? '轨迹点' : '观察'} · {j.refId}</Text>
            <Text className={j.status === 'failed' ? 'tag fail' : 'tag'}>{j.status === 'failed' ? `失败×${j.attempts} 待重试` : j.status === 'retrying' ? '重试中' : '排队中'}</Text>
          </View>
        ))}
      </ScrollView>}
    </View>

    {/* 通知 */}
    {state.notices.length > 0 && <View className="card notices">
      <View className="card-title"><Text>对账事件</Text><Button size="mini" onClick={() => dispatch(clearNotices())}>清空</Button></View>
      {state.notices.slice(-8).map((n, i) => <Text className="notice" key={`${i}-${n}`}>· {n}</Text>)}
    </View>}

    {/* 观察记录 */}
    <View className="card">
      <View className="card-title">观察记录 · 样线归属对账</View>
      <ScrollView scrollY className="list">
        {state.observations.map((item) => {
          const sample = state.samples.find((s) => s.observationId === item.id);
          return <View className="observation" key={item.id}>
            <View className="obs-body">
              <Text className="obs-title">{item.risk === 'high' ? '高风险 · ' : ''}{item.note}</Text>
              <Text className="muted">{item.time} · {uploadLabel[item.uploadStatus]}{item.archived ? ' · 已归档（结论锁定）' : ''}</Text>
              <Text className="muted">原始读数：{item.rawLat.toFixed(6)}, {item.rawLng.toFixed(6)}（{crsLabel(item.crs)}{item.crsInferred ? ' · 已按默认补齐' : ''}）</Text>
              <Text className="muted">站点坐标：{siteLabel(item.site)} · 距线 {item.distanceM ?? '—'} m</Text>
              <Text className="assign">
                归属：<b>{transectName(item.transectId)}</b>
                {item.prevTransectId !== undefined && item.prevTransectId !== item.transectId && <Text className="flip"> （原 {transectName(item.prevTransectId)}，已变更）</Text>}
              </Text>
              <Text className={item.review === 'stale' ? 'review stale' : 'review'}>负责人复核：{reviewLabel[item.review]}</Text>
              {sample && <Text className={sample.verify === 'stale' ? 'review stale' : 'review'}>
                样本 {sample.code}（{sample.species}）核验：{sample.verify === 'done' ? '已核验' : sample.verify === 'stale' ? '核验失效·退回待处理' : '待核验'}
              </Text>}
            </View>
            <View className="obs-actions">
              {sample && <Button size="mini" disabled={sample.verify === 'done'} onClick={() => dispatch(verifySample(sample.id))}>样本核验</Button>}
              <Button size="mini" disabled={item.review === 'done' || item.archived} onClick={() => dispatch(reviewObservation(item.id))}>复核</Button>
              <Button size="mini" disabled={item.archived} onClick={() => dispatch(archiveObservation(item.id))}>归档</Button>
              <Button size="mini" onClick={() => dispatch(reupload({ kind: 'observation', refId: item.id }))}>重复回传</Button>
            </View>
          </View>;
        })}
      </ScrollView>
    </View>

    {/* 轨迹点 */}
    <View className="card">
      <View className="card-title">轨迹点 · 跨坐标系统一归线</View>
      {state.points.map((p) => (
        <View className="point-row" key={p.id}>
          <View>
            <Text className="obs-title">{p.at} · {p.source === 'gps' ? 'GPS' : '手工'} · {uploadLabel[p.uploadStatus]}</Text>
            <Text className="muted">原始读数：{p.rawLat.toFixed(6)}, {p.rawLng.toFixed(6)}（{crsLabel(p.crs)}）</Text>
            <Text className="muted">站点坐标：{siteLabel(p.site)} · 距线 {p.distanceM ?? '—'} m</Text>
          </View>
          <View className="point-side">
            <Text className="assign">{transectName(p.transectId)}</Text>
            <Button size="mini" onClick={() => dispatch(reupload({ kind: 'point', refId: p.id }))}>重复回传</Button>
          </View>
        </View>
      ))}
    </View>

    <View className="card">
      <Button className="ghost" onClick={() => { storage.remove('yf57-coordinate-reconcile-state'); dispatch(patrolActions.resetDemo()); }}>重置演示数据</Button>
    </View>
  </View>;
}
