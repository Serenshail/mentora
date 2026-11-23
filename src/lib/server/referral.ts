import "server-only";
import crypto from "node:crypto";
import { dbGet, dbPut, dbPutIfAbsent, dbDelete, emailHash } from "./db";
import { REFERRAL } from "../pricing";
import type { PlanId } from "../pricing";
import { grantDaysLocked, withUserLock, type UserPlanRecord } from "./entitlement";

/* ============================================================
 * 拉新奖励：拉一个新用户注册，邀请人 +1 个月（用户 2026-11-05 定）
 *
 * 与激活码是两回事，别混：
 *   激活码 = 花钱买的，决定"能不能用、用到什么时候"
 *   邀请码 = 自己的分享码，别人注册时填，用来给邀请人加时长
 *
 * 防刷（个人收款阶段的现实威胁是"自己注册小号刷时长"）：
 *   - 一个被邀请邮箱只结算一次（`refreward/` 幂等键，dbPutIfAbsent 原子占）
 *   - 不能邀请自己（同一邮箱哈希直接拒）
 *   - 邀请人 30 天内最多结算 monthlyCap 次
 *   - 邀请记录留 IP 与时间，异常量一眼看得出
 * ============================================================ */

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const refPath = (code: string) => `ref/${code.toUpperCase()}.json`;
const rewardPath = (code: string, invitee: string) => `refreward/${code.toUpperCase()}/${invitee}.json`;

export interface RefIndex {
  code: string;
  email: string;
  userId: string;
  createdAt: string;
}

export interface ReferralEntry {
  email: string;
  at: string;
  rewarded: boolean;
  ip?: string;
}

export interface ReferralRecord {
  refCode?: string;
  invitedBy?: string;
  referrals?: ReferralEntry[];
}

function randomCode(): string {
  return Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
}

/** 归一化用户填进来的邀请码：大写、去掉非字母数字 */
export function normalizeRefCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 12);
}

/** 取自己的邀请码；没有就生成一个（老用户首次打开会员页时懒生成）。 */
export async function ensureRefCode(email: string, userId: string): Promise<string> {
  const path = `users/${emailHash(email)}.json`;
  /* 只读快路径放在锁外：已经有邀请码就直接返回，不写任何东西，也就不可能覆盖
   * 别人的写入。锁只保护下面真正的「生成索引码 + 整档写回」——把纯读也塞进锁，
   * 会让并发兑换（持锁期间）把会员页的邀请码查询拖成 503。 */
  const peek = await dbGet<ReferralRecord>(path, { encrypted: true });
  if (!peek) throw new Error("账号不存在");
  if (peek.refCode) return peek.refCode;

  /* 写路径与 grantDays/setExpiry/change-password/PATCH profile 共用同一把档案锁：
   * 本函数对 users/<hash>.json 是整档读-改-写，而 KV 通道（upstash/d1/rds/dcs）
   * 的 dbPut 完全忽略 sha，last-write-wins。无锁时「读快照 → 生成索引码 → 整档写回」
   * 与同账号兑换激活码并发，旧快照后落会把 grantDays 刚写回的
   * plan/planExpiresAt/planHistory 整档回滚（卡密已 used，用户白付钱）。
   * 快照必须在锁内重读：等锁期间锁外读到的档案同样可能已过期。 */
  return withUserLock(email, async () => {
    const rec = await dbGet<ReferralRecord & { _sha?: string }>(path, { encrypted: true });
    if (!rec) throw new Error("账号不存在");
    if (rec.refCode) return rec.refCode;
    const { _sha, ...clean } = rec;

    for (let i = 0; i < 5; i++) {
      const code = randomCode();
      // 索引键本身就是唯一性约束：抢到了才算这个码是我的
      const won = await dbPutIfAbsent(refPath(code), { code, email, userId, createdAt: new Date().toISOString() }, { encrypted: true });
      if (!won) continue;
      await dbPut(path, { ...clean, refCode: code }, { encrypted: true, sha: _sha ?? null, overwriteOnConflict: true });
      return code;
    }
    throw new Error("邀请码生成失败，稍后再试");
  });
}

/** 删号时顺手清掉邀请码索引：否则这个码会永远指向一个不存在的账号，
 *  别人填了只会得到"找不到邀请人"的静默失败。
 *  必须传入删档案「之前」读到的 refCode：两个删号路由都是先 dbDelete 用户档案再调用，
 *  旧签名只收 email、进函数重新读 users/<hash>.json，此时档案已删读到 null，
 *  清理恒为空操作（悬挂索引从未被清过）。 */
