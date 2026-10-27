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
  /** 是否是**单集视频**且已通过平台接口证实存在 */
  video?: boolean;
  /** 真实作者/UP主（视频已证实时回填，UI 可展示） */
  author?: string;
}

/* ---------------- 视频直链校验 ----------------
 * 通用 HTTP 探测对视频平台不够用：YouTube 删除/私享视频仍返回 200，
 * 而 results?search_query、/playlist、频道页也都能 200 —— 用户点进去只是搜索页/合集，
 * 不是"确定的某个视频"。这里改用平台自己的元数据接口实证：
 *   YouTube → oEmbed（404 = 删除/私享/不存在）
 *   Bilibili → x/web-interface/view（code!==0 = 不存在/已删除/私享）
 * 成功时回填**真实标题/作者**，替代模型编造的标题。 */

const UA = "Mozilla/5.0 (compatible; MentoraLinkCheck/1.0)";

function baseOf(raw: string): CheckResult {
  return { url: raw, ok: false, dead: false, ad: false, status: 0, title: "", finalUrl: raw, reason: "" };
}

async function verifyYouTube(raw: string, id: string): Promise<CheckResult | null> {
  const base = baseOf(raw);
  if (!/^[\w-]{11}$/.test(id)) return { ...base, dead: true, reason: "视频 ID 格式不合法（疑似编造）" };
  const canonical = `https://www.youtube.com/watch?v=${id}`;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) {
      // 404 = 确实不存在/已删除；401/403 = 作者禁止站外嵌入（视频本身存在），
      // 交给通用探测确认可访问，不误杀
      if (res.status !== 404) return null;
      return {
        ...base,
        status: res.status,
        finalUrl: canonical,
        dead: true,
        reason: "视频不存在/私享/已删除",
      };
    }
    const j = (await res.json().catch(() => ({}))) as { title?: string; author_name?: string };
    return {
      ...base,
      ok: true,
      video: true,
      status: res.status,
      title: (j.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      author: (j.author_name ?? "").slice(0, 60),
      finalUrl: canonical,
      reason: "视频已验证",
    };
  } catch {
    return null; // 网络不可达 → 交给通用探测，不误杀
  }
}

async function verifyBilibili(raw: string, id: string): Promise<CheckResult | null> {
  const base = baseOf(raw);
  const q = /^BV/i.test(id) ? `bvid=${id}` : `aid=${id.replace(/^av/i, "")}`;
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?${q}`, {
      headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const j = (await res.json().catch(() => ({}))) as {
      code?: number;
      data?: { title?: string; owner?: { name?: string } };
    };
    if (j.code !== 0) return { ...base, dead: true, reason: "视频不存在/已删除/私享" };
    return {
      ...base,
      ok: true,
      video: true,
      title: (j.data?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      author: (j.data?.owner?.name ?? "").slice(0, 60),
      finalUrl: `https://www.bilibili.com/video/${id}`,
      reason: "视频已验证",
    };
  } catch {
    return null;
  }
}

/** 命中视频平台返回判定；非视频平台/短链返回 null（交给通用探测） */
async function checkVideo(raw: string): Promise<CheckResult | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const base = baseOf(raw);

  if (host === "youtu.be") return verifyYouTube(raw, u.pathname.split("/").filter(Boolean)[0] ?? "");
  if (host === "youtube.com") {
    if (u.pathname === "/watch") return verifyYouTube(raw, u.searchParams.get("v") ?? "");
    const shorts = u.pathname.match(/^\/shorts\/([\w-]{11})/);
    if (shorts) return verifyYouTube(raw, shorts[1]);
    return { ...base, dead: true, reason: "合集/频道/搜索页，不是具体视频" };
  }
  if (host === "b23.tv") return null; // 短链先走通用跟随
  if (host === "bilibili.com") {
    const m = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i);
    if (m) return verifyBilibili(raw, m[1]);
    return { ...base, dead: true, reason: "合集/频道/搜索页，不是具体视频" };
  }
  if (host.endsWith(".bilibili.com")) {
    return { ...base, dead: true, reason: "合集/频道/搜索页，不是具体视频" };
  }
  return null;
}

async function checkOne(raw: string): Promise<CheckResult> {
  const v = await checkVideo(raw);
  if (v) return v;
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
