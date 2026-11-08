import { NextRequest } from "next/server";
import { dbGet, emailHash } from "@/lib/server/db";
import { verifyPassword, mintSession } from "@/lib/server/auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { computeEntitlement, setExpiry, type UserPlanRecord } from "@/lib/server/entitlement";
import { ensureRefCode, type ReferralRecord } from "@/lib/server/referral";
import { isAdminEmail } from "@/lib/admin-emails";
import {
  dummyScryptVerify,
  getFailState,
  bumpFail,
  clearFail,
} from "@/lib/server/login-guard";

export const runtime = "nodejs";

interface UserRecord extends UserPlanRecord, ReferralRecord {
  userId: string;
  email: string;
  name: string;
  salt: string;
  hash: string;
  avatar?: string;
  sv?: number;
}

export async function POST(req: NextRequest) {
  // 防暴力破解：每 IP 突发 10 次、每分钟回填 10 次（跨 isolate 持久桶）
  if (!(await rateLimitPersistent(`login:${clientIp(req)}`, { capacity: 10, refillPerSec: 10 / 60 }))) {
    return Response.json({ error: "尝试太频繁，请稍后再试" }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

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

  /* 老账号特权（用户 2026-11-05 定）：除管理员外，所有存量"无到期时间"的账号
   * 登录即送一年（founder），之后照常到期走只读宽限。管理员账号保持长期有效。
   * 顺手给没有邀请码的账号补一个——每个用户都要有邀请码。
   * 任何一步失败都不挡登录：这是福利，不是门票。 */
  try {
    if (!isAdminEmail(record.email, process.env.ADMIN_EMAILS) && record.planExpiresAt === undefined) {
      const fresh = await setExpiry(record.email, new Date(Date.now() + 365 * 86_400_000).toISOString(), "founder");
      record.plan = fresh.plan ?? record.plan;
      record.planExpiresAt = fresh.expiresAt ?? undefined;
    }
    if (!record.refCode) await ensureRefCode(record.email, record.userId);
  } catch {
    /* 补福利失败不影响登录本身 */
  }

  const entitlement = computeEntitlement(record);
  const user = {
    userId: record.userId,
    email: record.email,
    name: record.name,
    ...(record.avatar ? { avatar: record.avatar } : {}),
    ...(record.plan ? { plan: record.plan } : {}),
    ...(record.planExpiresAt ? { planExpiresAt: record.planExpiresAt } : {}),
    entitlement,
  };
  // 头像（base64 data-URL，可达数百 KB）绝不能进会话 cookie：cookie 的 name+value 超过 4096 字节
  // 会被浏览器直接丢弃，造成"登录成功但浏览器没有会话"——内页全被当未登录弹走、/api/sync 全 401。
  // 头像只通过响应体交给前端展示。sv 让会话可吊销（改密/重置后旧 cookie 作废）。
  await mintSession({ userId: user.userId, email: user.email, name: user.name, sv: record.sv ?? 0 });
  return Response.json({ user });
}
