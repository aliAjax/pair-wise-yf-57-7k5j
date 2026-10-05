// 坐标对账领域模型
// 原始读数（手机 GCJ-02 / 站点 WGS-84）一律保留；先换算站点坐标，再判定样线归属。

/** 读数坐标系：轨迹点用手机坐标 gcj02；样线与观察记录用站点坐标 wgs84。 */
export type CRS = 'gcj02' | 'wgs84';

export type LngLat = { lng: number; lat: number };

/** 站点坐标：站心局部网格，正东/正北，单位米。 */
export type SiteCoord = { e: number; n: number };

/** 站点基准修订版：基准一变，未归档记录按新网格重算。 */
export interface DatumRevision {
  id: string;
  name: string;
  /** 站心网格原点（WGS-84 经纬度） */
  origin: LngLat;
  /** 相对上一版网格的平移量（米），用于复现基准修订导致的归属翻转 */
  gridShiftE: number;
  gridShiftN: number;
  activeFrom: string;
}

/** 样线：几何按站点坐标维护，带宽内判定归属。 */
export interface Transect {
  id: string;
  name: string;
  /** 路径折点，站点坐标（米） */
  path: SiteCoord[];
  /** 归属容差带宽（米） */
  bufferM: number;
}

/** 复核/核验状态。归属变化即失效退回待处理。 */
export type WorkflowState = 'pending' | 'done' | 'stale';

export type TrackSource = 'gps' | 'manual';

export interface TrackPoint {
  id: string;
  at: string;
  source: TrackSource;
  // 原始读数（上传保留，永不覆写）
  rawLng: number;
  rawLat: number;
  crs: CRS | null;
  /** 旧记录缺坐标系：按设备默认补齐前为 null */
  crsInferred: boolean;
  // 换算结果
  site: SiteCoord | null;
  datumId: string | null;
  transectId: string | null;
  distanceM: number | null;
  // 同步生命周期
  uploadStatus: 'local' | 'queued' | 'failed' | 'uploaded';
  archived: boolean;
  /** 已归档记录锁定的归属结论；基准变化也不改 */
  archivedTransectId?: string | null;
}

export type Risk = 'low' | 'medium' | 'high';

export interface Observation {
  id: string;
  time: string;
  note: string;
  risk: Risk;
  // 原始读数
  rawLng: number;
  rawLat: number;
  crs: CRS | null;
  crsInferred: boolean;
  // 换算与归属
  site: SiteCoord | null;
  datumId: string | null;
  transectId: string | null;
  prevTransectId?: string | null;
  distanceM: number | null;
  // 工作流
  review: WorkflowState;
  archived: boolean;
  archivedTransectId?: string | null;
  // 同步生命周期
  uploadStatus: 'local' | 'queued' | 'failed' | 'uploaded';
  /** 重复回传去重键（时间+位置+笔记哈希），入账一次 */
  dedupeKey: string;
}

export interface Sample {
  id: string;
  code: string;
  species: string;
  count: number;
  /** 关联的观察记录；样线归属一变，核验失效退回待处理 */
  observationId: string | null;
  verify: WorkflowState;
}

/** 上传队列作业：失败保留在队首方向接着重试；重复键只入账一次。 */
export interface UploadJob {
  id: string;
  kind: 'observation' | 'point';
  refId: string;
  dedupeKey: string;
  attempts: number;
  status: 'queued' | 'retrying' | 'failed' | 'done';
  lastError: string | null;
  queuedAt: string;
}

export interface PatrolState {
  datums: DatumRevision[];
  activeDatumId: string;
  transects: Transect[];
  deviceDefaultCRS: CRS;
  points: TrackPoint[];
  observations: Observation[];
  samples: Sample[];
  queue: UploadJob[];
  /** 服务器已入账去重键 */
  acceptedKeys: string[];
  online: boolean;
  /** 下次同步强制失败一次，用于演示“失败后接着重试” */
  failNextSync: boolean;
  notices: string[];
}