export async function dropRefCode(code: string | null | undefined): Promise<void> {
  if (!code) return;
  try {
    await dbDelete(refPath(code), null);
  } catch {
    /* 清理失败不阻断删号 */
  }
}

/** 查邀请码索引。存储故障**抛出**（不是返回 null）——调用方必须能区分「码不存在」
 *  （空态，当作没填）与「KV 抖动读不到」（错误态）。旧实现 catch 全部返回 null，
 *  注册路由据此把存储故障压平成「没填/无效」：invitedBy 不落、奖励静默永久丢失
 *  （rewardInviter 全仓只剩注册这一个调用点、invitedBy 无任何后续补结算路径）。 */
export async function findReferrer(rawCode: string): Promise<RefIndex | null> {
  const code = normalizeRefCode(rawCode);
  if (code.length < 6) return null;
  return await dbGet<RefIndex>(refPath(code), { encrypted: true });
}

export interface RewardResult {
  rewarded: boolean;
  reason: "ok" | "no-inviter" | "self" | "duplicate" | "capped" | "legacy" | "error";
  inviterEmail?: string;
  days?: number;
}

/** 新用户注册成功后调用（best-effort：奖励失败绝不回滚注册）。 */
export async function rewardInviter(opts: {
  refCode: string;
  inviteeEmail: string;
  inviteeUserId: string;
  ip?: string;
}): Promise<RewardResult> {
  let inviter: RefIndex | null;
  try {
    inviter = await findReferrer(opts.refCode);
  } catch {
    // 存储故障 ≠ 没邀请人：单独用 error 让调用方看得见，绝不与 no-inviter 混同
    return { rewarded: false, reason: "error" };
  }
  if (!inviter) return { rewarded: false, reason: "no-inviter" };
  const inviteeHash = emailHash(opts.inviteeEmail);
  if (inviter.email.toLowerCase() === opts.inviteeEmail.toLowerCase() || emailHash(inviter.email) === inviteeHash) {
    return { rewarded: false, reason: "self", inviterEmail: inviter.email };
  }

  // 幂等占位：一个被邀请邮箱对同一个邀请码只结算一次
  let first = false;
  try {
    first = await dbPutIfAbsent(
      rewardPath(inviter.code, inviteeHash),
      { at: new Date().toISOString(), inviteeEmail: opts.inviteeEmail, ip: opts.ip ?? "" },
      { encrypted: true }
    );
  } catch {
    return { rewarded: false, reason: "error", inviterEmail: inviter.email };
  }
  if (!first) return { rewarded: false, reason: "duplicate", inviterEmail: inviter.email };

  const cap = Math.max(1, Number(process.env.REFERRAL_MONTHLY_CAP || REFERRAL.monthlyCap));
  const inviterPath = `users/${emailHash(inviter.email)}.json`;
  const at = new Date().toISOString();
  const since = Date.now() - 30 * 86_400_000;

  /* 老用户（无到期时间）本来就无限期，奖励没有意义：这条前置判定沿用「锁外快照」，
   * 保持既有语义（并发 setExpiry 刚给老用户设了期，仍按快照判 legacy、只记不奖，
   * 避免给永久账号白塞一条 planHistory 假记录）。它不是并发敏感的：最坏只是少发一次
   * 对一个本就无限期的账号没有意义的奖励。 */
  const peek = await dbGet<(UserPlanRecord & ReferralRecord) & { _sha?: string }>(inviterPath, { encrypted: true });
  if (!peek) return { rewarded: false, reason: "no-inviter", inviterEmail: inviter.email };
  if (peek.planExpiresAt === undefined) {
    await withUserLock(inviter.email, () => appendReferralLocked(inviterPath, { email: opts.inviteeEmail, at, rewarded: false, ip: opts.ip }));
    return { rewarded: false, reason: "legacy", inviterEmail: inviter.email };
  }

  /* 月度上限判定必须与授予在同一把档案锁内串行。旧实现锁外读快照 → 判 recent >= cap
   * → 再各自 grantDays/appendReferral（各自取锁）：N 个新账号并发用同一邀请码注册时
   * 都读到同一份 referrals、全部通过检查，各 +30 天——上限被并发窗口整体击穿（资损）。
   * 这里把「读档案 → 判 cap → 授予 → 记一笔」收进一个锁临界区，判定与授予原子化；
   * grantDaysLocked 不再重复取锁，避免嵌套死锁。 */
  return withUserLock(inviter.email, async (): Promise<RewardResult> => {
    const inviterRec = await dbGet<(UserPlanRecord & ReferralRecord) & { _sha?: string }>(inviterPath, { encrypted: true });
    if (!inviterRec) return { rewarded: false, reason: "no-inviter", inviterEmail: inviter.email };

    // 等锁期间档案可能变成 legacy（并发把期删了）：同样只记不奖
    if (inviterRec.planExpiresAt === undefined) {
      await appendReferralLocked(inviterPath, { email: opts.inviteeEmail, at, rewarded: false, ip: opts.ip });
      return { rewarded: false, reason: "legacy", inviterEmail: inviter.email };
    }

    const recent = (inviterRec.referrals ?? []).filter((r) => r.rewarded && Date.parse(r.at) > since).length;
    if (recent >= cap) {
      await appendReferralLocked(inviterPath, { email: opts.inviteeEmail, at, rewarded: false, ip: opts.ip });
      return { rewarded: false, reason: "capped", inviterEmail: inviter.email };
    }

    try {
      await grantDaysLocked({
        email: inviter.email,
        userId: inviter.userId,
        days: REFERRAL.rewardDays,
        plan: REFERRAL.rewardPlan as PlanId,
        licenseId: `ref:${inviter.code}:${inviteeHash}`,
      });
    } catch {
      return { rewarded: false, reason: "error", inviterEmail: inviter.email };
    }
    await appendReferralLocked(inviterPath, { email: opts.inviteeEmail, at, rewarded: true, ip: opts.ip });
    return { rewarded: true, reason: "ok", inviterEmail: inviter.email, days: REFERRAL.rewardDays };
  });
}

