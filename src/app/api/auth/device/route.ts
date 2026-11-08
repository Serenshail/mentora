import { NextRequest } from "next/server";
import { dbGet, dbPut, emailHash } from "@/lib/server/db";
import { verifyPassword } from "@/lib/server/auth";
import { dummyScryptVerify, getFailState, bumpFail, clearFail } from "@/lib/server/login-guard";
import { issueDeviceToken, type DeviceRecord } from "@/lib/server/device-auth";
import { computeEntitlement, type UserPlanRecord } from "@/lib/server/entitlement";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";

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
  const body = await req.json().catch(() => ({}));
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

  let record: UserRecord | null = null;
  try {
    record = await dbGet<UserRecord>(`users/${emailHash(email)}.json`, { encrypted: true });
  } catch {
    return Response.json({ error: "用户数据库暂时不可用，稍后再试" }, { status: 503 });
  }
  if (!record) dummyScryptVerify(password); // 不存在邮箱同样跑 scrypt，抹平枚举时序差
  if (!record || !verifyPassword(password, record.salt, record.hash)) {
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
}
