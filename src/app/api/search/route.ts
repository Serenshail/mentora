import { NextRequest } from "next/server";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { verifySession } from "@/lib/server/auth";
import { isDeployed } from "@/lib/server/deploy-env";

export const runtime = "nodejs";

/* 联网搜索网关（agent web_search 工具的后端）。
 * 安全铁律：
 *  - 上游 provider 固定在服务端（TAVILY → BRAVE → DuckDuckGo Lite 兜底），Key 不下发、
 *    不接受客户端传 baseUrl（与 /api/chat 的"Key 与 baseUrl 同源"同一纪律）；
 *  - 只返回结构化结果（title/url/snippet），不代抓页面正文（抓页走 /api/fetch-page 的 SSRF 守卫）；
 *  - 每用户持久限流：容量 20、按天回填（≈20 次/天），部署者成本可控。
 * 日志脱敏：只记结果数与通道，不记完整 query。 */

export const SEARCH_TIMEOUT_MS = 8_000;
const MAX_RESULTS = 5;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchTavily(query: string): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: MAX_RESULTS }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  const j = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (j.results ?? [])
    .filter((r) => r.url)
    .slice(0, MAX_RESULTS)
    .map((r) => ({ title: r.title || r.url!, url: r.url!, snippet: (r.content || "").slice(0, 300) }));
}

async function searchBrave(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`,
    { headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY!, Accept: "application/json" }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`brave ${res.status}`);
  const j = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
  return (j.web?.results ?? [])
    .filter((r) => r.url)
    .slice(0, MAX_RESULTS)
    .map((r) => ({ title: r.title || r.url!, url: r.url!, snippet: (r.description || "").slice(0, 300) }));
}

/* 浏览器伪装头（抄自参考实现的核心纪律）：搜索引擎对非浏览器
 * UA / 缺 Accept-Language 的请求直接 403；带上完整 Chrome 头可过基础反爬。 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ensp;|&#8194;/g, " ")
    .replace(/&middot;|&#0183;/g, "·")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** 无 Key 默认源：Bing 网页解析（cn.bing.com 国内外服务器均可达；
 * DDG 对数据中心 IP 反爬封锁，实测 Vercel hkg1 与国内直连都不可用，仅作末位兜底）。 */
async function searchBing(query: string): Promise<SearchResult[]> {
  const hosts = ["https://cn.bing.com", "https://www.bing.com"];
  let html = "";
  for (const host of hosts) {
    const url = `${host}/search?q=${encodeURIComponent(query)}&mkt=zh-CN&count=10`;
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, Referer: `${host}/` },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`bing ${res.status}`);
    html = await res.text();
    if (html.includes('class="b_algo"')) break;
  }
  if (!html.includes('class="b_algo"')) throw new Error("bing 无结果页");

  const out: SearchResult[] = [];
  /* 每条结果是一个 <li class="b_algo"> 块：h2>a=标题+链接，第一个 <p>=摘要 */
  for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
    if (out.length >= MAX_RESULTS) break;
    const block = m[0];
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    let href = a[1];
    /* bing 的跳转链接 /ck/a?...&u=a1<base64url> → 解出真实地址 */
    const uParam = /[?&]u=a1([^&]+)/.exec(href);
    if (uParam && /^https?:\/\//i.test(Buffer.from(uParam[1], "base64").toString("utf8"))) {
      href = Buffer.from(uParam[1], "base64").toString("utf8");
    }
    if (!/^https?:\/\//i.test(href)) continue;
    const title = decodeEntities(a[2].replace(/<[^>]+>/g, "")).trim();
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = p ? decodeEntities(p[1].replace(/<[^>]+>/g, "")).trim() : "";
    out.push({ title: title || href, url: href, snippet: snippet.slice(0, 300) });
  }
  if (out.length === 0) throw new Error("bing 解析为空");
  return out;
}

/** 无 Key 兜底：DuckDuckGo Lite 网页解析（尽力而为，被反爬时如实报错） */
async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { ...BROWSER_HEADERS, Referer: "https://www.google.com/" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
  const html = (await res.text()).slice(0, 400_000);
  const out: SearchResult[] = [];
  /* result__a 的 href 可能是 /l/?uddg=<encoded> 跳转链接，解出真实 URL */
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  for (const m of html.matchAll(snipRe)) {
    snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
  }
  let i = 0;
  for (const m of html.matchAll(linkRe)) {
    if (out.length >= MAX_RESULTS) break;
    let href = m[1];
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//i.test(href)) continue;
    const title = m[2].replace(/<[^>]+>/g, "").trim();
    out.push({ title: title || href, url: href, snippet: (snippets[i] || "").slice(0, 300) });
    i++;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const session = await verifySession();
  if (isDeployed() && !session) {
    return Response.json({ error: "登录后即可使用联网搜索（免费）" }, { status: 401 });
  }
  const bucketKey = `search:${session?.email || clientIp(req)}`;
  /* 20 容量、按天回填（20/86400 每秒）≈ 20 次/天 */
  const ok = await rateLimitPersistent(bucketKey, { capacity: 20, refillPerSec: 20 / 86_400 });
  if (!ok) {
    return Response.json({ error: "今日搜索次数已用完，明天恢复。" }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as { query?: unknown };
  const query = String(body.query ?? "").trim().slice(0, 200);
  if (!query) {
    return Response.json({ error: "缺少搜索词" }, { status: 400 });
  }

  const providers: { name: string; run: () => Promise<SearchResult[]> }[] = [];
  if (process.env.TAVILY_API_KEY) providers.push({ name: "tavily", run: () => searchTavily(query) });
  if (process.env.BRAVE_API_KEY) providers.push({ name: "brave", run: () => searchBrave(query) });
  providers.push({ name: "bing", run: () => searchBing(query) });
  providers.push({ name: "duckduckgo", run: () => searchDuckDuckGo(query) });

  let lastErr = "";
  for (const p of providers) {
    try {
      const results = await p.run();
      return Response.json({ results, provider: p.name });
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "unknown";
    }
  }
  return Response.json({ error: `搜索上游不可用（${lastErr.slice(0, 80)}）` }, { status: 502 });
}
