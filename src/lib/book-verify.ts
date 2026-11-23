/* ============================================================
 * 书籍真实性核查（V26.2-H2，PRD §5 BookVerificationService）
 *
 * 三条建书路径（UI 手动 / agent add_book / 小程序）共用同一判定：
 *   搜索书名+作者 → 按可信书目来源过滤 → 作者匹配校验 → verified / insufficient
 * 搜索服务不可用（网络/限流）→ unsearchable（PRD C7：明确提示暂时无法核实，不假装不存在）。
 *
 * 纪律（PRD §5.4）：
 *   - 只有 VERIFIED 才允许"正式生成"（标注 verified）；
 *   - 用户坚持 + 粘贴原文材料 → 允许生成，但必须标注 user_material（基于你的材料）；
 *   - 搜索失败 ≠ 书不存在，话术用"无法核实"，不用"不存在"。
 * ============================================================ */

export interface BookSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export type BookVerifyStatus = "verified" | "insufficient" | "unsearchable";

export interface BookVerifyResult {
  status: BookVerifyStatus;
  /** 全部搜索结果（弹窗"最接近的结果"展示用） */
  hits: BookSearchHit[];
  /** 可信来源命中（verified 时 ≥1） */
  credible: BookSearchHit[];
  query: string;
}

/** 可信书目来源：按 URL 域名白名单判定（出版社/百科/图书平台/馆藏目录）。
 *  不能拿标题/URL 文本做关键词匹配——"facebook.com/.../《某书》读书会"、"booking.com"、
 *  "notebook.example.com" 这类 UGC/票务页标题常含书名，命中关键词后会被当成书目证据，
 *  让零真实证据的书被标成 verified（PRD §5.4 只有 VERIFIED 才允许正式生成）。 */
const CREDIBLE_HOSTS = [
  "douban.com", // 豆瓣（book.douban.com 图书条目）
  "jd.com", // 京东图书
  "dangdang.com", // 当当
  "openlibrary.org", // Open Library
  "worldcat.org", // 全球联机联合目录
  "nlc.cn", // 中国国家图书馆
  "books.google.com", // Google 图书
  "amazon.cn", // 亚马逊中国
  "amazon.com", // 亚马逊
  "weread.qq.com", // 微信读书
  "book.qq.com",
  /* 出版社官网：PRD §9 实测 The Pragmatic Programmer 被误拒——pragprog.com 有正式书目页，
   * 旧白名单只收平台/馆藏，导致真实书无法建书。 */
  "pragprog.com",
  "oreilly.com",
  "pearson.com",
  "manning.com",
  "packtpub.com",
];

/** 取 URL 的 host（小写、去端口与 www.）；非 http(s)/无法解析 → ""。
 *  不用 URL 构造器：小程序基础库未必有，正则取 authority 段两端都可用。 */
function urlHost(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  if (!m) return "";
  return m[1].toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
}

/** 是否为可信书目来源：host 等于白名单域或为其子域（evil-douban.com 不算）。 */
export function isCredibleSource(url: string): boolean {
  const host = urlHost(url);
  if (!host) return false;
  return CREDIBLE_HOSTS.some((d) => host === d || host.endsWith("." + d));
}

/** 书名归一化：去书名号/空白/常见标点，用于"标题含书名前 8 字"的子串匹配。
 *  两侧都归一化——搜索结果的标题常带书名号内标点（"思考，快与慢-京东图书"）。 */
function normalizeTitle(title: string): string {
  return title.trim().replace(/[《》\s：:·、！!？?，,。（()（）"'"]/g, "");
}

/**
 * 纯判定（可单测）：给搜索结果，判断书籍证据是否充分。
 * - 至少 1 条可信来源且标题含书名前 8 字 → 基本确认；
 * - 用户提供了作者时，还要求可信来源的标题/摘要提到该作者——拦"同名不同作者"
 *   与"真实书名+编造作者"（PRD C3/C4）；作者写法差异会落进 insufficient → 弹窗让用户确认，宁可暂停不编造。
 */
