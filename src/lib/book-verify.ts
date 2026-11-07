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

/** 可信书目来源：出版社/百科/图书平台/馆藏目录（搜索引擎返回一个同名页面 ≠ 书被确认） */
const CREDIBLE_SOURCE =
  /豆瓣|百科|出版社|读书|京东|当当|图书|book|douban|baike|wikipedia|图书馆|书目|epub|pdf/i;

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
  hits: BookSearchHit[]
): { status: "verified" | "insufficient"; credible: BookSearchHit[] } {
  const key = normalizeTitle(title);
  if (!key) return { status: "insufficient", credible: [] };
  const keyPrefix = key.slice(0, 8).toLowerCase();
  const credible = hits.filter(
    (r) =>
      CREDIBLE_SOURCE.test(r.title + " " + r.url) &&
      normalizeTitle(r.title).toLowerCase().includes(keyPrefix)
  );
  if (credible.length === 0) return { status: "insufficient", credible: [] };
  const authorTrim = author.trim();
  if (authorTrim && !credible.some((r) => (r.title + " " + r.snippet).includes(authorTrim))) {
    return { status: "insufficient", credible };
  }
  return { status: "verified", credible };
}

/** 走 /api/search 网关核查（同源，会话 cookie 自动携带）。服务异常向上抛，由调用方决定话术。 */
export async function verifyBook(
  title: string,
  author: string,
  signal?: AbortSignal
): Promise<BookVerifyResult> {
  const query = `${title.trim()} ${author.trim()} 书 书籍`.trim();
  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal,
  });
  const vj = (await res.json().catch(() => ({}))) as { results?: BookSearchHit[] };
  const hits = vj.results ?? [];
  const judged = judgeBookEvidence(title, author, hits);
  return { status: judged.status, hits, credible: judged.credible, query };
}
