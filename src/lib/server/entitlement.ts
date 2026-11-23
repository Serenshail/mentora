import "server-only";
import { dbGet, dbPut, dbDelete, dbPutIfAbsent, emailHash } from "./db";
import type { PlanId } from "../pricing";
import { PLANS } from "../pricing";

/* ============================================================
 * 会员权益
 *
 * 到期策略：AI 立即停，但账号仍可登录、看笔记、导出数据——
 * 到期不等于把用户关在门外，只把"继续生成"这一项停了。
 *
 * 兼容纪律：老用户档案里没有 planExpiresAt，一律视为永久有效。
 * 云端存储故障时降级放行（绝不因一次 KV 抖动把付费用户判成过期）。
 * ============================================================ */

export type MemberStatus = "legacy" | "active" | "expiring" | "expired";

export interface Entitlement {
  status: MemberStatus;
  plan: PlanId | null;
  /** ISO；null 表示无到期时间（老用户/创始会员） */
  expiresAt: string | null;
  /** 剩余天数：向上取整；已过期为负数 */
  daysLeft: number | null;
}

export interface UserPlanRecord {
  plan?: PlanId;
  planExpiresAt?: string;
  planHistory?: { licenseId: string; days: number; at: string }[];
}

const EXPIRING_DAYS = 7;

export function computeEntitlement(record: UserPlanRecord | null): Entitlement {
  if (!record?.planExpiresAt) {
    return { status: "legacy", plan: record?.plan ?? null, expiresAt: null, daysLeft: null };
  }
  const end = Date.parse(record.planExpiresAt);
  if (Number.isNaN(end)) return { status: "legacy", plan: record.plan ?? null, expiresAt: null, daysLeft: null };
  /* 用时间戳判断是否过期，而不是用 daysLeft：到期后不足一天时
   * ceil(-0.17) = 0，旧写法会把"已过期 4 小时"误判成"还剩 0 天（有效）"——
   * 付费墙会在这个窗口里漏开整整一天。 */
  const diff = end - Date.now();
  const daysLeft = diff >= 0 ? Math.ceil(diff / 86_400_000) : Math.floor(diff / 86_400_000);
  const status: MemberStatus = diff < 0 ? "expired" : daysLeft <= EXPIRING_DAYS ? "expiring" : "active";
  return { status, plan: record.plan ?? null, expiresAt: record.planExpiresAt, daysLeft };
}

/** 到期拦截只认 expired；legacy/active/expiring 都放行 */
export function isBlocked(e: Entitlement): boolean {
  return e.status === "expired";
}

/* 进程内 memo：聊天每次请求都要判断会员，不能每次都跨洋读一次档案。
 * 30 秒足够防止"刚续费还在报过期"，也不会让过期状态延迟太久。 */
const MEMO_TTL_MS = 30_000;
const memo = new Map<string, { at: number; value: Entitlement }>();
/* 上限与 rate-limit.ts 的进程内桶同一套约束：自托管长驻进程下，每个历史用户
 * 都会永久留一条，不设界就是标准内存泄漏。到上限先扫已过 TTL 的，仍超则按插入
 * 顺序淘汰最旧的（memoSet 先 delete 再 set，活跃条目会移到队尾，近似 LRU）。 */
const MAX_MEMO_ENTRIES = 20_000;

function memoSet(email: string, value: Entitlement) {
  const key = emailHash(email);
  memo.delete(key);
  memo.set(key, { at: Date.now(), value });
  if (memo.size <= MAX_MEMO_ENTRIES) return;
  const cutoff = Date.now() - MEMO_TTL_MS;
  for (const [k, v] of memo) {
    if (memo.size <= MAX_MEMO_ENTRIES) return;
    if (v.at < cutoff) memo.delete(k);
  }
  // 突发涌入的全新用户可能都还在 TTL 内：按插入顺序继续淘汰，绝不让 Map 无界增长
  for (const k of memo.keys()) {
    if (memo.size <= MAX_MEMO_ENTRIES) return;
    memo.delete(k);
  }
}

export function clearEntitlementCache(email: string) {
  memo.delete(emailHash(email));
}

/** 读会员状态。读库失败 → 降级放行（返回 legacy），绝不让故障变成付费墙。 */
export async function readEntitlement(email: string): Promise<Entitlement> {
  const key = emailHash(email);
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value;

  try {
    const rec = await Promise.race([
      dbGet<UserPlanRecord>(`users/${key}.json`, { encrypted: true }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1200)),
    ]);
    // 超时也按降级放行处理：KV 慢不该变成"会员已过期"
    const value = computeEntitlement(rec);
    memoSet(email, value);
    return value;
  } catch {
    return { status: "legacy", plan: null, expiresAt: null, daysLeft: null };
  }
}

const LOCK_STALE_MS = 30_000;
const lockPath = (email: string) => `lock/sub/${emailHash(email)}.json`;

/** 跨进程短锁：同一账号并发兑换时串行化读-改-写。
 *  最多退避重试 3 次（250/500/750ms）；仍拿不到锁就抛错，绝不无锁裸跑——
 *  裸跑的读-改-写经 dbPut(overwriteOnConflict) 后写覆盖先写，同账号并发兑换会
 *  静默丢掉一方天数（资损）。调用方均已兜底：redeem 释放激活码转 503（同码
 *  可重试）、referral/login best-effort 不阻断主流程、admin 转 503。
 *  接管仅限「读到了锁、且其时间戳证明持锁方已超时」的崩溃遗留（读得到但没有
 *  at 视为损坏残留，一并接管）；PutIfAbsent 返回 false 说明键还在，此刻
 *  dbGet 读失败（prev=null）绝不能当成 stale 去删掉别人的活锁。
 *  导出给 change-password 等其他整档读-改-写路径共用：档案写入互不串行时，
 *  后写者会拿旧快照把先写者的字段整档覆盖回去（KV 通道 last-write-wins）。 */
