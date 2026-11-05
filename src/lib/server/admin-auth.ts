import "server-only";
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { verifySession } from "@/lib/server/auth";
import { isAdminEmail } from "@/lib/admin-emails";
import { clientIp, rateLimit } from "./rate-limit";

/* 管理员双鉴权(与 overview 同源逻辑,供 feedback-state 等复用):
 *  1) 白名单账号会话; 2) 独立后台密码 x-admin-password 头(timing-safe 比对 ADMIN_PASSWORD)。
 *  外部后台管理系统走第 2 条,无需登录 Mentora 用户账号。 */

function timingSafeEq(a: string, b: string): boolean {
  /* 先 sha256 定长再比对：长度不等提前 return 会用时序泄露 ADMIN_PASSWORD 长度 */
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export type AdminAuthResult =
  | { ok: true; email: string; name: string }
  | { ok: false; reason: "bad-password" | "no-session" | "not-admin" };

/** 带失败原因的管理员鉴权：四种失败不再压成裸 null，路由文案可统一由此取 */
export async function authorizeAdminDetailed(req: NextRequest): Promise<AdminAuthResult> {
  const expected = process.env.ADMIN_PASSWORD || "";
  const given = req.headers.get("x-admin-password") ?? "";
  if (expected && given && timingSafeEq(given, expected)) {
    return { ok: true, email: "admin-password", name: "后台密码" };
  }
  /* 密码通道失败尝试限流（只计失败，正常管理员零影响）：users/feedback-state 等
   * 端点没有路由级限流，x-admin-password 裸爆破即数据丢失；进程内桶封顶单实例速率 */
  if (expected && given) {
    const allowed = rateLimit(`admin-pwfail/${clientIp(req)}`, {
      capacity: 15,
      refillPerSec: 0.25,
    });
    if (!allowed) return { ok: false, reason: "bad-password" };
  }
  const session = await verifySession();
  if (session && isAdminEmail(session.email, process.env.ADMIN_EMAILS)) {
    return { ok: true, email: session.email, name: session.name };
  }
  if (expected && given) return { ok: false, reason: "bad-password" };
  if (!session) return { ok: false, reason: "no-session" };
  return { ok: false, reason: "not-admin" };
}

export async function authorizeAdmin(
  req: NextRequest
): Promise<{ email: string; name: string } | null> {
  const r = await authorizeAdminDetailed(req);
  return r.ok ? { email: r.email, name: r.name } : null;
}
