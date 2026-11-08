import { NextRequest } from "next/server";
import { dbGet, dbPut, dbDelete, emailHash } from "@/lib/server/db";
import { verifyPassword, hashPassword } from "@/lib/server/auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { deployEnv } from "@/lib/server/deploy-env";
import { consumeResetCode } from "@/lib/server/reset-code";

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

/** 忘记密码：邮箱 + 管理员发放的一次性重置码 + 新密码。
 *  为什么不用邮箱验证码：线上发信依赖 Resend，个人收款阶段用户本来就在微信上找你，
 *  后台一键发码更可靠，也不会把"重置任意账号"的钥匙做成一张人人可得的公共码。
 *  安全语义：
 *  - 重置码 24 小时有效、一次性、失败 8 次即焚；
 *  - 成功改密后 sv+1：旧设备上所有会话立即吊销；
 *  - 登录失败锁定随之清除；
 *  - 本路由不签发新会话——改完必须回登录页重新登录。 */
export async function POST(req: NextRequest) {
  if (!(await rateLimitPersistent(`reset:${clientIp(req)}`, { capacity: 5, refillPerSec: 5 / 60 }))) {
    return Response.json({ error: "尝试太频繁，请稍后再试" }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const resetCode = String(body.resetCode ?? body.inviteCode ?? "").trim();
  const newPassword = String(body.newPassword ?? "");

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: "邮箱格式不对" }, { status: 400 });
  }
  if (newPassword.length < 6) {
    return Response.json({ error: "新密码至少 6 位" }, { status: 400 });
  }
  if (!resetCode) {
    return Response.json({ error: "请输入重置码" }, { status: 400 });
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

  const verdict = await consumeResetCode(email, resetCode);
  if (verdict === "none") {
    return Response.json({ error: "重置码不存在或已使用，请联系管理员重新发放" }, { status: 401 });
  }
  if (verdict === "expired") {
    return Response.json({ error: "重置码已过期，请联系管理员重新发放" }, { status: 401 });
  }
  if (verdict === "mismatch") {
    return Response.json({ error: "重置码不对" }, { status: 401 });
  }

  const { salt, hash } = hashPassword(newPassword);
  const { _sha, ...clean } = record;
  const sv = (record.sv ?? 0) + 1;
  try {
    // devices 清空与 sv+1 同拍：设备令牌（v27）与 cookie 会话一起全端吊销
    await dbPut(path, { ...clean, salt, hash, sv, devices: [] }, {
      encrypted: true,
      sha: _sha ?? null,
      overwriteOnConflict: true,
    });
  } catch {
    return Response.json({ error: "保存失败，稍后再试" }, { status: 503 });
  }

  // 清掉防爆破锁定：用户已凭重置码完成重置
  const failPath = `loginfail/${deployEnv()}/${emailHash(email)}.json`;
  await dbDelete(failPath, null).catch(() => {});

  return Response.json({ ok: true, revokedOtherDevices: true });
}
