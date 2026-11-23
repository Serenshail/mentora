import { NextRequest } from "next/server";
import { dbGet, dbPut, emailHash } from "@/lib/server/db";
import { verifySession, verifyPasswordAsync, hashPasswordAsync, mintSession } from "@/lib/server/auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/body-limit";
import { withUserLock } from "@/lib/server/entitlement";

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

  /* 体积闸：改密载荷只有新旧密码两项，超 512KB 必为滥用，直接 413 不缓冲 */
  const body = await readJsonBody(req);
  if (body === null) {
    return Response.json({ error: "请求体过大" }, { status: 413 });
  }
  const oldPassword = String(body.oldPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  if (newPassword.length < 6) {
    return Response.json({ error: "新密码至少 6 位" }, { status: 400 });
  }
  if (oldPassword === newPassword) {
    return Response.json({ error: "新密码不能与旧密码相同" }, { status: 400 });
  }

  const path = `users/${emailHash(session.email)}.json`;
  /* 读-改-写与 grantDays/setExpiry/extendMembership 共用同一把档案锁（withUserLock）：
   * 本路由对 users/<hash>.json 做的是整档覆盖写（overwriteOnConflict，KV 通道
   * last-write-wins），若无锁，改密与并发兑换赛跑时后写者会拿旧快照整档覆盖——
   * 要么回滚刚兑的 planExpiresAt/planHistory（码已 used，叠加 releaseClaim 即资损），
   * 要么回滚刚改的密码（旧密码继续有效，用户以为已改）。旧密码验证放在锁内、
   * 写回之前：验证读的是锁下最新快照，且失败时不产生任何写入。 */
  const outcome = await withUserLock(session.email, async (): Promise<{ ok: false; status: number; error: string } | { ok: true; sv: number; userId: string; email: string; name: string }> => {
    let record: UserRecord | null = null;
    try {
      record = await dbGet<UserRecord>(path, { encrypted: true });
    } catch {
      return { ok: false, status: 503, error: "账户数据暂时不可用，稍后再试" };
    }
    if (!record) return { ok: false, status: 404, error: "账户不存在" };

    /* 旧密码验证/新密码哈希都走异步 scrypt（auth.ts:38 注释）：同步版在请求热路径
     * 上独占事件循环，自托管单进程上并发请求会被串行 scrypt 卡顿。 */
    if (!(await verifyPasswordAsync(oldPassword, record.salt, record.hash))) {
      return { ok: false, status: 401, error: "旧密码不对" };
    }

    const { salt, hash } = await hashPasswordAsync(newPassword);
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
      return { ok: false, status: 503, error: "保存失败，稍后再试" };
    }
    return { ok: true, sv, userId: record.userId, email: record.email, name: record.name };
  }).catch(() => ({ ok: false as const, status: 503, error: "保存失败，稍后再试" }));

  if (!outcome.ok) {
    return Response.json({ error: outcome.error }, { status: outcome.status });
  }

  // 重签当前会话（携带新 sv）；其他设备下次请求即被 verifySession 挡下，需重新登录
  await mintSession({ userId: outcome.userId, email: outcome.email, name: outcome.name, sv: outcome.sv });
  return Response.json({ ok: true, revokedOtherDevices: true });
}
