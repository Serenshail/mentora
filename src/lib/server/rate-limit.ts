import "server-only";

/* 进程内令牌桶限流（防御暴力破解 / 滥用 / 简单 DoS）。
 * Vercel Serverless 为多实例，故这是"每实例"的基础防线；
 * 需要全局限流时把 buckets 换成 Upstash/Redis 即可，接口不变。 */

interface Bucket {
  tokens: number;
  updated: number;
}

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 20_000;

export interface RateLimitOpts {
  /** 桶容量（突发上限） */
  capacity: number;
  /** 每秒回填速率 */
  refillPerSec: number;
}

/** 返回 true 表示放行；false 表示超限（调用方应回 429） */
export function rateLimit(key: string, opts: RateLimitOpts): boolean {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) {
    // 粗略清理长时间未用的键，防内存无限增长
    const cutoff = now - 60_000;
    for (const [k, v] of buckets) if (v.updated < cutoff) buckets.delete(k);
  }
  const b = buckets.get(key) ?? { tokens: opts.capacity, updated: now };
  const elapsed = (now - b.updated) / 1000;
  b.tokens = Math.min(opts.capacity, b.tokens + elapsed * opts.refillPerSec);
  b.updated = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

/** 取客户端 IP（优先代理头） */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
