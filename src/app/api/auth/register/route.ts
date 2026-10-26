import { NextRequest } from "next/server";
import crypto from "node:crypto";
import { dbGet, dbPut, dbEventSave, emailHash } from "@/lib/server/db";
import { hashPassword, mintSession } from "@/lib/server/auth";
import { checkEmailDeliverable } from "@/lib/email-check";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

interface UserRecord {
  userId: string;
  email: string;
  name: string;
  salt: string;
  hash: string;
  createdAt: string;
  /** 会话版本号：改密/重置时递增，携带旧值的 cookie 全部作废 */
  sv?: number;
}

export async function POST(req: NextRequest) {
  // 注册成本高（邮箱取证+写库）：每 IP 突发 5 次、每分钟回填 5 次（跨 isolate 持久桶）
  if (!(await rateLimitPersistent(`register:${clientIp(req)}`, { capacity: 5, refillPerSec: 5 / 60 }))) {
    return Response.json({ error: "注册太频繁，请稍后再试" }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const name = String(body.name ?? "").trim() || email.split("@")[0];
  /* 注册唯一凭据：内测邀请码（邮箱验证码通道已取消）。
   * 未配置 INVITE_CODE 时通道关闭（无后门）。timing-safe 比对。 */
  const inviteRaw = String(body.inviteCode ?? "").trim();
  const inviteExpected = (process.env.INVITE_CODE || "").trim();
  if (!inviteExpected) {
    return Response.json({ error: "注册通道暂未开放" }, { status: 503 });
  }
  const inviteA = Buffer.from(inviteRaw);
  const inviteB = Buffer.from(inviteExpected);
  if (!inviteRaw || inviteA.length !== inviteB.length || !crypto.timingSafeEqual(inviteA, inviteB)) {
    return Response.json({ error: "邀请码不对" }, { status: 401 });
  }

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

  const { salt, hash } = hashPassword(password);
  const record: UserRecord = {
    userId: crypto.randomUUID(),
    email,
    name,
    salt,
    hash,
    createdAt: new Date().toISOString(),
    sv: 0,
  };
  try {
    await dbPut(path, record, { encrypted: true });
  } catch {
    return Response.json({ error: "注册写入失败，稍后再试" }, { status: 503 });
  }

  const user = { userId: record.userId, email, name, sv: 0 };
  await mintSession(user);
  await dbEventSave({ name: "signup", account: emailHash(email), path: "/api/auth/register", props: `{"invited":true}` });
  return Response.json({ user: { userId: user.userId, email, name } });
}
