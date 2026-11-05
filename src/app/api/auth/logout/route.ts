import { NextRequest } from "next/server";
import { clearSessionCookie } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // 登出 CSRF：跨站表单可强制登出任意用户。仅当带 Origin 且跨源时拒绝——
  // 小程序/原生客户端不带 Origin，不能一刀切。
  const origin = req.headers.get("origin");
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === req.headers.get("host");
    } catch { /* 非法 Origin */ }
    if (!ok) return Response.json({ error: "跨站请求被拒绝" }, { status: 403 });
  }
  await clearSessionCookie();
  return Response.json({ ok: true });
}
