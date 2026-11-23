import { describe, expect, it } from "vitest";
import { bm25Search, type RagDoc, type RagHit } from "../rag";

/* 回归锁（2026-11-10）：bm25Search 不再每次调用全量重建 df/tf。
 * 一条答疑消息的检索链路会对同一批语料做最多 5 次 BM25（基线 1 次 + 原问句与
 * ≤3 个改写问句各 1 次），旧实现每次都为全库每个 token 建 df Map、并为每篇重建
 * tf Map，是 O(全库 token 数) 的重复劳动。改造后：tf 随分词结果缓存，
 * df 只对查询词按需统计。缓存必须满足两点，否则就是拿正确性换速度：
 *   ① 结果与"每次现算 df/tf"的朴素实现完全一致；
 *   ② 语料集合或任一笔记内容变化后，不得命中旧统计（不能读到过期 tf）。
 * 下面用一份内联的朴素实现作为参照基准（与改造前的算法逐行等价）。 */

/** 与 rag.ts tokenize 等价：英文/数字整词 + 中文二元组 */
function tokenizeRef(text: string): string[] {
  const tokens: string[] = [];
  const ascii = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  tokens.push(...ascii);
  const cjk = text.replace(/[^\u4e00-\u9fa5]/g, "");
  for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk.slice(i, i + 2));
  if (cjk.length === 1) tokens.push(cjk);
  return tokens;
}

/** 参照实现：每次调用都从零重建 df 与 tf（改造前 bm25Search 的行为） */
function bm25Reference(query: string, docs: RagDoc[], k = 3): RagHit[] {
  if (docs.length === 0) return [];
  const k1 = 1.5;
  const b = 0.75;
  const docsTokens = docs.map((d) => tokenizeRef(`${d.title} ${d.title} ${d.body}`));
  const avgLen = docsTokens.reduce((a, t) => a + t.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const tokens of docsTokens) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = docs.length;
  const qTokens = [...new Set(tokenizeRef(query))];
  const scored = docs.map((doc, i) => {
    const tokens = docsTokens[i];
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const len = tokens.length;
    let score = 0;
    for (const qt of qTokens) {
      const f = tf.get(qt);
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(qt) ?? 0) + 0.5) / ((df.get(qt) ?? 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
    }
    return { doc, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, k);
}

const corpus: RagDoc[] = [
  { id: "a", title: "间隔重复与遗忘曲线", body: "间隔重复 1/3/7/15 天复习，主动回忆配合测试效应。", version: 2, updatedAt: "2026-09-01T00:00:00.000Z" },
  { id: "b", title: "主动回忆", body: "提取练习比重复阅读有效，闭包不是这里的话题。", version: 1, updatedAt: "2026-08-01T00:00:00.000Z" },
  { id: "c", title: "React 闭包与状态快照", body: "闭包捕获渲染时的变量，用函数式更新或 ref 解决 stale state。", version: 1, updatedAt: "2026-07-01T00:00:00.000Z" },
  { id: "d", title: "番茄工作法", body: "25 分钟专注加 5 分钟休息，对抗拖延。", version: 1, updatedAt: "2026-06-01T00:00:00.000Z" },
];

const queries = ["间隔重复 遗忘曲线", "闭包", "主动回忆 提取练习", "番茄 拖延", "不存在的词"];

describe("bm25Search df/tf 改造（性能改造的正确性锁）", () => {
  it("多条查询连续调用，结果与每次现算 df/tf 完全一致", () => {
    /* 首次调用填充缓存，后续调用复用同一批语料的 tf——分数与排序都不得漂移 */
    for (const q of queries) {
      const got = bm25Search(q, corpus, 4);
      const want = bm25Reference(q, corpus, 4);
      expect(got.map((h) => h.doc.id)).toEqual(want.map((h) => h.doc.id));
      got.forEach((h, i) => expect(h.score).toBeCloseTo(want[i].score, 10));
    }
  });

  it("重复同一查询（缓存全命中）仍返回相同结果", () => {
    const first = bm25Search("闭包 状态快照", corpus, 3);
    const second = bm25Search("闭包 状态快照", corpus, 3);
    expect(second.map((h) => h.doc.id)).toEqual(first.map((h) => h.doc.id));
    second.forEach((h, i) => expect(h.score).toBeCloseTo(first[i].score, 10));
  });

  it("语料新增文档后 df 按新语料统计，不得沿用旧结果", () => {
    /* 先跑一次把旧语料的 tf 写进缓存 */
    bm25Search("闭包", corpus, 4);
    const grown = [...corpus, { id: "e", title: "闭包补充", body: "闭包 作用域 补充说明。" }];
    const got = bm25Search("闭包", grown, 5);
    const want = bm25Reference("闭包", grown, 5);
    expect(got.map((h) => h.doc.id)).toEqual(want.map((h) => h.doc.id));
    got.forEach((h, i) => expect(h.score).toBeCloseTo(want[i].score, 10));
  });

  it("笔记内容更新（version/updatedAt 变化）后使用新正文", () => {
    const before = [{ id: "n", title: "旧标题", body: "完全无关的正文", version: 1, updatedAt: "2026-01-01T00:00:00.000Z" }];
    expect(bm25Search("闭包", before, 1)).toHaveLength(0);
    const after = [{ id: "n", title: "新标题", body: "闭包 词法作用域", version: 2, updatedAt: "2026-02-01T00:00:00.000Z" }];
    const hits = bm25Search("闭包", after, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].doc.id).toBe("n");
    expect(hits[0].score).toBeCloseTo(bm25Reference("闭包", after, 1)[0].score, 10);
  });

  it("调用方不传 version/updatedAt（如 wiki-compile）时改正文也能失效", () => {
    /* wiki-compile 只传 {id,title,body}：若缓存键只按 id，改完正文仍会命中旧分词 */
    const before = [{ id: "k", title: "咖啡", body: "咖啡 烘焙 豆子" }];
    expect(bm25Search("闭包", before, 1)).toHaveLength(0);
    const after = [{ id: "k", title: "咖啡", body: "咖啡 烘焙 豆子，另记：闭包与词法作用域" }];
    const hits = bm25Search("闭包", after, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeCloseTo(bm25Reference("闭包", after, 1)[0].score, 10);
  });

  it("空库与无命中保持既有语义", () => {
    expect(bm25Search("闭包", [], 3)).toEqual([]);
    expect(bm25Search("完全不存在的查询词", corpus, 3)).toEqual([]);
  });
});
