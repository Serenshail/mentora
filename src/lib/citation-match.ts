/**
 * 引用与正文逐条对应（独立复测要求）：来源区不混入正文未提到的首页/搜索页。
 * 规则：URL 或标题出现在回答正文中才算对应；hompage/搜索页一律剔除。
 */
export type CitationLike = { title?: string; url: string };

const NON_CONTENT_PATH = /^\/(?:$|search|s\/|query|web\/?$)/i;

export function isContentUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    return !NON_CONTENT_PATH.test(u.pathname);
  } catch {
    return false;
  }
}

export function filterCitationsForAnswer<T extends CitationLike>(citations: T[], answer: string): T[] {
  const text = (answer || "").toLowerCase();
  if (!text.trim()) return [];
  return citations.filter((c) => {
    if (!c?.url || !isContentUrl(c.url)) return false;
    const url = c.url.toLowerCase();
    const title = (c.title || "").toLowerCase().trim();
    return text.includes(url) || (title.length >= 4 && text.includes(title));
  });
}