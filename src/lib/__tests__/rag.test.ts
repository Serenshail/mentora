import { describe, expect, it } from "vitest";
import { bm25Search, dedupeConflicts, wikiRetrieve, type WikiNote } from "../rag";

describe("dedupeConflicts（同知识点多文档裁决）", () => {
  it("高版本优先", () => {
    const docs = [
      { id: "1", title: "Python 基础", body: "旧版", version: 1 },
      { id: "2", title: "Python 基础", body: "新版", version: 3 },
    ];
    const out = dedupeConflicts(docs);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("2");
  });
  it("同版本取更新者", () => {
    const docs = [
      { id: "1", title: "X", body: "a", version: 1, updatedAt: "2024-01-01" },
      { id: "2", title: "X", body: "b", version: 1, updatedAt: "2025-01-01" },
    ];
    expect(dedupeConflicts(docs)[0].id).toBe("2");
  });
});

describe("wikiRetrieve（导航式检索）", () => {
  const notes: WikiNote[] = [
    { id: "a", title: "间隔重复", body: "间隔重复 1/3/7/15 遗忘曲线 主动回忆", links: ["b"] },
    { id: "b", title: "主动回忆", body: "主动回忆 测试效应 提取练习", links: [] },
    { id: "c", title: "无关笔记", body: "咖啡 烘焙 豆子 产地", links: [] },
  ];
  it("种子命中 + 出链邻居被导航进来", () => {
    const hits = wikiRetrieve("间隔重复 遗忘曲线", notes, 3);
    const ids = hits.map((h) => h.doc.id);
    expect(ids).toContain("a"); // 种子
    expect(ids).toContain("b"); // a 的出链邻居应被图导航带入
  });
  it("不相关笔记不靠前", () => {
    const hits = wikiRetrieve("间隔重复 遗忘曲线", notes, 2);
    expect(hits.map((h) => h.doc.id)).not.toContain("c");
  });
  it("悬挂出链与被冲突裁决淘汰的目标不会打崩检索", () => {
    /* 回归锁：图导航把出链 id 写进候选，但该 id 可能不在 clean 里
     * （ghost 根本不存在；old 被 dedupeConflicts 按版本淘汰）。旧实现
     * byId.get(id)! 拿到 undefined 后读 tags 直接 TypeError。 */
    const docs: WikiNote[] = [
      { id: "seed", title: "间隔重复 遗忘曲线", body: "间隔重复 遗忘曲线", links: ["ghost", "old"] },
      { id: "old", title: "重复笔记", body: "旧版", version: 1 },
      { id: "new", title: "重复笔记", body: "新版", version: 2 },
    ];
    expect(() => wikiRetrieve("间隔重复", docs, 3)).not.toThrow();
    const ids = wikiRetrieve("间隔重复", docs, 3).map((h) => h.doc.id);
    expect(ids).not.toContain("ghost");
    expect(ids).not.toContain("old");
  });
});

describe("bm25Search", () => {
  it("标题加权且返回正分", () => {
    const docs = [
      { id: "1", title: "双链 笔记", body: "普通内容" },
      { id: "2", title: "无关", body: "双链 出现在正文 双链" },
    ];
    const hits = bm25Search("双链", docs, 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].doc.id).toBe("1"); // 标题命中权重更高
  });
});
