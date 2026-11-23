import { NextRequest } from "next/server";
import { dbGet, dbPut, dbDelete, emailHash } from "@/lib/server/db";
import { hashPasswordAsync } from "@/lib/server/auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { deployEnv } from "@/lib/server/deploy-env";
import { consumeResetCode } from "@/lib/server/reset-code";
import { withUserLock } from "@/lib/server/entitlement";
import { readJsonBody } from "@/lib/server/body-limit";

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
  /* 体积闸：请求体超 512KB 直接 413，不缓冲不解析（真实重置载荷 ≤1KB） */
  const body = await readJsonBody(req);
  if (body === null) {
    return Response.json({ error: "请求体过大" }, { status: 413 });
  }
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

  /* 整档读-改-写必须持档案锁（与 change-password/profile/grantDays/ensureRefCode
   * 同一把 withUserLock）：KV 通道 last-write-wins，不持锁时本路由读到的旧快照
   * 会在并发兑换（grantDays 刚写回 plan/planExpiresAt/planHistory）之后整档覆盖
   * 写回——卡密已被 claimLicense 标 used（releaseClaim 只在 grantDays 抛错时触发），
   * 用户付费兑换的天数凭空消失；sv 回写还会让并发 change-password 刚签发的新
   * 会话失配。锁 3 次退避抢不到 → 兜底 503，绝不无锁裸跑。 */
  return withUserLock(email, async (): Promise<Response> => {
    let record: UserRecord | null = null;
    try {
      record = await dbGet<UserRecord>(path, { encrypted: true });
    } catch {
      return Response.json({ error: "账户数据暂时不可用，稍后再试" }, { status: 503 });
    }

    const verdict = await consumeResetCode(email, resetCode);
    if (verdict === "error") {
      /* 存储故障 ≠ 码不存在：与本端点上面读用户记录失败同款 503，绝不把错误态
       * 伪装成空态让用户拿着有效码去求助（此时管理员重发同样会失败）。 */
      return Response.json({ error: "账户数据暂时不可用，稍后再试" }, { status: 503 });
    }
    if (verdict === "none") {
      return Response.json({ error: "重置码不存在或已使用，请联系管理员重新发放" }, { status: 401 });
    }
    if (verdict === "expired") {
      return Response.json({ error: "重置码已过期，请联系管理员重新发放" }, { status: 401 });
    }
    if (verdict === "mismatch") {
      return Response.json({ error: "重置码不对" }, { status: 401 });
    }

    /* 反枚举（login 同款纪律）：档案不存在不在消费重置码「之前」回 404「账户不存在」
     * ——那让攻击者无需任何有效重置码即可按响应区分邮箱是否注册。码已验过后仍无
     * 档案（管理员误发/档案已删）时，回与「重置码不对」一致的响应。 */
    if (!record) return Response.json({ error: "重置码不对" }, { status: 401 });

    /* 异步 scrypt：热路径纪律同 login/register（auth.ts hashPasswordAsync 注释） */
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
      return Response.json({ error: "保存失败，稍后再试" }, { status: 503 });
    }

    // 清掉防爆破锁定：用户已凭重置码完成重置
    const failPath = `loginfail/${deployEnv()}/${emailHash(email)}.json`;
    await dbDelete(failPath, null).catch(() => {});

    return Response.json({ ok: true, revokedOtherDevices: true });
  }).catch(() => Response.json({ error: "保存失败，稍后再试" }, { status: 503 }));
}
