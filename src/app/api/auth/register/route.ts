import { NextRequest } from "next/server";
import crypto from "node:crypto";
import { dbGet, dbPut, dbEventSave, emailHash } from "@/lib/server/db";
import { hashPasswordAsync, mintSession } from "@/lib/server/auth";
import { checkEmailDeliverable } from "@/lib/email-check";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { claimLicense, releaseClaim, failureMessage } from "@/lib/server/license";
import { computeEntitlement, type UserPlanRecord } from "@/lib/server/entitlement";
import { findReferrer, rewardInviter, ensureRefCode, normalizeRefCode, type RewardResult } from "@/lib/server/referral";
import { readJsonBody } from "@/lib/server/body-limit";
import { logEvent } from "@/lib/server/config";
import { DEFAULT_ADMIN_EMAILS } from "@/lib/admin-emails";

export const runtime = "nodejs";

interface UserRecord extends UserPlanRecord {
  userId: string;
  email: string;
  name: string;
  salt: string;
  hash: string;
  createdAt: string;
  /** 会话版本号：改密/重置时递增，携带旧值的 cookie 全部作废 */
  sv?: number;
  /** 谁邀请来的（邀请码），仅作审计 */
  invitedBy?: string;
}

export async function POST(req: NextRequest) {
  // 注册成本高（邮箱取证+写库）：每 IP 突发 5 次、每分钟回填 5 次（跨 isolate 持久桶）
  if (!(await rateLimitPersistent(`register:${clientIp(req)}`, { capacity: 5, refillPerSec: 5 / 60 }))) {
    return Response.json({ error: "注册太频繁，请稍后再试" }, { status: 429 });
  }
  /* 体积闸：请求体超 512KB 直接 413，不缓冲不解析（真实注册载荷 ≤1KB） */
  const body = await readJsonBody(req);
  if (body === null) {
    return Response.json({ error: "请求体过大" }, { status: 413 });
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const suppliedName = String(body.name ?? "").trim();
  /* 与 profile 的 1-24 字对齐：名字会写进会话 cookie，超长会让 Set-Cookie 越过
   * 浏览器 4096 字节上限被丢弃——注册看似成功却无会话，之后每次登录同样失败，
   * 用户没有自助修复通道（改名要先登录）。 */
  if (suppliedName.length > 24) {
    return Response.json({ error: "名字最多 24 个字" }, { status: 400 });
  }
  const name = suppliedName || email.split("@")[0].slice(0, 24).replace(/[\uD800-\uDBFF]$/, "");
  /* 注册唯一凭据：激活码（一人一码，兑换即开通对应时长）。
   * 码的校验与占用在 claimLicense 里做：一码只能有一个赢家。 */
  const inviteRaw = String(body.inviteCode ?? "").trim();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: "邮箱格式不对" }, { status: 400 });
  }
  /* 邮箱真实性：MX/A 记录取证 + 临时邮箱拦截——假的邮箱会让找回流程失效 */
  const check = await checkEmailDeliverable(email);
  if (!check.ok) {
    return Response.json({ error: check.reason }, { status: 400 });
  }
  if (password.length < 6) {
    return Response.json({ error: "密码至少 6 位" }, { status: 400 });
  }
  /* 内置管理员邮箱不得被公开注册「先到先得」。注册流程只做 MX 取证，从不验证邮箱所有权
   * （无验证码/确认邮件），所以源码里公开的 DEFAULT_ADMIN_EMAILS 在第三方自托管实例上
   * 会退化成「谁先注册谁拿后台全权」。官方部署上开发者已先注册、此分支不触发；操作者
   * 确需让该地址走正常注册时，把它显式写进 ADMIN_EMAILS（显式选择，不是默认放行）。 */
  const builtInAdmins = new Set(
    DEFAULT_ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  const optedInAdmins = new Set(
    (process.env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  if (builtInAdmins.has(email) && !optedInAdmins.has(email)) {
    logEvent({ route: "auth/register", ev: "reserved-admin-email-blocked" });
    return Response.json({ error: "这个邮箱不能用于注册，请换一个" }, { status: 403 });
  }
  const path = `users/${emailHash(email)}.json`;
  let existing = null;
  try {
    existing = await dbGet<UserRecord>(path, { encrypted: true });
  } catch {
    return Response.json({ error: "用户数据库暂时不可用，稍后再试" }, { status: 503 });
  }
  if (existing) {
    return Response.json({ error: "这个邮箱已经注册过了，直接登录" }, { status: 409 });
  }

  /* 哈希走异步 scrypt（hashPasswordAsync，格式与同步版逐字一致）：register 是唯一
   * 公开注册端点，同步 scryptSync 在多 IP 并发注册时串行排队、独占事件循环，
   * 自托管单进程上全站一起卡顿（纪律同 login 的 verifyPasswordAsync）。 */
  const { salt, hash } = await hashPasswordAsync(password);
  const userId = crypto.randomUUID();
  const claimed = await claimLicense(inviteRaw, { email, userId });
  if (!claimed.ok) {
    const status = claimed.reason === "DB" ? 503 : claimed.reason === "INVALID" ? 401 : 409;
    return Response.json({ error: failureMessage(claimed.reason) }, { status });
  }

  const days = claimed.license.days;
  /* 拉新：填了邀请码且确实是别人的码，就记一笔（奖励在账号写成功后发放）。
   * 解析失败/自己邀请自己一律当没填——不能因为一个可选字段让注册失败。 */
  const refRaw = normalizeRefCode(String(body.refCode ?? ""));
  let invitedBy: string | undefined;
  if (refRaw) {
    try {
      const referrer = await findReferrer(refRaw);
      if (referrer && referrer.email.toLowerCase() !== email) invitedBy = referrer.code;
    } catch {
      /* 存储故障读不到邀请人 ≠ 用户没填邀请码：绝不能把错误态压平成空态。
       * 旧实现 findReferrer 把 dbGet 异常吞成 null，注册据此当「没填/无效」——
       * 用户档案不落 invitedBy，奖励静默永久丢失（rewardInviter 只剩注册这一个
       * 调用点，invitedBy 无任何补结算路径）。这里保留归一化后的码并留日志，
       * 由紧随其后的 rewardInviter 再试一次结算；奖励仍 best-effort，绝不因此拒绝注册。 */
      invitedBy = refRaw;
      logEvent({ route: "auth/register", ev: "referrer-lookup-failed" });
    }
  }

  const record: UserRecord = {
    userId,
    email,
    name,
    salt,
    hash,
    createdAt: new Date().toISOString(),
    sv: 0,
    plan: claimed.license.plan,
    planExpiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    planHistory: [{ licenseId: claimed.license.id, days, at: new Date().toISOString() }],
    ...(invitedBy ? { invitedBy } : {}),
  };
  /* 收窄 TOCTOU：占码/查邀请人期间（可达数百 ms）并发同邮箱注册会在 KV 类通道静默互相覆盖。
   * 写入前重查一次，窗口从「整段注册流程」缩到一次往返；GitHub 通道无 sha 的 PUT 撞已有
   * 文件本就 422 失败，这条主要兜 KV/D1/RDS 通道。 */
  try {
    const recheck = await dbGet<UserRecord>(path, { encrypted: true });
    if (recheck) {
      await releaseClaim(inviteRaw); // 码已占但账号没建成，还回去
      return Response.json({ error: "这个邮箱已经注册过了，直接登录" }, { status: 409 });
    }
  } catch { /* 重查失败不挡注册：dbPut 失败时仍有 503 + releaseClaim 兜底 */ }
  try {
    await dbPut(path, record, { encrypted: true });
  } catch {
    // 码已经占用但账号没建成：把码还回去，用户可以立刻重试
    await releaseClaim(inviteRaw);
    return Response.json({ error: "注册写入失败，稍后再试" }, { status: 503 });
  }

  const user = { userId: record.userId, email, name, sv: 0 };
  await mintSession(user);
  // 人人有邀请码：注册即生成（失败不挡注册，下次登录会补）
  await ensureRefCode(email, userId).catch(() => {});
  // 邀请奖励 best-effort：失败不影响注册本身，日志里留痕方便核对
  let referral: { rewarded: boolean; reason: string } | null = null;
  if (invitedBy) {
    const r = await rewardInviter({ refCode: invitedBy, inviteeEmail: email, inviteeUserId: userId, ip: clientIp(req) }).catch(
      () => ({ rewarded: false, reason: "error" }) as RewardResult
    );
    referral = { rewarded: r.rewarded, reason: r.reason };
    if (r.rewarded) await dbEventSave({ name: "referral", account: emailHash(email), path: "/api/auth/register", props: `{"days":${r.days}}` }).catch(() => {});
  }
  await dbEventSave({ name: "signup", account: emailHash(email), path: "/api/auth/register", props: `{"plan":"${record.plan}","days":${days}}` });
  const ent = computeEntitlement(record);
  return Response.json({
    user: {
      userId: user.userId,
      email,
      name,
      plan: record.plan,
      planExpiresAt: record.planExpiresAt,
      entitlement: ent,
    },
    ...(referral ? { referral } : {}),
  });
}
