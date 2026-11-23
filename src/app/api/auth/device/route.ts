import { NextRequest } from "next/server";
import crypto from "node:crypto";
import { dbGet, dbPut, emailHash } from "@/lib/server/db";
import { verifyPasswordAsync } from "@/lib/server/auth";
import { dummyScryptVerify, getFailState, bumpFail, clearFail } from "@/lib/server/login-guard";
import { issueDeviceToken, parseDeviceToken, hashDeviceToken, type DeviceRecord } from "@/lib/server/device-auth";
import { computeEntitlement, withUserLock, type UserPlanRecord } from "@/lib/server/entitlement";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/body-limit";

export const runtime = "nodejs";

interface UserRecord extends UserPlanRecord {
  userId: string;
  email: string;
  name: string;
  salt: string;
  hash: string;
  sv?: number;
  devices?: DeviceRecord[];
  _sha?: string;
}

/** 设备令牌签发（v27 · 插件重构 M1 / D3 决策）：邮箱密码登录 → 下发 90 天设备令牌。
 *  Obsidian 插件等无 cookie 宿主用它走正式认证体系（PRD 7.1），不再依赖共享 open-token。
 *  复用 login 的全套防爆破（IP 桶 + 账号锁 + 时序对齐）；令牌只存 sha256。
 *  改密/重置（sv+1）时档案 devices 清空 → 全部设备令牌即时吊销。
 *  注：不重跑 login 的「老账号送一年/补邀请码」福利——那是一次性幂等逻辑，
 *  能用插件的账号必然先在 Web 注册过；首登福利以 Web 首登为准（遗留问题备案）。 */
export async function POST(req: NextRequest) {
  // 与 login 同规格：每 IP 突发 10 次、每分钟回填 10 次（跨 isolate 持久桶）
  if (!(await rateLimitPersistent(`device:${clientIp(req)}`, { capacity: 10, refillPerSec: 10 / 60 }))) {
    return Response.json({ error: "尝试太频繁，请稍后再试" }, { status: 429 });
  }
  /* 体积闸：请求体超 512KB 直接 413，不缓冲不解析（与 login 同款，真实载荷 ≤1KB） */
  const body = await readJsonBody(req);
  if (body === null) {
    return Response.json({ error: "请求体过大" }, { status: 413 });
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const deviceName = String(body.deviceName ?? "").trim().slice(0, 40) || "Obsidian 插件";
  if (!email || !password) {
    return Response.json({ error: "需要邮箱与密码" }, { status: 400 });
  }

  const fail = await getFailState(email);
  if (fail && fail.until > Date.now()) {
    const mins = Math.ceil((fail.until - Date.now()) / 60_000);
    return Response.json(
      { error: `这个账号失败次数过多，已临时锁定（约 ${mins} 分钟后解锁）。想不起来密码可用「忘记密码」找回` },
      { status: 429 }
    );
  }

  /* 读-改-写整档覆盖必须持档案锁（withUserLock，与 profile/change-password/
   * grantDays/reset-password 同一把）：本路由读档案 → verifyPasswordAsync（scrypt，
   * 数十至数百 ms）→ 两次远端读写，读-写窗口不小；KV 通道 dbPut last-write-wins，
   * 不持锁时旧快照会把并发 change-password 刚写入的新 salt/hash/sv 整档覆盖回滚
   * （旧密码重新生效）、把其刚清空的 devices 复活（已吊销设备令牌死灰复燃）。
   * 锁抢不到 → 兜底 503，绝不无锁裸跑。 */
  return withUserLock(email, async (): Promise<Response> => {
    let record: UserRecord | null = null;
    try {
      record = await dbGet<UserRecord>(`users/${emailHash(email)}.json`, { encrypted: true });
    } catch {
      return Response.json({ error: "用户数据库暂时不可用，稍后再试" }, { status: 503 });
    }
    /* 与 /api/auth/login 同一纪律：异步 scrypt，不占事件循环；不存在邮箱跑同参数
     * 假校验抹平枚举时序差。 */
    const verified = record
      ? await verifyPasswordAsync(password, record.salt, record.hash)
      : (await dummyScryptVerify(password), false);
    if (!record || !verified) {
      if (record) await bumpFail(email); // 只给已注册邮箱计数，不给"探测存在性"留差异
      return Response.json({ error: "邮箱或密码不对" }, { status: 401 });
    }

    await clearFail(email);

    const { token, record: device, devices } = issueDeviceToken(emailHash(email), record, deviceName);
    try {
      const { _sha, ...clean } = record;
      await dbPut(`users/${emailHash(email)}.json`, { ...clean, devices }, {
        encrypted: true,
        sha: _sha ?? null,
        overwriteOnConflict: true,
      });
    } catch {
      return Response.json({ error: "设备登记失败，稍后再试" }, { status: 503 });
    }

    const entitlement = computeEntitlement(record);
    return Response.json({
      token,
      expiresAt: device.expiresAt,
      user: {
        userId: record.userId,
        email: record.email,
        name: record.name,
        ...(record.plan ? { plan: record.plan } : {}),
        ...(record.planExpiresAt ? { planExpiresAt: record.planExpiresAt } : {}),
        entitlement,
      },
    });
  }).catch(() => Response.json({ error: "设备登记失败，稍后再试" }, { status: 503 }));
}

/** 吊销设备令牌（v27.0-m1 补充，插件「退出登录」语义）：当前请求所持令牌立即失效。
 *  幂等：令牌已被吊销/不存在时照常返回 ok（remaining=0）。带 ?all=1 清空全部设备。
 *  指定 deviceId 吊销他机的管理语义列 P1（后台设备管理页）。 */
export async function DELETE(req: NextRequest) {
  const parsed = parseDeviceToken(req.headers.get("x-device-token"));
  if (!parsed) return Response.json({ error: "未登录" }, { status: 401 });
  try {
    const rec = await dbGet<UserRecord>(`users/${parsed.key}.json`, { encrypted: true });
    if (!rec) return Response.json({ error: "未登录" }, { status: 401 });

    /* 吊销同样是 users/<hash>.json 的整档覆盖写：与签发（POST）同持档案锁，
     * 否则与并发改密/兑换交错时旧快照会把对方的写入回滚。锁 key 用 rec.email
     * （withUserLock 内部做 emailHash，与 parsed.key 同一账号同一把锁）。 */
    return await withUserLock(rec.email, async (): Promise<Response> => {
      const fresh = await dbGet<UserRecord>(`users/${parsed.key}.json`, { encrypted: true });
      if (!fresh) return Response.json({ error: "未登录" }, { status: 401 });
      const hash = hashDeviceToken(parsed.token);
      const all = req.nextUrl.searchParams.has("all");
      const devices = all
        ? []
        : (fresh.devices ?? []).filter(
            (d) =>
              !(
                typeof d?.hash === "string" &&
                d.hash.length === hash.length &&
                crypto.timingSafeEqual(Buffer.from(d.hash), Buffer.from(hash))
              )
          );
      const { _sha, ...clean } = fresh;
      await dbPut(`users/${parsed.key}.json`, { ...clean, devices }, {
        encrypted: true,
        sha: _sha ?? null,
        overwriteOnConflict: true,
      });
      return Response.json({ ok: true, revoked: all ? "all" : "self", remaining: devices.length });
    });
  } catch {
    return Response.json({ error: "吊销失败，稍后再试" }, { status: 503 });
  }
}
