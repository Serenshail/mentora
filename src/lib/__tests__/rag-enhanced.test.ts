import { describe, expect, it } from "vitest";
import {
  applyRerank,
  assessRetrieval,
  fuseMultiQuery,
  ragContext,
  rerankPrompt,
  wikiRetrieve,
  type RagDoc,
} from "../rag";

/* RAG 增强三件套（2026-10-26）回归锁：
 * 查询侧改写融合 / 精排解析与回退 / CRAG 自评。核心纪律=任何异常都降级到原行为，绝不丢结果。 */

const docs: RagDoc[] = [
  {
    id: "a",
    title: "React 闭包与状态快照",
    body: "闭包捕获的是渲染时的变量，不是最新值。解决办法用函数式更新或 ref。",
    tags: ["React"],
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    id: "b",
    title: "JavaScript 闭包原理",
    body: "闭包是函数与其词法作用域的组合，可以让内部函数访问外部变量。",
  },
  {
    id: "c",
    title: "番茄工作法",
    body: "25 分钟专注加 5 分钟休息，用来对抗拖延。",
  },
];

describe("fuseMultiQuery（多查询 RRF 融合）", () => {
  it("原问句命中的文档仍然排前", () => {
    const hits = fuseMultiQuery("闭包", ["闭包 词法作用域"], docs, 3);
    expect(hits[0].doc.id).toBe("b");
  });

  it("改写问句能把原问句漏掉的文档捞回来", () => {
    const onlyOriginal = fuseMultiQuery("状态快照", [], docs, 3);
    const withVariant = fuseMultiQuery("状态快照", ["闭包 最新值 ref"], docs, 3);
    expect(withVariant.length).toBeGreaterThanOrEqual(onlyOriginal.length);
    expect(withVariant.map((h) => h.doc.id)).toContain("a");
  });

  it("无改写时等价于单路检索", () => {
    const hits = fuseMultiQuery("闭包", [], docs, 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].doc.title).toContain("闭包");
  });

  it("空库返回空", () => {
    expect(fuseMultiQuery("闭包", ["x"], [], 3)).toEqual([]);
  });
});

describe("assessRetrieval（CRAG 自评）", () => {
  it("无命中判弱", () => {
    expect(assessRetrieval([]).weak).toBe(true);
  });
  it("只有一条命中判弱", () => {
    const hits = wikiRetrieve("番茄", docs, 3);
    expect(assessRetrieval(hits, { minHits: 2 }).weak).toBe(true);
  });
  it("命中充足且分数够判强", () => {
    const hits = wikiRetrieve("闭包 词法作用域 状态快照", docs, 3);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(assessRetrieval(hits, { minHits: 2, minTopScore: 0.5 }).weak).toBe(false);
  });
});

describe("rerankPrompt / applyRerank（LLM 精排）", () => {
  const hits = wikiRetrieve("闭包", docs, 3);

  it("候选编号从 1 开始且带摘要", () => {
    const pack = rerankPrompt("闭包", hits, 2);
    expect(pack.candidates[0].idx).toBe(1);
    expect(pack.candidates[0].excerpt.length).toBeLessThanOrEqual(300);
  });

  it("按模型给的下标重排", () => {
    const reordered = applyRerank(hits, [2, 1], 2);
    expect(reordered[0].doc.id).toBe(hits[1].doc.id);
  });

  it("支持 {idx, why} 对象形式", () => {
    const reordered = applyRerank(hits, [{ idx: 1, why: "直接答案" }], 1);
    expect(reordered).toHaveLength(1);
    expect(reordered[0].doc.id).toBe(hits[0].doc.id);
  });

  it("解析失败/越界回退原顺序（绝不丢结果）", () => {
    expect(applyRerank(hits, null, 2)).toHaveLength(2);
    expect(applyRerank(hits, [99, -1, "x"], 2)[0].doc.id).toBe(hits[0].doc.id);
    expect(applyRerank(hits, [], 2)).toHaveLength(2);
  });

  it("重复下标不产生重复结果", () => {
    const out = applyRerank(hits, [1, 1, 2], 3);
    expect(out.filter((h) => h.doc.id === hits[0].doc.id)).toHaveLength(1);
  });
});

describe("ragContext（注入裁剪）", () => {
  it("遵守字数上限且保留标题", () => {
    const hits = wikiRetrieve("闭包 番茄 状态", docs, 3);
    const ctx = ragContext(hits, 120);
    expect(ctx.length).toBeLessThanOrEqual(200);
    expect(ctx).toContain("《");
  });
});
