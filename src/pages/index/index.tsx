import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell, Dialog as NutDialog } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import { addObservation, addPoint, addSample, archiveObservation, backfillCoordSystems, changeDatum, resolveConflict, reviewObservation, retryFailed, syncQueue, verifySample, type RootState } from '../../store';
import type { Attribution } from '../../coord/types';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;

function systemLabel(system: string | undefined): string {
  if (system === 'wgs84') return 'WGS84';
  if (system === 'gcj02') return 'GCJ02';
  return '缺坐标系';
}

function attributionLabel(attribution: Attribution | null | undefined, transects: { id: string; name: string }[]): string {
  if (!attribution) return '无坐标，未判断';
  if (attribution.status === 'archived') return '已归档，保留原结论';
  if (attribution.transectId === null) return '未配到样线';
  const name = transects.find((t) => t.id === attribution.transectId)?.name ?? attribution.transectId;
  return `${name}${attribution.distance !== null ? `（${attribution.distance}m）` : ''}`;
}

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { note: '', risk: 'low', species: '', count: '1' } });
  const queued = state.observations.filter((item) => item.sync !== 'synced').length;
  const outboxFailed = state.outbox.filter((e) => e.status === 'failed').length;
  const outboxPending = state.outbox.filter((e) => e.status === 'pending').length;

  const recordPoint = async () => {
    try {
      const result = await Taro.getLocation({ type: 'gcj02' });
      dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude, system: 'gcj02' }));
    } catch {
      dispatch(addPoint({ latitude: 30.5, longitude: 103.2, system: 'gcj02' }));
    }
  };

  const submit = (values: FormValues) => {
    dispatch(addObservation({ note: values.note, risk: values.risk }));
    if (values.species) {
      const linked = state.observations[0];
      dispatch(addSample({ code: `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1, observationId: linked?.id ?? null }));
    }
    reset();
  };

  const rotateDatum = () => {
    // 模拟站点基准更新（旋转角 +0.15 弧度），未归档记录失效重算，边界记录归属翻转
    dispatch(changeDatum({ rotation: state.datum.rotation + 0.15 }));
  };

  return <View className="page">
    <View className="hero"><Text className="eyebrow">FIELD PATROL / PORT 62022</Text><Text className="title">{t.title}</Text><Text className="sub">弱网也能记录，联网后统一同步；负责人只复核有风险的记录。</Text></View>
    <View className="metrics"><View><Text>轨迹点</Text><Text className="metric">{state.points.length}</Text></View><View><Text>待同步</Text><Text className="metric warn">{queued}</Text></View><View><Text>样本</Text><Text className="metric">{state.samples.length}</Text></View></View>

    <View className="card">
      <View className="card-title">坐标对账</View>
      <Text className="hint">手机原始坐标保留，换算到站点坐标后再判断样线归属；基准一变，未归档重算、已归档保留原结论。</Text>
      <View className="datum-row"><Text className="muted">当前基准：{state.datum.name}（旋转 {state.datum.rotation.toFixed(3)}）</Text></View>
      <View className="datum-row"><Text className="muted">样线：{state.transects.map((t) => t.name).join('、')}</Text></View>
      <View className="alert-actions">
        <Button size="mini" onClick={rotateDatum}>模拟基准更新</Button>
        <Button size="mini" onClick={() => dispatch(backfillCoordSystems())}>补齐旧坐标系并重判</Button>
      </View>
    </View>

    <View className="card"><View className="card-title">现场记录</View><form onSubmit={handleSubmit(submit)}><Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} /><View className="two"><Input className="input" placeholder="物种或样本名称" {...register('species')} /><Input className="input" type="number" placeholder="数量" {...register('count')} /></View><View className="risk"><Text>风险等级</Text><select {...register('risk')}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></View><Button className="primary" formType="submit">{t.save}</Button><Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button></form></View>

    {state.conflict && <View className="alert conflict"><Text>{state.conflict}</Text><View className="alert-actions"><Button size="mini" onClick={() => dispatch(resolveConflict('local'))}>保留本地</Button><Button size="mini" onClick={() => dispatch(resolveConflict('remote'))}>合并云端意见</Button></View></View>}

    <View className="card">
      <View className="card-title">{t.sync}<Text className="count">{queued} 条</Text></View>
      <Text className="hint">回传队列：{outboxPending} 条待传、{outboxFailed} 条失败（失败后接着重试，重复回传只入账一次）。</Text>
      <Button className="secondary" onClick={() => dispatch(syncQueue())}>模拟恢复联网并同步</Button>
      <Button className="secondary" onClick={() => dispatch(retryFailed())}>重试失败回传</Button>
    </View>

    <View className="card"><View className="card-title">观察记录</View><ScrollView scrollY className="list">{state.observations.map((item) => <View className="observation" key={item.id}><View><Text className="obs-title">{item.risk === 'high' ? '高风险 · ' : ''}{item.note}{item.archived ? ' · 已归档' : ''}</Text><Text className="muted">{item.time} · {item.sync}</Text><Text className="muted">原始读数：{item.raw ? `${item.raw.lat.toFixed(5)}, ${item.raw.lng.toFixed(5)}（${systemLabel(item.raw.system)}）` : '无'}</Text><Text className="muted">站点坐标：{item.station ? `${item.station.lat.toFixed(1)}, ${item.station.lng.toFixed(1)} m` : '未换算'}</Text><Text className="muted">归属：{attributionLabel(item.attribution, state.transects)}</Text></View><View className="row-actions"><Button size="mini" disabled={item.reviewed || item.risk === 'low'} onClick={() => dispatch(reviewObservation(item.id))}>{item.reviewed ? '已复核' : '复核'}</Button>{!item.archived && <Button size="mini" onClick={() => dispatch(archiveObservation(item.id))}>归档</Button>}</View></View>)}</ScrollView></View>

    <View className="card"><View className="card-title">轨迹与样本</View>{state.points.slice(-3).map((point) => <NutCell key={point.id} title={`${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`} description={`${point.at} · ${point.source} · ${systemLabel(point.raw?.system)} → ${attributionLabel(point.attribution, state.transects)}`} />)}{state.samples.map((sample) => <View className="sample" key={sample.id}><Text>{sample.code} · {sample.species} × {sample.count}</Text><Button size="mini" disabled={sample.status === 'verified'} onClick={() => dispatch(verifySample(sample.id))}>{sample.status === 'verified' ? '已核验' : '核验'}</Button></View>)}</View>
    <NutDialog title="离线说明" content="轨迹点和记录会写入本地存储，恢复网络后再合并。" visible={false} />
  </View>;
}
