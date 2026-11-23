import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../store";
import type { KnowledgeItem } from "../types";

/* ============ 重命名笔记后科目 MOC 目录必须刷新（回归锁）============
 * 背景：标题逐键提交只调 updateKnowledge(note.id, { title })，而 store 的
 * updateKnowledge 只在 patch.domain 变化时才重算 withMoc。MOC 笔记正文是
 * `- [[${m.title}]]`，wiki-markdown 又按标题解析链接（wiki-markdown.tsx byTitle）：
 * 重命名被收录的笔记后，目录正文仍写 [[旧标题]] → 渲染成「笔记不存在，点击创建」，
 * 点一下会 openByTitle 新建一篇同旧标题的重复笔记（domain 还落错）。
 * 修复：标题变化时，若所属科目的目录已存在，重算该科目 MOC。
 * 直接真导入 store（同 store-snapshot.test.ts），不依赖 DOM。 */

const note = (over: Partial<KnowledgeItem> & { id: string; title: string }): KnowledgeItem => ({
  body: "",
  domain: "笔记",
  source: "manual",
  sourceTitle: "",
  masteredAt: "2026-01-01",
  reviewStage: 0,
  links: [],
  version: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("updateKnowledge：改标题刷新科目 MOC", () => {
  beforeEach(() => {
    useAppStore.setState({ knowledge: [], folders: [] });
  });

  it("重命名被目录收录的笔记后，目录正文跟随新标题（不留旧标题死链）", () => {
    const st = () => useAppStore.getState();
    st().addKnowledge([{ title: "甲笔记", body: "内容", domain: "数学" }], "manual", "t");
    const moc = () => st().knowledge.find((k) => k.title === "数学 · 目录");
    expect(moc()?.body).toContain("[[甲笔记]]");

    const target = st().knowledge.find((k) => k.title === "甲笔记")!;
    st().updateKnowledge(target.id, { title: "乙笔记" });

    expect(moc()?.body).toContain("[[乙笔记]]");
    expect(moc()?.body).not.toContain("[[甲笔记]]");
  });

  it("改正文（非标题）不动目录（避免无谓重算/漂移）", () => {
    const st = () => useAppStore.getState();
    st().addKnowledge([{ title: "丙笔记", body: "内容", domain: "物理" }], "manual", "t");
    const before = st().knowledge.find((k) => k.title === "物理 · 目录")!.body;
    st().updateKnowledge(st().knowledge.find((k) => k.title === "丙笔记")!.id, { body: "改写后" });
    expect(st().knowledge.find((k) => k.title === "物理 · 目录")!.body).toBe(before);
  });

  it("目录本来不存在的科目改名，不得凭空造一个目录", () => {
    useAppStore.setState({
      knowledge: [note({ id: "k-orphan", title: "孤立笔记", domain: "无目录科目" })],
      folders: [],
    });
    const st = () => useAppStore.getState();
    st().updateKnowledge("k-orphan", { title: "改名后" });
    expect(st().knowledge.find((k) => k.title === "无目录科目 · 目录")).toBeUndefined();
    expect(st().knowledge.map((k) => k.title)).toEqual(["改名后"]);
  });
});
