import "server-only";
import crypto from "node:crypto";

/* 邮箱验证码：生成/校验,存内存(单实例内一致;Vercel 多实例概率极低且验证码本就短时效)。
 * RESEND_API_KEY 存在 → 真实发信;不存在 → dev 模式,验证码打到服务端日志(本地/演示可跑通全链路)。 */

interface CodeEntry {
  code: string;
  expiresAt: number;
  attempts: number;
}

const STORE = new Map<string, CodeEntry>();
const TTL_MS = 10 * 60_000; // 10 分钟
const MAX_ATTEMPTS = 5;

export function issueCode(email: string, purpose: "register" | "login"): string {
  const key = `${purpose}:${email.toLowerCase()}`;
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  STORE.set(key, { code, expiresAt: Date.now() + TTL_MS, attempts: 0 });
  // 顺手清理过期,防内存增长
  if (STORE.size > 5000) {
    for (const [k, v] of STORE) if (v.expiresAt < Date.now()) STORE.delete(k);
  }
  return code;
}

export function verifyCode(email: string, purpose: "register" | "login", input: string): boolean {
  const key = `${purpose}:${email.toLowerCase()}`;
  const e = STORE.get(key);
  if (!e || e.expiresAt < Date.now()) {
    STORE.delete(key);
    return false;
  }
  e.attempts++;
  if (e.attempts > MAX_ATTEMPTS) {
    STORE.delete(key);
    return false;
  }
  if (e.code !== input.trim()) return false;
  STORE.delete(key); // 一次性
  return true;
}

export function hasSmtp(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

/** 发信：有 RESEND_API_KEY 走 Resend;否则 dev 模式打日志 */
export async function sendCodeEmail(email: string, code: string, purpose: "register" | "login"): Promise<{ sent: boolean; devCode?: string }> {
  const subject = purpose === "register" ? "Mentora 注册验证码" : "Mentora 登录验证码";
  if (!hasSmtp()) {
    console.log(`[dev-mail] ${subject} → ${email}: ${code}`);
    return { sent: false, devCode: code };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || "Mentora <onboarding@resend.dev>",
      to: [email],
      subject,
      html: `<p>你的验证码：<b style="font-size:20px;letter-spacing:4px">${code}</b>（10 分钟内有效）</p><p>如果不是你本人操作，请忽略本邮件。</p>`,
    }),
  });
  if (!res.ok) {
    console.error("[mail] send failed", res.status, (await res.text()).slice(0, 200));
    throw new Error("验证码邮件发送失败，请稍后再试");
  }
  return { sent: true };
}