export function judgeBookEvidence(
  title: string,
  author: string,
  hits: BookSearchHit[],
  /* 页面正文补充证据：搜索摘要常缺作者（如 pragprog 官网只给英文简介），
   * 抓页后把正文并入作者匹配，避免真实书目被误拒。 */
  pageText: Record<string, string> = {}
): { status: "verified" | "insufficient"; credible: BookSearchHit[] } {
  const key = normalizeTitle(title);
  if (!key) return { status: "insufficient", credible: [] };
  const keyPrefix = key.toLowerCase();
  const credible = hits.filter(
    (r) =>
      isCredibleSource(r.url) && isBookRecord(r) &&
      normalizeTitle(r.title).toLowerCase().includes(keyPrefix)
  );
  if (credible.length === 0) return { status: "insufficient", credible: [] };
  const authorTrim = author.trim();
  /* 多作者写法差异：搜索页常写 "David Thomas, Andrew Hunt"，用户输入 "David Thomas and Andrew Hunt"。
   * 按 and/&/逗号/顿号/斜杠拆分后逐名匹配，避免把真实书目误判为作者不符；
   * 仍要求每个作者名都出现（不放宽到只匹配一个，防止真实书名+编造作者）。 */
  const authors = authorTrim
    .split(/\s+and\s+|&|,|，|、|\//i)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (authors.length > 0 && !credible.some((r) => {
    const hay = (r.title + " " + r.snippet + " " + (pageText[r.url] ?? "")).toLowerCase();
    return authors.every((name) => hay.includes(name));
  })) {
    return { status: "insufficient", credible };
  }
  return { status: "verified", credible };
}

export type BookCandidateReason =
  | "accepted"
  | "not-credible-host"
  | "not-book-record"
  | "title-mismatch"
  | "author-mismatch";

/**
 * 逐条解释候选判定结果（独立复测要求：记录召回与拒绝原因）。
 * 只用于证据/诊断，不改变 judgeBookEvidence 的通过纪律。
 */
export function explainBookCandidates(
  title: string,
  author: string,
  hits: BookSearchHit[]
): { url: string; title: string; reason: BookCandidateReason }[] {
  const key = normalizeTitle(title).toLowerCase();
  const authors = author
    .trim()
    .split(/\s+and\s+|&|,|，|、|\//i)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return hits.map((hit) => {
    if (!isCredibleSource(hit.url)) return { url: hit.url, title: hit.title, reason: "not-credible-host" };
    if (!isBookRecord(hit)) return { url: hit.url, title: hit.title, reason: "not-book-record" };
    if (!key || !normalizeTitle(hit.title).toLowerCase().includes(key)) {
      return { url: hit.url, title: hit.title, reason: "title-mismatch" };
    }
    const hay = (hit.title + " " + hit.snippet).toLowerCase();
    if (authors.length > 0 && !authors.every((n) => hay.includes(n))) {
      return { url: hit.url, title: hit.title, reason: "author-mismatch" };
    }
    return { url: hit.url, title: hit.title, reason: "accepted" };
  });
}

/** A search page, dictionary entry, or shopping homepage is not a book record. */
function isBookRecord(hit: BookSearchHit): boolean {
  let url: URL;
  try { url = new URL(hit.url); } catch { return false; }
  const host = url.hostname.toLowerCase();
  if (host.endsWith("douban.com")) return host === "book.douban.com" && /^\/subject\/\d+\/?$/.test(url.pathname);
  if (host.endsWith("jd.com")) return host === "item.jd.com" && /^\/\d+\.html$/.test(url.pathname);
  if (host.endsWith("dangdang.com")) return /^\/\d+\.html$/.test(url.pathname);
  if (host === "openlibrary.org") return /^\/(works\/OL\d+W|books\/OL\d+M)(?:\/|$)/.test(url.pathname);
  if (host.endsWith("worldcat.org")) return /(?:\/oclc\/\d+|\/title\/\d+)(?:\/|$)/.test(url.pathname);
  if (host === "books.google.com") return url.pathname === "/books" && Boolean(url.searchParams.get("id"));
  if (host.endsWith("amazon.com") || host.endsWith("amazon.cn")) return /\/(?:dp|product)\/[0-9A-Z]{10}(?:\/|$)/i.test(url.pathname);
  /* 兜底尾部判定：只排除明确的搜索/查询路径。
   * 旧写法 `/search|query|s\//` 会把 `titles/tpp20/` 里的 `s/` 当成搜索页，
   * 导致 pragprog 等出版社路径永远进不了可信集合（PRD §9 真实书目被误拒的直接原因）。 */
  return url.pathname !== "/" && !/(?:^|\/)(?:search|query|s)\//i.test(url.pathname);
}