/** 追加一条邀请记录。**必须在 withUserLock 临界区内调用**：本函数对
 *  users/<hash>.json 是整档读-改-写，而 KV 通道（upstash/d1/rds/dcs）的 dbPut
 *  忽略 sha、last-write-wins——锁外用旧快照整档写回会把并发写入的
 *  plan/planExpiresAt/planHistory 回滚（卡密已 used，用户白付钱）。
 *  紧接写入前重读档案，保证只改 referrals。记录失败不影响奖励本身。 */
async function appendReferralLocked(
  path: string,
  entry: ReferralEntry
): Promise<void> {
  try {
    const rec = await dbGet<(UserPlanRecord & ReferralRecord) & { _sha?: string }>(path, { encrypted: true });
    if (!rec) return;
    const { _sha, ...clean } = rec;
    const referrals = [...(clean.referrals ?? []), entry].slice(-200);
    await dbPut(path, { ...clean, referrals }, { encrypted: true, sha: _sha ?? null, overwriteOnConflict: true });
  } catch {
    /* 记录失败不影响奖励本身 */
  }
}

/** 邮箱掩码：a***@gmail.com——链条让人看得见（谁/何时/是否结算），但不再把
 *  被邀请者的完整 PII 邮箱原样暴露给邀请人（PIPL：向第三方提供个人信息需最小化）。
 *  存量库里的 referrals 记录仍存原始邮箱（审计口径不变），只在出口这里遮。 */
function maskEmail(raw: string): string {
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return "***";
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

/** 会员页展示用：我的邀请码 + 拉新战绩 + 我邀请了谁（链条让人看得见，邮箱脱敏显示） */
export async function referralSummary(email: string, userId: string): Promise<{
  refCode: string;
  invited: number;
  rewardedCount: number;
  rewardedDays: number;
  list: { email: string; at: string; rewarded: boolean }[];
}> {
  const code = await ensureRefCode(email, userId);
  const rec = await dbGet<ReferralRecord>(`users/${emailHash(email)}.json`, { encrypted: true });
  const list = rec?.referrals ?? [];
  const rewardedCount = list.filter((r) => r.rewarded).length;
  return {
    refCode: code,
    invited: list.length,
    rewardedCount,
    rewardedDays: rewardedCount * REFERRAL.rewardDays,
    list: [...list].reverse().map((r) => ({ email: maskEmail(r.email), at: r.at, rewarded: r.rewarded })),
  };
}
