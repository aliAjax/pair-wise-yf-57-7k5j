import type { CoordSystem, DatumParams, GeoPoint, StationPoint } from './types';

/**
 * 坐标换算：手机原始读数 -> 站点坐标。
 *
 * 手机侧记录的是 wgs84/gcj02 原始读数（必须原样保留），
 * 站点侧样线是站点本地坐标。基准参数（DatumParams）描述
 * 手机坐标系到站点坐标系的平面转换关系；基准参数变化时，
 * 未归档记录的归属结论失效并重算。
 */

const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.1 * y * y + 0.2 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

/** wgs84 -> gcj02（火星坐标），境外不偏移 */
export function wgs84ToGcj02(lng: number, lat: number): { lng: number; lat: number } {
  if (outOfChina(lng, lat)) return { lng, lat };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lng: lng + dLng, lat: lat + dLat };
}

/** 任意手机坐标系 -> gcj02 */
export function toGcj02(point: GeoPoint): { lng: number; lat: number } {
  if (point.system === 'wgs84') return wgs84ToGcj02(point.lng, point.lat);
  return { lng: point.lng, lat: point.lat };
}

const DEG_TO_RAD = Math.PI / 180;
/** 纬度方向 1 度对应的米数（WGS84 平均曲率近似） */
const METERS_PER_DEG_LAT = 111132.92 - 559.82 * Math.cos(2 * 0) + 1.175 * Math.cos(4 * 0);

/**
 * gcj02 经纬度 -> 站点平面坐标（米），以站点原点为 (0,0)，东为 x、北为 y。
 * 转换含平移、旋转、缩放，参数即“基准”。
 */
export function gcj02ToStation(lng: number, lat: number, datum: DatumParams): StationPoint {
  const east = (lng - datum.originLng) * METERS_PER_DEG_LAT * Math.cos(datum.originLat * DEG_TO_RAD);
  const north = (lat - datum.originLat) * METERS_PER_DEG_LAT;
  const cosR = Math.cos(datum.rotation);
  const sinR = Math.sin(datum.rotation);
  const x = datum.scale * (cosR * east - sinR * north) + datum.dLng;
  const y = datum.scale * (sinR * east + cosR * north) + datum.dLat;
  return { lat: y, lng: x };
}

/** 手机原始读数 -> 站点坐标：先统一到 gcj02，再套基准转换 */
export function toStation(point: GeoPoint, datum: DatumParams): StationPoint {
  const gcj = toGcj02(point);
  return gcj02ToStation(gcj.lng, gcj.lat, datum);
}

/** 设备默认坐标系：旧记录缺坐标系时按此补齐 */
export const DEVICE_DEFAULT_SYSTEM: CoordSystem = 'gcj02';

/** 补齐坐标系：缺坐标系的旧记录按设备默认坐标系处理，原始读数不变 */
export function withDefaultSystem(point: Omit<GeoPoint, 'system'> & { system?: CoordSystem }): GeoPoint {
  return { lat: point.lat, lng: point.lng, system: point.system ?? DEVICE_DEFAULT_SYSTEM };
}
