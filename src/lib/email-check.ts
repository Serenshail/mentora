import dns from "node:dns";
import { promisify } from "node:util";

const resolveMx = promisify(dns.resolveMx);
const resolveA = promisify(dns.resolve);

/* 常见一次性/临时邮箱域（可持续补充） */
const DISPOSABLE = new Set([
  "mailinator.com", "10minutemail.com", "guerrillamail.com", "yopmail.com",
  "temp-mail.org", "tempmail.com", "sharklasers.com", "getnada.com",
  "dispostable.com", "trashmail.com", "throwawaymail.com", "maildrop.cc",
]);

export interface EmailCheck {
  ok: boolean;
  reason?: string;
}

/** 校验邮箱是否真实可用：格式 → 非临时域 → 域名 MX/A 记录（能否收信） */
export async function checkEmailDeliverable(email: string): Promise<EmailCheck> {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, reason: "邮箱格式不对" };
  }
  const domain = email.split("@")[1].toLowerCase();

  if (DISPOSABLE.has(domain)) {
    return { ok: false, reason: "请使用真实邮箱注册——临时邮箱收不到课程与找回邮件" };
  }

  /* MX：这个域是否配了收信服务器；没有 MX 再退查 A 记录（少数域用 A 直收） */
  try {
    const mx = await resolveMx(domain);
    if (!mx || mx.length === 0) {
      return { ok: false, reason: "这个邮箱域名没有配置收信服务，请确认邮箱写对了" };
    }
    return { ok: true };
  } catch {
    try {
      await resolveA(domain);
      return { ok: true };
    } catch {
      return { ok: false, reason: "这个邮箱域名不存在，请检查有没有拼错" };
    }
  }
}
