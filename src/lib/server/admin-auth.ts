import "server-only";
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { verifySession } from "@/lib/server/auth";
import { isAdminEmail } from "@/lib/admin-emails";

/* 管理员双鉴权(与 overview 同源逻辑,供 feedback-state 等复用):
 *  1) 白名单账号会话; 2) 独立后台密码 x-admin-password 头(timing-safe 比对 ADMIN_PASSWORD)。
 *  外部后台管理系统走第 2 条,无需登录 Mentora 用户账号。 */

function timingSafeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export async function authorizeAdmin(
  req: NextRequest
): Promise<{ email: string; name: string } | null> {
  const expected = process.env.ADMIN_PASSWORD || "";
  const given = req.headers.get("x-admin-password") ?? "";
  if (expected && given && timingSafeEq(given, expected)) {
    return { email: "admin-password", name: "后台密码" };
  }
  const session = await verifySession();
  if (session && isAdminEmail(session.email, process.env.ADMIN_EMAILS)) {
    return { email: session.email, name: session.name };
  }
  return null;
}
