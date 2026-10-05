import { NextRequest } from "next/server";
import { checkEmailDeliverable } from "@/lib/email-check";
import { rateLimit, clientIp } from "@/lib/server/rate-limit";
import { issueCode, sendCodeEmail } from "@/lib/server/mail";
import { dbGet, emailHash } from "@/lib/server/db";

export const runtime = "nodejs";

/** 发送注册验证码：格式/DNS/临时域核验 → 已注册拦截 → 发码(Resend 或 dev 日志)。 */
export async function POST(req: NextRequest) {
  if (!rateLimit(`sendcode:${clientIp(req)}`, { capacity: 5, refillPerSec: 5 / 60 })) {
    return Response.json({ error: "发送太频繁，请稍后再试" }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: "邮箱格式不对" }, { status: 400 });
  }
  const check = await checkEmailDeliverable(email);
  if (!check.ok) return Response.json({ error: check.reason }, { status: 400 });

  // 已注册的邮箱不再发码(不泄露"该邮箱已注册"之外的差异)
  try {
    const existing = await dbGet(`users/${emailHash(email)}.json`, { encrypted: true });
    if (existing) {
      return Response.json({ error: "这个邮箱已经注册过了，直接登录" }, { status: 409 });
    }
  } catch {
    return Response.json({ error: "用户数据库暂时不可用，稍后再试" }, { status: 503 });
  }

  const code = issueCode(email, "register");
  try {
    const { sent, devCode } = await sendCodeEmail(email, code, "register");
    return Response.json({ ok: true, sent, ...(sent ? {} : { devCode }) });
  } catch {
    return Response.json({ error: "验证码邮件发送失败，请稍后再试" }, { status: 502 });
  }
}
