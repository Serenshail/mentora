import { NextRequest } from "next/server";
import { dbGet, dbPut, emailHash } from "@/lib/server/db";
import { getSessionUser, verifyPassword, hashPassword, setSessionCookie } from "@/lib/server/auth";
import { rateLimit, clientIp } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

interface UserRecord {
  userId: string;
  email: string;
  name: string;
  salt: string;
  hash: string;
  createdAt: string;
  avatar?: string;
  _sha?: string;
}

/** 修改密码：必须验旧密码；成功后重签当前会话。
 *  说明：会话是无状态 HMAC，其他已登录设备的旧 cookie 在 30 天有效期内仍有效——
 *  要立即失效所有设备需引入密码版本号(pv)入库并在每个鉴权点比对，当前规模先不做，UI 已注明。 */
export async function POST(req: NextRequest) {
  if (!rateLimit(`chpwd:${clientIp(req)}`, { capacity: 5, refillPerSec: 5 / 60 })) {
    return Response.json({ error: "尝试太频繁，请稍后再试" }, { status: 429 });
  }
  const session = await getSessionUser();
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
  try {
    await dbPut(path, { ...clean, salt, hash }, {
      encrypted: true,
      sha: _sha ?? null,
      overwriteOnConflict: true,
    });
  } catch {
    return Response.json({ error: "保存失败，稍后再试" }, { status: 503 });
  }

  // 重签当前会话（其他设备按上面说明处理）
  await setSessionCookie({ userId: record.userId, email: record.email, name: record.name });
  return Response.json({ ok: true });
}
