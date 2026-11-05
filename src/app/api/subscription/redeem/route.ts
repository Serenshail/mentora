import { NextRequest } from "next/server";
import { verifySession } from "@/lib/server/auth";
import { claimLicense, releaseClaim, failureMessage } from "@/lib/server/license";
import { grantDays, readEntitlement } from "@/lib/server/entitlement";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { logEvent } from "@/lib/server/config";

export const runtime = "nodejs";

/** 会员状态（会员中心刷新用；/api/auth/me 也带，但这里只回权益，体积小） */
export async function GET() {
  const session = await verifySession();
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  return Response.json({ entitlement: await readEntitlement(session.email) });
}

/** 续费：用一张新激活码给当前账号累加天数。
 *  与注册共用 claimLicense：一码只能被一个人用，且同一张码不会重复加时。 */
export async function POST(req: NextRequest) {
  if (!(await rateLimitPersistent(`redeem:${clientIp(req)}`, { capacity: 5, refillPerSec: 5 / 60 }))) {
    return Response.json({ error: "尝试太频繁，请稍后再试" }, { status: 429 });
  }
  const session = await verifySession();
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const code = String(body.code ?? body.inviteCode ?? "").trim();
  if (!code) return Response.json({ error: "请输入激活码" }, { status: 400 });

  const claimed = await claimLicense(code, { email: session.email, userId: session.userId });
  if (!claimed.ok) {
    const status = claimed.reason === "DB" ? 503 : claimed.reason === "INVALID" ? 400 : 409;
    return Response.json({ error: failureMessage(claimed.reason) }, { status });
  }

  let entitlement;
  try {
    entitlement = await grantDays({
      email: session.email,
      userId: session.userId,
      days: claimed.license.days,
      plan: claimed.license.plan,
      licenseId: claimed.license.id,
    });
  } catch {
    // 时长没加上：把码还回去，用户可以用同一张码重试
    await releaseClaim(code);
    return Response.json({ error: "续费写入失败，请稍后再试" }, { status: 503 });
  }

  logEvent({ ev: "membership", msg: "redeem", plan: claimed.license.plan, days: claimed.license.days });
  return Response.json({ ok: true, days: claimed.license.days, entitlement });
}
