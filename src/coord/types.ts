/** 坐标对账领域模型：手机原始坐标 <-> 站点坐标 <-> 样线归属 */

/** 坐标系：wgs84 原始 GPS、gcj02 火星坐标、station 站点本地坐标 */
export type CoordSystem = 'wgs84' | 'gcj02' | 'station';

/** 原始读数：必须保留，上传/重算都基于它 */
export interface GeoPoint {
  lat: number;
  lng: number;
  system: CoordSystem;
}

/** 换算后的站点坐标 */
export interface StationPoint {
  lat: number;
  lng: number;
}

/** 样线：由站点坐标串成的折线 */
export interface Transect {
  id: string;
  name: string;
  coords: StationPoint[];
}

/**
 * 基准参数：手机坐标系 -> 站点坐标系 的平面转换参数。
 * 基准一变，未归档记录的归属结论全部失效重算。
 */
export interface DatumParams {
  id: string;
  name: string;
  /** 站点原点（经纬度） */
  originLat: number;
  originLng: number;
  /** 平移（度） */
  dLat: number;
  dLng: number;
  /** 缩放 */
  scale: number;
  /** 旋转（弧度） */
  rotation: number;
  updatedAt: string;
}

/** 归属结论状态：pending 待判断 / judged 已判断 / archived 已归档（结论冻结） */
export type AttributionStatus = 'pending' | 'judged' | 'archived';

/** 样线归属结论 */
export interface Attribution {
  transectId: string | null;
  /** 到样线的垂直距离（米），null 表示无法判断（无坐标） */
  distance: number | null;
  status: AttributionStatus;
  /** 结论是基于哪一版基准算出的 */
  datumVersion: number;
  judgedAt: string | null;
}

/** 回传队列条目：幂等 + 重试 */
export interface OutboxEntry {
  /** 幂等键：重复回传只入账一次 */
  key: string;
  kind: 'observation' | 'point' | 'sample';
  refId: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
}
