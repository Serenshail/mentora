import { NextRequest } from "next/server";
import { rateLimit, clientIp } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

/* 链接体检:检测推荐资源是否 失效(dead) / 疑似广告(ad)。
 * 服务端代发请求并做 SSRF 防护(只允许公网 http/https,禁内网/回环/元数据地址)。 */

const AD_TITLE = /(广告|推广|优惠|折扣|购买|选购|注册送|免费领取|coupon|sale|buy now|sponsor)/i;
const AD_DOMAIN = /(doubleclick|adservice|adserver|affiliate|commission-junction|clickbank)/i;
const AFFILIATE_PARAM = /(utm_source|utm_medium|aff=|affiliate|ref=affiliate|campaign=)/i;

function isSafeUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return false;
  const port = u.port;
  if (port && port !== "80" && port !== "443") return false;
  return true;
}

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
  if (!isSafeUrl(raw)) return { ...base, dead: true, reason: "链接格式不受支持" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(raw, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MentoraLinkCheck/1.0)" },
    });
    clearTimeout(timer);
    base.status = res.status;
    base.finalUrl = res.url || raw;
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
  } catch (e) {
    clearTimeout(timer);
    const timeout = e instanceof Error && e.name === "AbortError";
    return { ...base, dead: false, ok: false, reason: timeout ? "超时(无法确认)" : "无法访问(网络/被墙)" };
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
