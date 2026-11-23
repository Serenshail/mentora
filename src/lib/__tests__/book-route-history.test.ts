import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../store";
import type { Book, BookChapter } from "../types";

/* 第二批 C R04：阅读路线快照/恢复的 store 级验证（真 store，同 store-snapshot.test.ts 先例）。
 * 锁定：重排前快照可恢复；恢复只回退章节列表与路线类型；对话/沉淀/洞见/学习状态/验收档案不动；
 * 恢复本身形成新历史（可再回退）。 */

const ch = (id: string, title: string, opts: Partial<BookChapter> = {}): BookChapter => ({
  id,
  title,
  status: "todo",
  focusQuestion: `q-${title}`,
  ...opts,
});

function seedBook(): Book {
  return {
    id: "bk-r",
    title: "路线测试书",
    status: "reading",
    readStatus: "reading",
    routeType: "full",
    goal: { primary: "understand", secondary: [], setAt: "2026-11-01" },
    chapters: [ch("c1", "第一章", { status: "done" }), ch("c2", "第二章"), ch("c3", "第三章")],
    deposits: [{ id: "d1", chapterId: "c1", type: "point", text: "重要沉淀", at: "2026-11-02" }],
    insights: [{ id: "i1", text: "洞见", addedAt: "2026-11-02" }],
    chat: [{ id: "m1", role: "user", content: "对话消息", at: "2026-11-02" }],
    assessments: [{ id: "a1", chapterId: "c1", kind: "explain", question: "q", answer: "", level: "mastered", evidence: "e", feedback: "f", at: "2026-11-02" }],
    learning: { knownConcepts: ["概念A"], misconceptions: [], unresolvedQuestions: [], evidence: [] },
    createdAt: "2026-11-01",
  } as Book;
}

beforeEach(() => {
  useAppStore.setState({ books: [seedBook()] as ReturnType<typeof useAppStore.getState>["books"] });
});

describe("snapshotBookRoute / restoreBookRoute（R04：路线历史）", () => {
  it("重排前快照 → 重排 → 恢复：章节列表回退，沉淀/对话/洞见/学习/验收档案全保留", () => {
    const s = useAppStore.getState();
    s.snapshotBookRoute("bk-r", "重排为core");
    const histId = useAppStore.getState().books[0].routeHistory![0].id!;
    /* 模拟重排（regenerateBookRoute 的行为）：换章节列表，验收归档由它负责，这里直接换列表 */
    useAppStore.getState().regenerateBookRoute("bk-r", {
      planSummary: "新路线",
      routeType: "core",
      chapters: [ch("c9", "新节点", { status: "todo" })],
    });
    /* 恢复 */
    expect(useAppStore.getState().restoreBookRoute("bk-r", histId)).toBe(true);
    const b = useAppStore.getState().books[0];
    expect(b.chapters.map((c) => c.title)).toEqual(["第一章", "第二章", "第三章"]);
    expect(b.routeType).toBe("full");
    /* 用户成果不动 */
    expect(b.deposits).toHaveLength(1);
    expect(b.chat).toHaveLength(1);
    expect(b.insights).toHaveLength(1);
    expect(b.learning?.knownConcepts).toEqual(["概念A"]);
    expect(b.assessments).toHaveLength(1);
    /* 恢复本身形成新历史（可再回退） */
    expect(b.routeHistory!.length).toBe(2);
  });

  it("快照上限 5 条，旧数据绝不删除", () => {
    const s = useAppStore.getState();
    for (let i = 0; i < 7; i++) s.snapshotBookRoute("bk-r", `第${i}次`);
    expect(useAppStore.getState().books[0].routeHistory).toHaveLength(5);
  });

  it("恢复到不存在的历史 → false，不做任何写入", () => {
    const before = useAppStore.getState().books[0];
    expect(useAppStore.getState().restoreBookRoute("bk-r", "rh_ghost")).toBe(false);
    expect(useAppStore.getState().books[0]).toBe(before);
  });
});
