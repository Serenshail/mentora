import { NextRequest } from "next/server";
import { rateLimit, clientIp } from "@/lib/server/rate-limit";
import { assertSafePublicUrl } from "@/lib/server/url-guard";

export const runtime = "nodejs";
export const maxDuration = 30;

/* 链接体检:检测推荐资源是否 失效(dead) / 疑似广告(ad)。
 * SSRF 防护 v17 起接入统一 url-guard：形态黑名单之外再做 **DNS 解析取证**
 * （十进制 IP 2130706433、任意解析到内网的域名都过不了），并**跟随重定向后
 * 复检最终落点**（旧实现只查入口一次，redirect:follow 能把请求带进内网）。 */

const AD_TITLE = /(广告|推广|优惠|折扣|购买|选购|注册送|免费领取|coupon|sale|buy now|sponsor)/i;
const AD_DOMAIN = /(doubleclick|adservice|adserver|affiliate|commission-junction|clickbank)/i;
const AFFILIATE_PARAM = /(utm_source|utm_medium|aff=|affiliate|ref=affiliate|campaign=)/i;

interface CheckResult {
  url: string;
  ok: boolean;
  dead: boolean;
  ad: boolean;
  status: number;
  title: string;
  finalUrl: string;
  reason: string;
}

async function checkOne(raw: string): Promise<CheckResult> {
  const base: CheckResult = { url: raw, ok: false, dead: false, ad: false, status: 0, title: "", finalUrl: raw, reason: "" };
  const entry = await assertSafePublicUrl(raw, { allowHttp: true });
  if (!entry.ok) return { ...base, dead: true, reason: "链接格式不受支持" };
  /* redirect:"manual" 逐跳校验后再跟进——此前 redirect:"follow" 请求先打出去、复检只是事后诸葛，
   * 内网目标照样被访问，且 { ...base } 还把内网服务的 HTTP 状态码带回给调用方（SSRF 探测预言机） */
  let current = raw;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(current, {
        signal: ctrl.signal,
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MentoraLinkCheck/1.0)" },
      });
      base.status = res.status;
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { ...base, dead: true, reason: `HTTP ${res.status} 重定向缺目标` };
        let next: URL;
        try {
          next = new URL(loc, current);
        } catch {
          return { ...base, dead: true, reason: "重定向目标无效" };
        }
        const safe = await assertSafePublicUrl(next.href, { allowHttp: true });
        if (!safe.ok) return { ...base, dead: true, reason: "重定向到不安全地址" };
        current = next.href;
        continue;
      }
      base.finalUrl = current;
      if (res.status >= 400 || res.status === 404 || res.status === 410) {
        return { ...base, dead: true, reason: `HTTP ${res.status} 已失效` };
      }
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html")) {
        // 非网页(文件/接口)不算广告,视为可访问
        return { ...base, ok: true, reason: "可访问" };
      }
      const html = (await res.text().catch(() => "")).slice(0, 200_000);
      const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      base.title = (m?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      const adByTitle = AD_TITLE.test(base.title);
      const adByDomain = AD_DOMAIN.test(new URL(base.finalUrl).hostname);
      const adByParam = AFFILIATE_PARAM.test(base.finalUrl);
      if (adByTitle || adByDomain || adByParam) {
        return { ...base, ad: true, reason: adByTitle ? "标题含营销词" : adByDomain ? "广告域名" : "带affiliate参数" };
      }
      return { ...base, ok: true, reason: "可访问" };
    }
    return { ...base, dead: true, reason: "重定向次数过多" };
  } catch (e) {
    const timeout = e instanceof Error && e.name === "AbortError";
    return { ...base, dead: false, ok: false, reason: timeout ? "超时(无法确认)" : "无法访问(网络/被墙)" };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: NextRequest) {
  if (!rateLimit(`linkcheck:${clientIp(req)}`, { capacity: 20, refillPerSec: 20 / 60 })) {
    return Response.json({ error: "检测太频繁" }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const urls: string[] = Array.isArray(body.urls) ? body.urls.slice(0, 10) : [];
  const results = await Promise.all(urls.map(checkOne));
  return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
}