/** 走 /api/search 网关核查（同源，会话 cookie 自动携带）。服务异常向上抛，由调用方决定话术。
 *
 * 2026-11-11 搜索链路排查（docs/web-polish-2026-11-09/EVAL-01-CALIBRATION-2026-11-10.md §8）：
 *  Bing 对无 cookie 客户端的**多词查询**返回反爬降级结果——只按第一个词匹配，
 *  后续词（作者名、"书 书籍"）被无视，返回词典页/无关站点，导致核查必然 insufficient。
 *  单词查询实测可靠（「思考快与慢」直接命中 book.douban.com 条目）。
 *  因此查询改为**书名单 token**；作者仍由 judgeBookEvidence 的作者匹配校验把关——
 *  判定纪律不变（不放宽），只修查询策略。若书名本身含空格（外文书），去空格合并为单 token。 */
export function buildVerifyQuery(title: string): string {
  return title.trim().replace(/[《》\s]+/g, "");
}

/* 核查请求的客户端硬超时（见 verifyBook 注释）。 */
const BOOK_VERIFY_TIMEOUT_MS = 30_000;

export async function verifyBook(
  title: string,
  author: string,
  signal?: AbortSignal
): Promise<BookVerifyResult> {
  const singleToken = buildVerifyQuery(title);
  /* 双查询：先原文（英文书名保留空格，官网命中率高），未验证再退回单 token
   * （规避 Bing 中文多词降级）。两次查询都是确定性的，不重复相同词。 */
  const primary = title.trim().replace(/[《》]+/g, "");
  const queries = primary && primary !== singleToken ? [primary, singleToken] : [singleToken];
  /* 默认超时：agent 路径（tool-executors 的 add_book）调用时不传 signal——传输层挂起
   * （自托管端进程卡死、连接不 RST）会让该工具永久卡死且无取消手柄（runner.ts 未包超时）。
   * 传了 caller signal（read-workspace 的 UI 取消）时与默认超时合流，谁先触发都生效。
   * 上界 30s：/api/search 内部按 provider 串行 fallback（每个 SEARCH_TIMEOUT_MS=8s），
   * 最坏 ≈24s，30s 不会误杀仍然正常的慢请求。 */
  const budget = AbortSignal.timeout(BOOK_VERIFY_TIMEOUT_MS);
  const sig =
    signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, budget]) : signal ?? budget;

  let hits: BookSearchHit[] = [];
  let judged: { status: "verified" | "insufficient"; credible: BookSearchHit[] } = { status: "insufficient", credible: [] };
  const seen = new Set<string>();
  for (const query of queries) {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: sig,
    });
    /* 先解析（错误页/空响应体兜成 {}，拿到服务端 error 文案），再查 res.ok：
     * HTTP 失败（401/429/502…）不是「无可信来源」——向上抛，由调用方 catch 走
     * unsearchable 话术（「核查服务暂时不可用」），不把服务故障包装成「书不存在」（PRD §5.4）。 */
    const vj = (await res.json().catch(() => ({}))) as { results?: BookSearchHit[]; error?: string };
    if (!res.ok) {
      throw new Error(`搜索网关 ${res.status}${vj.error ? `：${vj.error}` : ""}`);
    }
    for (const hit of vj.results ?? []) {
      if (!hit?.url || seen.has(hit.url)) continue;
      seen.add(hit.url);
      hits.push(hit);
    }
    judged = judgeBookEvidence(title, author, hits);
    if (judged.status === "verified") break;
  }

  /* 出版社官网摘要常不含作者：抓一次书目页正文再判，避免真实书被误拒。
   * 仅对白名单出版社的 credible 候选抓页；错作者仍会在正文中核对不通过。 */
  if (judged.status !== "verified" && judged.credible.length > 0) {
    const publisher = judged.credible.find((h) =>
      /(?:^|\.)(?:pragprog\.com|oreilly\.com|pearson\.com|manning\.com|packtpub\.com)$/i.test(
        (() => {
          try {
            return new URL(h.url).hostname.toLowerCase().replace(/^www\./, "");
          } catch {
            return "";
          }
        })()
      )
    );
    if (publisher) {
      const page = await fetch("/api/fetch-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: publisher.url }),
        signal: sig,
      });
      const pj = (await page.json().catch(() => ({}))) as { title?: string; text?: string };
      if (page.ok && typeof pj.text === "string" && pj.text.trim()) {
        judged = judgeBookEvidence(title, author, hits, { [publisher.url]: `${pj.title ?? ""} ${pj.text}` });
      }
    }
  }

  return { status: judged.status, hits, credible: judged.credible, query: queries.join(" | ") };
}
