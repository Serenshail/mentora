import { NextRequest } from "next/server";
import { dbGet, dbPut, dbDelete, emailHash } from "@/lib/server/db";
import { verifyPassword, hashPassword } from "@/lib/server/auth";
import { verifyCode } from "@/lib/server/mail";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";

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

/** 忘记密码（v17）：注册验证码基础设施的第二个用途。
 *  流程：send-code?purpose=reset → 邮箱收码 → 本路由验码并设新密码。
 *  安全语义：
 *  - 验证码跨 isolate 存 KV，一次性消费；
 *  - 成功改密后 sv+1：旧设备上所有会话立即吊销（拿到邮箱者不能继续潜伏）；
 *  - 登录失败锁定随之清除（用户已通过邮箱证明所有权）；
 *  - 本路由不签发新会话——改完必须回登录页重新登录，一步一个脚印。 */
export async function POST(req: NextRequest) {
  if (!(await rateLimitPersistent(`reset:${clientIp(req)}`, { capacity: 5, refillPerSec: 5 / 60 }))) {
    return Response.json({ error: "尝试太频繁，请稍后再试" }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const code = String(body.code ?? "").trim();
  const newPassword = String(body.newPassword ?? "");

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: "邮箱格式不对" }, { status: 400 });
  }
  if (newPassword.length < 6) {
    return Response.json({ error: "新密码至少 6 位" }, { status: 400 });
  }
  if (!(await verifyCode(email, "reset", code))) {
    return Response.json({ error: "验证码不对或已过期，请重新获取" }, { status: 401 });
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

  // 清掉防爆破锁定：用户已通过邮箱验证码证明所有权
  const failPath = `loginfail/${process.env.VERCEL_ENV || "dev"}/${emailHash(email)}.json`;
  await dbDelete(failPath, null).catch(() => {});

  return Response.json({ ok: true, revokedOtherDevices: true });
}
