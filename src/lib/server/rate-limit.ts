import "server-only";
import crypto from "node:crypto";
import { dbGet, dbPut, hasHealthyRemoteDb } from "./db";

/* ============================================================
 * 令牌桶限流（防暴力破解 / 滥用 / 简单 DoS）
 *
 * 两级实现：
 *  · rateLimitPersistent（推荐）—— 桶存远端 KV（D1/Upstash），跨 isolate
 *    一致；Vercel 多实例下"每实例独立桶"等于形同虚设，高危端点必须用它。
 *    无远端 KV 或 KV 故障时自动回退进程内桶（不阻断真实用户）。
 *  · rateLimit —— 进程内桶，仅本地开发/低价值端点使用。
 * ============================================================ */

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

const rlPath = (key: string): string =>
  `rl/${process.env.VERCEL_ENV || "dev"}/${crypto
    .createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 32)}.json`;

/** 跨进程令牌桶：读-改-写非原子，误差只可能多放几个请求，作为防线足够 */
export async function rateLimitPersistent(key: string, opts: RateLimitOpts): Promise<boolean> {
  if (!hasHealthyRemoteDb()) return rateLimit(key, opts);
  const now = Date.now();
  const path = rlPath(key);
  try {
    const b = (await dbGet<Bucket>(path, { encrypted: true })) ?? { tokens: opts.capacity, updated: now };
    const elapsed = (now - b.updated) / 1000;
    b.tokens = Math.min(opts.capacity, b.tokens + elapsed * opts.refillPerSec);
    b.updated = now;
    if (b.tokens < 1) {
      await dbPut(path, b, { encrypted: true }).catch(() => {});
      return false;
    }
    b.tokens -= 1;
    await dbPut(path, b, { encrypted: true }).catch(() => {});
    return true;
  } catch {
    return rateLimit(key, opts); // KV 故障降级为进程桶：限流失效好过功能不可用
  }
}

/** 取客户端 IP（优先代理头） */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
