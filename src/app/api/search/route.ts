import { NextRequest } from "next/server";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { verifySession } from "@/lib/server/auth";
import { isDeployed } from "@/lib/server/deploy-env";
import { relevantSearchResults } from "@/lib/search-relevance";
import {
  BROWSER_HEADERS,
  MAX_SEARCH_RESULTS,
  SEARCH_TIMEOUT_MS,
  searchBing,
  type SearchResult,
} from "@/lib/server/search-bing";

export const runtime = "nodejs";

/* 联网搜索网关（agent web_search 工具的后端）。
 * 安全铁律：
 *  - 上游 provider 固定在服务端（TAVILY → BRAVE → DuckDuckGo Lite 兜底），Key 不下发、
 *    不接受客户端传 baseUrl（与 /api/chat 的"Key 与 baseUrl 同源"同一纪律）；
 *  - 只返回结构化结果（title/url/snippet），不代抓页面正文（抓页走 /api/fetch-page 的 SSRF 守卫）；
 *  - 每用户持久限流：容量 20、按天回填（≈20 次/天），部署者成本可控。
 * 日志脱敏：只记结果数与通道，不记完整 query。 */

const MAX_RESULTS = MAX_SEARCH_RESULTS;

/* 全链聚合预算：单 provider 的 fetch 各有 8s AbortSignal 超时，但链上没有总闸——
 * 全上游同时挂起（自托管出网被墙/DNS 黑洞时典型）最坏 8s×4 串行 ≈32s，突破设备认证
 * 注释里的「网关 15s 无数据熔断线」（device-auth.ts:17），用户拿到网关层 500 而非
 * 结构化 502，并占用函数槽。与 fetch-page（TOTAL_TIMEOUT_MS 全程 deadline）、
 * cron/expiry-reminder（BUDGET_MS 分块预算）同一纪律：每个 provider 只拿到
 * min(8s, 剩余预算)，预算耗尽即停，剩余 provider 不再尝试，直接落 502/空态。
 * 取 14s：给网关 15s 熔断线留 1s 响应序列化余量。每用户 20 次/天持久限流封顶滥用面。 */
const SEARCH_CHAIN_BUDGET_MS = 14_000;

async function searchTavily(query: string, timeoutMs: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: MAX_RESULTS }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  const j = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (j.results ?? [])
    .filter((r) => r.url)
    .slice(0, MAX_RESULTS)
    .map((r) => ({ title: r.title || r.url!, url: r.url!, snippet: (r.content || "").slice(0, 300) }));
}

async function searchBrave(query: string, timeoutMs: number): Promise<SearchResult[]> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`,
    { headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY!, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) }
  );
  if (!res.ok) throw new Error(`brave ${res.status}`);
  const j = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
  return (j.web?.results ?? [])
    .filter((r) => r.url)
    .slice(0, MAX_RESULTS)
    .map((r) => ({ title: r.title || r.url!, url: r.url!, snippet: (r.description || "").slice(0, 300) }));
}


async function searchDuckDuckGo(query: string, timeoutMs: number): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { ...BROWSER_HEADERS, Referer: "https://www.google.com/" },
    signal: AbortSignal.timeout(timeoutMs),
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

  const providers: { name: string; run: (timeoutMs: number) => Promise<SearchResult[]> }[] = [];
  if (process.env.TAVILY_API_KEY) providers.push({ name: "tavily", run: (t) => searchTavily(query, t) });
  if (process.env.BRAVE_API_KEY) providers.push({ name: "brave", run: (t) => searchBrave(query, t) });
  providers.push({ name: "bing", run: (t) => searchBing(query, t) });
  providers.push({ name: "duckduckgo", run: (t) => searchDuckDuckGo(query, t) });

  let lastErr = "";
  let emptyProvider = "";
  const chainDeadline = Date.now() + SEARCH_CHAIN_BUDGET_MS;
  for (const p of providers) {
    /* 总预算闸（fetch-page 的 deadline 同款）：剩余不足就停，不再发起注定撞熔断线的上游 */
    const remaining = chainDeadline - Date.now();
    if (remaining <= 0) break;
    try {
      const results = relevantSearchResults(query, await p.run(Math.min(SEARCH_TIMEOUT_MS, remaining)));
      if (results.length) return Response.json({ results, provider: p.name });
      emptyProvider ||= p.name;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "unknown";
    }
  }
  if (emptyProvider) return Response.json({ results: [], provider: emptyProvider });
  return Response.json({ error: `搜索上游不可用（${lastErr.slice(0, 80)}）` }, { status: 502 });
}
