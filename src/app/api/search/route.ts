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

/** 无 Key 兜底：DuckDuckGo Lite 网页解析（尽力而为，被反爬时如实报错） */
async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MentoraAgent/1.0)" },
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
