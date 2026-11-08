import { NextRequest } from "next/server";
import { dbGet, dbPut, emailHash } from "@/lib/server/db";
import { verifySession, verifyPassword, hashPassword, mintSession } from "@/lib/server/auth";
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
  /** 会话版本号 */
  sv?: number;
  _sha?: string;
}

/** 修改密码：必须验旧密码；成功后 sv+1 并重签当前会话——
 *  其他设备携带旧 sv 的 cookie 立即失效（v17 起会话可吊销，此前 30 天内照用）。 */
export async function POST(req: NextRequest) {
  if (!(await rateLimitPersistent(`chpwd:${clientIp(req)}`, { capacity: 5, refillPerSec: 5 / 60 }))) {
    return Response.json({ error: "尝试太频繁，请稍后再试" }, { status: 429 });
  }
  const session = await verifySession();
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const oldPassword = String(body.oldPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  if (newPassword.length < 6) {
    return Response.json({ error: "新密码至少 6 位" }, { status: 400 });
  }
  if (oldPassword === newPassword) {
    return Response.json({ error: "新密码不能与旧密码相同" }, { status: 400 });
  }

  const path = `users/${emailHash(session.email)}.json`;
  let record: UserRecord | null = null;
  try {
    record = await dbGet<UserRecord>(path, { encrypted: true });
  } catch {
    return Response.json({ error: "账户数据暂时不可用，稍后再试" }, { status: 503 });
  }
  if (!record) return Response.json({ error: "账户不存在" }, { status: 404 });

  if (!verifyPassword(oldPassword, record.salt, record.hash)) {
    return Response.json({ error: "旧密码不对" }, { status: 401 });
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

  // 重签当前会话（携带新 sv）；其他设备下次请求即被 verifySession 挡下，需重新登录
  await mintSession({ userId: record.userId, email: record.email, name: record.name, sv });
  return Response.json({ ok: true, revokedOtherDevices: true });
}
