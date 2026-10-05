// 存储适配：小程序/H5 走 Taro；Node 单测环境退化为内存存储，避免拖入 Taro runtime 全局变量。
type StorageLike = {
  getStorageSync: (key: string) => unknown;
  setStorageSync: (key: string, value: string) => void;
  removeStorageSync: (key: string) => void;
};

const memory = new Map<string, string>();
let cached: StorageLike | null = null;

function pick(): StorageLike {
  if (cached) return cached;
  if (typeof window !== 'undefined') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('@tarojs/taro');
      const taro: StorageLike = mod.default ?? mod;
      if (typeof taro.getStorageSync === 'function') {
        cached = taro;
        return cached;
      }
    } catch {
      // 继续走内存兜底
    }
  }
  cached = {
    getStorageSync: (key) => (memory.has(key) ? memory.get(key) : ''),
    setStorageSync: (key, value) => { memory.set(key, value); },
    removeStorageSync: (key) => { memory.delete(key); }
  };
  return cached;
}

export const storage = {
  get<T>(key: string): T | null {
    const raw = pick().getStorageSync(key);
    if (!raw) return null;
    if (typeof raw !== 'string') return raw as T;
    try { return JSON.parse(raw) as T; } catch { return null; }
  },
  set(key: string, value: unknown): void {
    pick().setStorageSync(key, JSON.stringify(value));
  },
  remove(key: string): void {
    pick().removeStorageSync(key);
  }
};
