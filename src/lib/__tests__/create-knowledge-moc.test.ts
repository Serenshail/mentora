import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../store";
import type { KnowledgeItem } from "../types";

/* ============ createKnowledge 新建笔记也要进科目 MOC 目录 ============
 * withMoc 生成的目录正文自称「新笔记自动加入」，但 MOC 重算此前只在
 * addKnowledge/removeKnowledge/改 domain（及后续补上的改标题）时触发，createKnowledge
 * 漏了——「新建笔记」产生的笔记在「XX · 目录」里一直缺席，直到下次增删才自愈。
 * 直接真导入 store（同 note-rename-moc-refresh.test.ts），不依赖 DOM。 */

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

beforeEach(() => {
  useAppStore.setState({ knowledge: [], folders: [] });
});

describe("createKnowledge：新建笔记进所属科目 MOC", () => {
  it("已有科目目录时，新建笔记被索引进去", () => {
    const st = () => useAppStore.getState();
    st().addKnowledge([{ title: "旧笔记", body: "", domain: "数学" }], "manual", "t");
    st().createKnowledge({ title: "新定理", domain: "数学" });
    const moc = st().knowledge.find((k) => k.title === "数学 · 目录");
    expect(moc?.body).toContain("[[新定理]]");
    expect(moc?.body).toContain("[[旧笔记]]");
  });

  it("科目还没有目录时也会建一张（与 addKnowledge 同口径）", () => {
    const st = () => useAppStore.getState();
    st().createKnowledge({ title: "第一课", domain: "物理" });
    expect(st().knowledge.some((k) => k.title === "物理 · 目录")).toBe(true);
  });

  it("domain 为子路径时归到顶层科目（数学/子集 → 数学 · 目录）", () => {
    const st = () => useAppStore.getState();
    useAppStore.setState({ knowledge: [note({ id: "x", title: "占位", domain: "数学" })] });
    st().createKnowledge({ title: "子集笔记", domain: "数学/子集" });
    const moc = st().knowledge.find((k) => k.title === "数学 · 目录");
    expect(moc?.body).toContain("[[子集笔记]]");
  });
});
