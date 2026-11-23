type SearchHit = { title: string; snippet: string };

const ignored = new Set(["今天", "最近", "最新", "现在", "如何", "什么", "哪些", "请问", "搜索", "资料", "学习", "视频", "教程", "考试", "复习", "可以", "需要", "怎么", "还有", "多少", "以及", "相关"]);

export function searchTerms(text: string): string[] {
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  return [...new Set([...segmenter.segment(text.toLowerCase())]
    .filter((part) => part.isWordLike && part.segment.length >= 2 && !/^\d+$/.test(part.segment) && !ignored.has(part.segment))
    .map((part) => part.segment))];
}

export function relevantSearchResults<T extends SearchHit>(query: string, results: T[]): T[] {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const cet = /(?:英语)?四级|cet[-\s]?4/i.test(query) ? /四级|cet[-\s]?4/i
    : /(?:英语)?六级|cet[-\s]?6/i.test(query) ? /六级|cet[-\s]?6/i : null;
  return results.filter((result) => {
    const text = (result.title + " " + result.snippet).toLowerCase();
    return (!cet || cet.test(text)) && terms.some((term) => text.includes(term));
  });
}
