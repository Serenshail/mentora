/**
 * 无 Key 搜索通道（Bing 网页解析）。
 *
 * 从 `app/api/search/route.ts` 迁出：App Router 的 route 文件只允许导出
 * HTTP 方法与少量框架配置，额外的函数导出会让 `next build` 的类型检查失败。
 * 行为与超时配置保持不变。
 */

export const SEARCH_TIMEOUT_MS = 8_000;
export const MAX_SEARCH_RESULTS = 5;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/* 浏览器伪装头（抄自参考实现的核心纪律）：搜索引擎对非浏览器
 * UA / 缺 Accept-Language 的请求直接 403；带上完整 Chrome 头可过基础反爬。 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

export function decodeEntities(s: string): string {
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
 * DDG 对数据中心 IP 反爬封锁，实测 Vercel hkg1 与国内直连都不可用，仅作末位兜底）。
 * timeoutMs 是本 provider 的**总预算**（缺省 SEARCH_TIMEOUT_MS=8s）：两跳互备共享，
 * 每跳拿到 floor(timeoutMs/2)。旧实现每跳各 8s、两跳最坏 16s——搜索路由加了全链
 * 聚合预算后按剩余预算传值，这里不拆分的话单 bing 就能突破预算与网关熔断线。 */
export async function searchBing(query: string, timeoutMs: number = SEARCH_TIMEOUT_MS): Promise<SearchResult[]> {
  /* 纯英文查询走 en-US：中文市场会把 "The Pragmatic Programmer" 召回成中文镜像/知乎，
 * 出版社官网进不了候选（独立复测：真实书目被误拒的直接原因之一）。 */
  const englishOnly = /[A-Za-z]/.test(query) && !/[\u4e00-\u9fa5]/.test(query);
  const mkt = englishOnly ? "en-US" : "zh-CN";
  const hosts = ["https://cn.bing.com", "https://www.bing.com"];
  let html = "";
  let lastStatus = 0;
  for (const host of hosts) {
    const url = `${host}/search?q=${encodeURIComponent(query)}&mkt=${mkt}&count=10`;
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, Referer: `${host}/` },
      signal: AbortSignal.timeout(Math.max(1_000, Math.floor(timeoutMs / hosts.length))),
    });
    /* 单个 host 失败（如数据中心 IP 被 cn.bing.com 反爬 403）降级到下一个 host，
     * 只有全部 host 都失败才抛错——否则第二个 host 的互备分支永不可达。 */
    if (!res.ok) {
      lastStatus = res.status;
      continue;
    }
    html = await res.text();
    if (html.includes('class="b_algo"')) break;
  }
  if (!html.includes('class="b_algo"')) {
    throw new Error(lastStatus ? `bing ${lastStatus}` : "bing 无结果页");
  }

  const out: SearchResult[] = [];
  /* 每条结果是一个 <li class="b_algo"> 块：h2>a=标题+链接，第一个 <p>=摘要 */
  for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
    if (out.length >= MAX_SEARCH_RESULTS) break;
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