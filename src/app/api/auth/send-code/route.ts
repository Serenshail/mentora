import { NextRequest } from "next/server";
import { checkEmailDeliverable } from "@/lib/email-check";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { issueCode, sendCodeEmail, hasSmtp, type CodePurpose } from "@/lib/server/mail";
import { dbGet, emailHash } from "@/lib/server/db";
import { isProdDeploy } from "@/lib/server/deploy-env";

export const runtime = "nodejs";

/** 发送邮箱验证码（purpose: register | reset）。
 *  register：格式/DNS/临时域核验 → 已注册拦截 → 发码。
 *  reset：只有已注册邮箱才发码，但未注册时**静默返回 ok**（不给账号枚举留口子）。
 *  v17 生产守卫：未配置发信服务时绝不把验证码回给响应体（旧版等于注册旁路，
 *  任何脚本可无限注册）；dev/preview 保留 devCode 以便本地全链路冒烟。 */
export async function POST(req: NextRequest) {
  if (!(await rateLimitPersistent(`sendcode:${clientIp(req)}`, { capacity: 5, refillPerSec: 5 / 60 }))) {
    return Response.json({ error: "发送太频繁，请稍后再试" }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const purpose: CodePurpose = body.purpose === "reset" ? "reset" : "register";
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: "邮箱格式不对" }, { status: 400 });
  }
  const check = await checkEmailDeliverable(email);
  if (!check.ok) return Response.json({ error: check.reason }, { status: 400 });

  let exists = false;
  try {
    exists = Boolean(await dbGet(`users/${emailHash(email)}.json`, { encrypted: true }));
  } catch {
    return Response.json({ error: "用户数据库暂时不可用，稍后再试" }, { status: 503 });
  }

  if (purpose === "register") {
    if (exists) {
      return Response.json({ error: "这个邮箱已经注册过了，直接登录" }, { status: 409 });
    }
  } else if (!exists) {
    // 找回场景：邮箱不存在时不发码、不报"未注册"，响应与成功发码同形（防账号枚举）
    return Response.json({ ok: true, sent: false, ignored: true });
  }

  const code = await issueCode(email, purpose);
  try {
    const { sent, devCode } = await sendCodeEmail(email, code, purpose);
    if (!sent && isProdDeploy() && !hasSmtp()) {
      // 生产没配发信服务：注册/找回都该明确失败，而不是静默给出验证码
      return Response.json({ error: "发信服务未配置，暂时无法发送验证码，请稍后再试" }, { status: 503 });
    }
    return Response.json({ ok: true, sent, ...(sent ? {} : { devCode }) });
  } catch {
    return Response.json({ error: "验证码邮件发送失败，请稍后再试" }, { status: 502 });
  }
}
