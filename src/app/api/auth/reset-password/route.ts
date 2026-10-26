import { NextRequest } from "next/server";
import crypto from "node:crypto";
import { dbGet, dbPut, dbDelete, emailHash } from "@/lib/server/db";
import { verifyPassword, hashPassword } from "@/lib/server/auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { deployEnv } from "@/lib/server/deploy-env";

export const runtime = "nodejs";

interface UserRecord {
  userId: string;
  email: string;
  name: string;
  salt: string;
  hash: string;
  createdAt: string;
  avatar?: string;
  sv?: number;
  _sha?: string;
}

/** 忘记密码：邀请码重置（邮箱验证码通道已取消）。
 *  流程：邮箱 + 邀请码 + 新密码 → 校验邀请码并设新密码。
 *  安全语义：
 *  - 邀请码 timing-safe 比对，与注册共用同一个 INVITE_CODE；
 *  - 拿到邀请码即可重置任意已知邮箱的密码——因此必须有更严的限流；
 *  - 成功改密后 sv+1：旧设备上所有会话立即吊销；
 *  - 登录失败锁定随之清除；
 *  - 本路由不签发新会话——改完必须回登录页重新登录，一步一个脚印。 */
export async function POST(req: NextRequest) {
  if (!(await rateLimitPersistent(`reset:${clientIp(req)}`, { capacity: 5, refillPerSec: 5 / 60 }))) {
    return Response.json({ error: "尝试太频繁，请稍后再试" }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const inviteRaw = String(body.inviteCode ?? "").trim();
  const newPassword = String(body.newPassword ?? "");

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: "邮箱格式不对" }, { status: 400 });
  }
  if (newPassword.length < 6) {
    return Response.json({ error: "新密码至少 6 位" }, { status: 400 });
  }
  const inviteExpected = (process.env.INVITE_CODE || "").trim();
  if (!inviteExpected) {
    return Response.json({ error: "重置通道暂未开放" }, { status: 503 });
  }
  const inviteA = Buffer.from(inviteRaw);
  const inviteB = Buffer.from(inviteExpected);
  if (!inviteRaw || inviteA.length !== inviteB.length || !crypto.timingSafeEqual(inviteA, inviteB)) {
    return Response.json({ error: "邀请码不对" }, { status: 401 });
  }

  const path = `users/${emailHash(email)}.json`;
  let record: UserRecord | null = null;
  try {
    record = await dbGet<UserRecord>(path, { encrypted: true });
  } catch {
    return Response.json({ error: "账户数据暂时不可用，稍后再试" }, { status: 503 });
  }
  if (!record) return Response.json({ error: "账户不存在" }, { status: 404 });

  if (verifyPassword(newPassword, record.salt, record.hash)) {
    return Response.json({ error: "新密码不能与当前密码相同" }, { status: 400 });
  }

  const { salt, hash } = hashPassword(newPassword);
  const { _sha, ...clean } = record;
  const sv = (record.sv ?? 0) + 1;
  try {
    await dbPut(path, { ...clean, salt, hash, sv }, {
      encrypted: true,
      sha: _sha ?? null,
      overwriteOnConflict: true,
    });
  } catch {
    return Response.json({ error: "保存失败，稍后再试" }, { status: 503 });
  }

  // 清掉防爆破锁定：用户已凭邀请码完成重置
  const failPath = `loginfail/${deployEnv()}/${emailHash(email)}.json`;
  await dbDelete(failPath, null).catch(() => {});

  return Response.json({ ok: true, revokedOtherDevices: true });
}
