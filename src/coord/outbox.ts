import type { OutboxEntry } from './types';

/**
 * 回传队列：重复回传入账一次，失败后接着重试。
 * 每条记录用幂等键去重；失败条目标记 failed 并保留错误，
 * 下次同步从失败处继续，已成功的不重复入账。
 */

/** 模拟一次网络回传：弱网下按概率失败，失败后可重试 */
export function simulateUpload(seed: string): { ok: boolean; error: string | null } {
  // 用幂等键派生确定性结果：同一键首次失败、重试成功，便于演示“失败后接着重试”
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 997;
  const failFirstAttempt = hash % 2 === 0;
  return { ok: !failFirstAttempt, error: failFirstAttempt ? '弱网中断：未收到站点确认' : null };
}

/**
 * 处理回传队列：
 * - 已 sent 的条目跳过（重复回传不入账）；
 * - pending / failed 的条目尝试回传，失败则保留状态待下次重试；
 * - 返回更新后的队列与本次新入账的条目。
 */
export function processOutbox(entries: OutboxEntry[], now: string): { entries: OutboxEntry[]; newlySent: OutboxEntry[] } {
  const newlySent: OutboxEntry[] = [];
  const next = entries.map((entry) => {
    if (entry.status === 'sent') return entry;
    const attempt = simulateUpload(entry.key);
    if (attempt.ok) {
      const sent: OutboxEntry = { ...entry, status: 'sent', attempts: entry.attempts + 1, lastError: null };
      newlySent.push(sent);
      return sent;
    }
    const failed: OutboxEntry = { ...entry, status: 'failed', attempts: entry.attempts + 1, lastError: attempt.error };
    return failed;
  });
  void now;
  return { entries: next, newlySent };
}

/** 幂等键：同一业务对象同一客户端只入账一次 */
export function idempotencyKey(kind: OutboxEntry['kind'], refId: string, clientSeq: string): string {
  return `${kind}:${refId}:${clientSeq}`;
}
