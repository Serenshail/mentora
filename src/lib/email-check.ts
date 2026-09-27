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

  /* MX：这个域是否配了收信服务器；没有 MX 再退查 A 记录（少数域用 A 直收）。
   * 工程：DNS 全部失败(网络/DNS 故障)时判定为"无法取证"→ 放行并降级,
   * 绝不因外部依赖故障把真实用户挡在门外(fail-open),本地断网曾误伤真实注册。 */
  const knownGood = new Set([
    "gmail.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "yahoo.com",
    "qq.com", "163.com", "126.com", "sina.com", "sohu.com", "aliyun.com", "foxmail.com",
  ]);
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
      if (knownGood.has(domain)) return { ok: true }; // DNS 故障期间的已知大厂域放行
      return { ok: false, reason: "暂时无法核验这个邮箱域名，请稍后再试或换常用邮箱" };
    }
  }
}
