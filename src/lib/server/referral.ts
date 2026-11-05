import "server-only";
import crypto from "node:crypto";
import { dbGet, dbPut, dbPutIfAbsent, dbDelete, emailHash } from "./db";
import { REFERRAL } from "../pricing";
import type { PlanId } from "../pricing";
import { grantDays, type UserPlanRecord } from "./entitlement";

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
}

/** 删号时顺手清掉邀请码索引：否则这个码会永远指向一个不存在的账号，
 *  别人填了只会得到"找不到邀请人"的静默失败。 */
export async function dropRefCode(email: string): Promise<void> {
  try {
    const rec = await dbGet<ReferralRecord>(`users/${emailHash(email)}.json`, { encrypted: true });
    if (rec?.refCode) await dbDelete(refPath(rec.refCode), null);
  } catch {
    /* 清理失败不阻断删号 */
  }
}

export async function findReferrer(rawCode: string): Promise<RefIndex | null> {
  const code = normalizeRefCode(rawCode);
  if (code.length < 6) return null;
  try {
    return await dbGet<RefIndex>(refPath(code), { encrypted: true });
  } catch {
    return null;
  }
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
  const inviter = await findReferrer(opts.refCode);
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
  const inviterRec = await dbGet<(UserPlanRecord & ReferralRecord) & { _sha?: string }>(inviterPath, { encrypted: true });
  if (!inviterRec) return { rewarded: false, reason: "no-inviter" };

  // 老用户（无到期时间）本来就无限期，奖励没有意义
  if (inviterRec.planExpiresAt === undefined) {
    await appendReferral(inviterPath, inviterRec, { email: opts.inviteeEmail, at: new Date().toISOString(), rewarded: false, ip: opts.ip });
    return { rewarded: false, reason: "legacy", inviterEmail: inviter.email };
  }

  const since = Date.now() - 30 * 86_400_000;
  const recent = (inviterRec.referrals ?? []).filter((r) => r.rewarded && Date.parse(r.at) > since).length;
  if (recent >= cap) {
    await appendReferral(inviterPath, inviterRec, { email: opts.inviteeEmail, at: new Date().toISOString(), rewarded: false, ip: opts.ip });
    return { rewarded: false, reason: "capped", inviterEmail: inviter.email };
  }

  try {
    await grantDays({
      email: inviter.email,
      userId: inviter.userId,
      days: REFERRAL.rewardDays,
      plan: REFERRAL.rewardPlan as PlanId,
      licenseId: `ref:${inviter.code}:${inviteeHash}`,
    });
  } catch {
    return { rewarded: false, reason: "error", inviterEmail: inviter.email };
  }
  const fresh = await dbGet<(UserPlanRecord & ReferralRecord) & { _sha?: string }>(inviterPath, { encrypted: true });
  if (fresh) {
    await appendReferral(inviterPath, fresh, { email: opts.inviteeEmail, at: new Date().toISOString(), rewarded: true, ip: opts.ip });
  }
  return { rewarded: true, reason: "ok", inviterEmail: inviter.email, days: REFERRAL.rewardDays };
}

async function appendReferral(
  path: string,
  rec: (UserPlanRecord & ReferralRecord) & { _sha?: string },
  entry: ReferralEntry
): Promise<void> {
  try {
    const { _sha, ...clean } = rec;
    const referrals = [...(clean.referrals ?? []), entry].slice(-200);
    await dbPut(path, { ...clean, referrals }, { encrypted: true, sha: _sha ?? null, overwriteOnConflict: true });
  } catch {
    /* 记录失败不影响奖励本身 */
  }
}

/** 会员页展示用：我的邀请码 + 拉新战绩 + 我邀请了谁（链条让人看得见） */
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
    list: [...list].reverse().map((r) => ({ email: r.email, at: r.at, rewarded: r.rewarded })),
  };
}
