import "server-only";
import crypto from "node:crypto";
import { dbGet, dbPut, dbDelete, dbList, hasHealthyRemoteDb } from "./db";
import { deployEnv } from "./deploy-env";

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
/* 清理节流：旧实现「只要超阈值就每次调用整表扫描」，洪泛下包括正常用户在内的
 * 每个请求都要付一次 O(map 大小) 的同步扫描（放大器）。改为最多 1s 扫一次。 */
const SWEEP_MIN_INTERVAL_MS = 1_000;
let lastBucketSweepAt = 0;

export interface RateLimitOpts {
  /** 桶容量（突发上限） */
  capacity: number;
  /** 每秒回填速率 */
  refillPerSec: number;
}

/** 返回 true 表示放行；false 表示超限（调用方应回 429） */
export function rateLimit(key: string, opts: RateLimitOpts): boolean {
  const now = Date.now();
  if (buckets.size > MAX_KEYS && now - lastBucketSweepAt > SWEEP_MIN_INTERVAL_MS) {
    lastBucketSweepAt = now;
    // 粗略清理长时间未用的键，防内存无限增长
    const cutoff = now - 60_000;
    for (const [k, v] of buckets) if (v.updated < cutoff) buckets.delete(k);
    /* 60s 窗口内新插入的键清不掉，洪泛速率×60s 就是稳态规模——仍可能无界。
     * 仍超阈值就按插入序（Map 保证插入序，最早插入的排最前）淘汰到阈值以内，
     * 给 map 一个硬上限；此处只会在「已被 >2 万唯一键洪泛」时才发生。 */
    if (buckets.size > MAX_KEYS) {
      for (const k of buckets.keys()) {
        if (buckets.size <= MAX_KEYS) break;
        buckets.delete(k);
      }
    }
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
  `rl/${deployEnv()}/${crypto
    .createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 32)}.json`;

/* rl/ 桶只有在华为 DCS 通道才带原生 TTL（db.ts 的 DCS_TTL_SECONDS 给 rl/ 配了 1h EX）。
 * D1/Upstash/RDS/GitHub 通道没有任何过期机制，而每个唯一 clientIp 都会为每个端点
 * （chat/reset/admin/...）留下一个永久的 rl/<env>/<hash>.json——公网流量下 IP 只增不减，
 * 存储无界蔓延。quota.ts v17 修过同类「日键永不清理、无界增长」，这里同款处理：
 * 每进程最多扫一次/小时，删掉 updated 早于 1h 的桶（桶的实际作用窗口只有 60s，1h 未动必死）。
 * 不 await、失败无所谓——清理是一次额外出网，绝不能挡在用户首字节前面。 */
const RL_SWEEP_INTERVAL_MS = 3600_000;
const RL_STALE_MS = 3600_000; // 与 DCS 通道的 rl/ TTL 同口径
const RL_SWEEP_MAX_KEYS = 200; // 单次最多检查的键数，避免巨目录把一次清理拖很久
let lastRlSweepAt = 0;
function sweepRlKeys(now: number): void {
  if (now - lastRlSweepAt < RL_SWEEP_INTERVAL_MS) return;
  lastRlSweepAt = now;
  void (async () => {
    try {
      const dir = `rl/${deployEnv()}`;
      const files = await dbList(dir);
      let checked = 0;
      for (const f of files) {
        if (checked++ >= RL_SWEEP_MAX_KEYS) break;
        const p = `${dir}/${f.name}`;
        const b = await dbGet<Bucket>(p, { encrypted: true }).catch(() => null);
        if (b && typeof b.updated === "number" && now - b.updated > RL_STALE_MS) {
          await dbDelete(p, null).catch(() => {});
        }
      }
    } catch {
      /* 清理失败不影响限流 */
    }
  })();
}

/** 跨进程令牌桶：读-改-写非原子，误差只可能多放几个请求，作为防线足够 */
export async function rateLimitPersistent(key: string, opts: RateLimitOpts): Promise<boolean> {
  if (!hasHealthyRemoteDb()) return rateLimit(key, opts);
  const now = Date.now();
  sweepRlKeys(now);
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

/* 本站前面有几层反向代理会把真实对端地址追加到 X-Forwarded-For 末尾。
 * 默认 1（Caddy / ELB 直连最常见）；两层链路（LB→Caddy→app）配 2。 */
function trustedProxyHops(): number {
  const raw = Number(process.env.TRUSTED_PROXY_HOPS ?? "1");
  return Number.isInteger(raw) && raw >= 1 && raw <= 10 ? raw : 1;
}

/**
 * 取客户端 IP（限流键的唯一来源）。
 *
 * 安全前提：X-Forwarded-For 的最左段按 HTTP 语义是"离客户端最近"的一跳，也就是
 * 客户端自己可以随便填的那一段——拿它做键，攻击者每次请求换一个伪造值就得到
 * 一个全新限流桶，login/admin 的爆破防线与全站桶全部失效。
 * 可信代理会把真实对端追加在末尾，所以从右往左数「可信跳数」，伪造的前缀不参与。
 */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    const hops = trustedProxyHops();
    /* 段数不足可信跳数 = 请求没有经过全部可信代理（或 TRUSTED_PROXY_HOPS 配高了），
     * 此时整条 XFF 都不可信，尤其最左段是客户端可自填的。绝不能 Math.max 钳到
     * parts[0] 去当限流键——那等于把桶交给攻击者轮换。回落到 x-real-ip / unknown。 */
    if (parts.length >= hops) return parts[parts.length - hops];
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