export async function withUserLock<T>(email: string, fn: () => Promise<T>): Promise<T> {
  const key = lockPath(email);
  let held = false;
  for (let attempt = 0; attempt < 3 && !held; attempt++) {
    held = await dbPutIfAbsent(key, { at: Date.now() }, { encrypted: true }).catch(() => false);
    if (!held) {
      const prev = await dbGet<{ at?: number }>(key, { encrypted: true }).catch(() => null);
      const takeover = prev != null && (!prev.at || Date.now() - prev.at > LOCK_STALE_MS);
      if (takeover) {
        await dbDelete(key, null).catch(() => {});
      } else {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  }
  if (!held) throw new Error("会员档案锁占用中，请稍后重试");
  try {
    return await fn();
  } finally {
    await dbDelete(key, null).catch(() => {});
  }
}

export interface GrantInput {
  email: string;
  userId: string;
  days: number;
  plan: PlanId;
  licenseId: string;
}

/** 在**已持有** withUserLock 的前提下执行授予。供需要把「判定 + 授予」收进同一个
 *  临界区的调用方复用（referral 的月度上限判定必须与实际授予原子化，否则并发注册潮
 *  能整体击穿上限）。自己再取一次锁会嵌套死锁，故单独导出无锁版本。 */
export async function grantDaysLocked(input: GrantInput): Promise<Entitlement> {
  const path = `users/${emailHash(input.email)}.json`;
  const rec = await dbGet<UserPlanRecord & { _sha?: string }>(path, { encrypted: true });
  if (!rec) throw new Error("账号不存在");
  const { _sha, ...clean } = rec;

  const now = Date.now();
  // 老用户（从没设过到期时间）= 永久有效：续费不把他降级成限时账号
  const isLegacy = rec.planExpiresAt === undefined;
  const current = rec.planExpiresAt ? Date.parse(rec.planExpiresAt) : NaN;
  const base = Number.isNaN(current) ? now : Math.max(now, current);
  const expiresAt = isLegacy ? null : new Date(base + input.days * 86_400_000).toISOString();

  const next = {
    ...clean,
    ...(expiresAt ? { plan: input.plan, planExpiresAt: expiresAt } : {}),
    planHistory: [
      ...(rec.planHistory ?? []),
      { licenseId: input.licenseId, days: input.days, at: new Date().toISOString() },
    ].slice(-50),
  };
  await dbPut(path, next, { encrypted: true, sha: _sha ?? null, overwriteOnConflict: true });

  const ent = computeEntitlement(next);
  memoSet(input.email, ent);
  return ent;
}

/** 在"当前到期时间"上累加天数；老用户（无到期时间）保持无限期，不降级。
 *  返回最新权益；写失败抛错，由调用方转成 503。 */
export async function grantDays(input: GrantInput): Promise<Entitlement> {
  return withUserLock(input.email, () => grantDaysLocked(input));
}

/** 后台设置到期时间（null = 改回永久有效） */
export async function setExpiry(email: string, expiresAt: string | null, plan?: PlanId): Promise<Entitlement> {
  return withUserLock(email, async () => {
    const path = `users/${emailHash(email)}.json`;
    const rec = await dbGet<UserPlanRecord & { _sha?: string }>(path, { encrypted: true });
    if (!rec) throw new Error("账号不存在");
    const { _sha, ...clean } = rec;
    const next = { ...clean, ...(plan ? { plan } : {}), ...(expiresAt ? { planExpiresAt: expiresAt } : {}) };
    if (!expiresAt) delete (next as { planExpiresAt?: string }).planExpiresAt;
    await dbPut(path, next, { encrypted: true, sha: _sha ?? null, overwriteOnConflict: true });
    const ent = computeEntitlement(next);
    memoSet(email, ent);
    return ent;
  });
}

export function planDays(plan: PlanId): number {
  return PLANS[plan]?.days ?? 30;
}

/** 后台「延长 N 天」：即使老用户没有到期时间，也从今天起算——这是运营手动操作，
 *  与用户自己兑换（老用户保持无限期）语义不同。 */
export async function extendMembership(email: string, days: number, plan?: PlanId): Promise<Entitlement> {
  return withUserLock(email, async () => {
    const path = `users/${emailHash(email)}.json`;
    const rec = await dbGet<UserPlanRecord & { _sha?: string }>(path, { encrypted: true });
    if (!rec) throw new Error("账号不存在");
    const { _sha, ...clean } = rec;
    const current = rec.planExpiresAt ? Date.parse(rec.planExpiresAt) : NaN;
    const base = Number.isNaN(current) ? Date.now() : Math.max(Date.now(), current);
    const expiresAt = new Date(base + days * 86_400_000).toISOString();
    const next = { ...clean, ...(plan ? { plan } : {}), planExpiresAt: expiresAt };
    await dbPut(path, next, { encrypted: true, sha: _sha ?? null, overwriteOnConflict: true });
    const ent = computeEntitlement(next);
    memoSet(email, ent);
    return ent;
  });
}
