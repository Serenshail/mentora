import { NextRequest } from "next/server";
import { dbGet, dbDelete, emailHash } from "@/lib/server/db";
import { verifySession, verifyPassword, clearSessionCookie } from "@/lib/server/auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 注销账号（自助删除）：必须密码二次确认；删除用户档案 + 云端数据，清除会话。
 *  与管理端删除同后果：不可恢复。本地设备数据由前端在成功后自行清仓。 */
export async function DELETE(req: NextRequest) {
  if (!(await rateLimitPersistent(`delacc:${clientIp(req)}`, { capacity: 3, refillPerSec: 3 / 60 }))) {
    return Response.json({ error: "操作太频繁，请稍后再试" }, { status: 429 });
  }
  const session = await verifySession();
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const password = String(body.password ?? "");
  if (!password) return Response.json({ error: "请输入密码确认" }, { status: 400 });

  const path = `users/${emailHash(session.email)}.json`;
  let record: { userId: string; salt: string; hash: string; _sha?: string } | null = null;
  try {
    record = await dbGet(path, { encrypted: true });
  } catch {
    return Response.json({ error: "账户数据暂时不可用，稍后再试" }, { status: 503 });
  }
  if (!record) return Response.json({ error: "账户不存在" }, { status: 404 });
  if (!verifyPassword(password, record.salt, record.hash)) {
    return Response.json({ error: "密码不对" }, { status: 401 });
  }

  try {
    await dbDelete(path, record._sha ?? null);
  } catch {
    return Response.json({ error: "删除失败，稍后再试" }, { status: 502 });
  }
  try {
    const dataFile = await dbGet(`data/${record.userId}.json`, { encrypted: true });
    if (dataFile) await dbDelete(`data/${record.userId}.json`, dataFile._sha ?? null);
  } catch { /* 数据文件删除失败不阻断 */ }

  await clearSessionCookie();
  return Response.json({ ok: true, userId: record.userId });
}
