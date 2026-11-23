import dns from "node:dns";
import { promisify } from "node:util";

const resolveMx = promisify(dns.resolveMx);
const resolveA = promisify(dns.resolve);

/* 邮箱取证的 DNS 总预算：resolveMx→resolveA 是两次串行查询，只靠 c-ares 内建超时
 * （每次数秒且含重试）在黑洞型解析器下会叠加到数十秒，注册请求因此卡死——
 * 自托管端没有 Vercel 函数时限兜底。与 url-guard 的 DNS 超时纪律一致：
 * 超预算即视为"无法取证"，交给调用处的 fail-open，绝不因外部依赖拖死注册。 */
export const EMAIL_DNS_BUDGET_MS = 4_000;

/** 给单次 DNS 查询套上剩余预算；预算耗尽直接 reject（按解析失败处理） */
function withDnsDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("dns timeout")), Math.max(0, deadline - Date.now()));
    }),
  ]).finally(() => clearTimeout(timer));
}

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
  /* 总预算从进入 DNS 取证开始计时：MX 用掉多少，A 只剩剩下的部分，
   * 两次串行查询的上界因此是 EMAIL_DNS_BUDGET_MS 而不是两者之和。 */
  const deadline = Date.now() + EMAIL_DNS_BUDGET_MS;
  try {
    const mx = await withDnsDeadline(resolveMx(domain), deadline);
    if (!mx || mx.length === 0) {
      return { ok: false, reason: "这个邮箱域名没有配置收信服务，请确认邮箱写对了" };
    }
    return { ok: true };
  } catch {
    try {
      await withDnsDeadline(resolveA(domain), deadline);
      return { ok: true };
    } catch {
      /* MX/A 全查不动 = DNS 故障期无法取证：按声明的 fail-open 放行，
       * 不得只放行白名单域（否则 protonmail/企业高校域全被挡在门外）。 */
      return { ok: true };
    }
  }
}
