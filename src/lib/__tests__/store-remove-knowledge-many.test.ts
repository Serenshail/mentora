import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../store";

/* ============ removeKnowledgeMany：批量删除一次 set 完成（回归锁） ============
 * 背景：删文件夹此前对 inFolder 逐篇调 removeKnowledge——每篇都是一次独立 store set：
 * 全库 filter+map（每篇都新建对象，N 篇删除共 O(N×库) 分配）+ withMoc 重建目录，
 * 且 persist 中间件每次 set 都同步 JSON.stringify 整仓写 localStorage。千级笔记库删
 * 几百篇的文件夹 = 数百次多 MB 同步序列化，主线程冻结数秒。
 * 修复：store 新增 removeKnowledgeMany(ids)，一次 set 完成全部删除 + 悬挂链接清理 +
 * 受影响科目 MOC 重建（与单篇 removeKnowledge 同口径）。
 * 直接真导入 store（同 create-knowledge-moc.test.ts），不依赖 DOM。 */

beforeEach(() => {
  useAppStore.setState({ knowledge: [], folders: [] });
});

describe("removeKnowledgeMany：批量删除语义", () => {
  it("给定 id 全部删除，其余保留", () => {
    const st = () => useAppStore.getState();
    st().addKnowledge(
      [
        { title: "甲", body: "", domain: "数学" },
        { title: "乙", body: "", domain: "数学" },
        { title: "丙", body: "", domain: "物理" },
      ],
      "manual",
      "t"
    );
    const ids = st().knowledge.filter((k) => k.title !== "丙").map((k) => k.id);
    st().removeKnowledgeMany(ids);
    const titles = st().knowledge.map((k) => k.title);
    expect(titles).not.toContain("甲");
    expect(titles).not.toContain("乙");
    expect(titles).toContain("丙");
  });

  it("指向被删笔记的悬挂链接被清理（与单篇 removeKnowledge 同口径）", () => {
    const st = () => useAppStore.getState();
    st().addKnowledge(
      [
        { title: "甲", body: "", domain: "数学" },
        { title: "乙", body: "", domain: "数学" },
      ],
      "manual",
      "t"
    );
    const [a, b] = st().knowledge;
    st().linkNotes(b.id, a.id);
    expect(st().knowledge.find((k) => k.id === b.id)?.links).toContain(a.id);
    st().removeKnowledgeMany([a.id]);
    expect(st().knowledge.find((k) => k.id === b.id)?.links).not.toContain(a.id);
  });

  it("受影响科目的 MOC 目录在同一次调用里重建，不再收录被删笔记", () => {
    const st = () => useAppStore.getState();
    st().addKnowledge(
      [
        { title: "甲", body: "", domain: "数学" },
        { title: "乙", body: "", domain: "数学" },
        { title: "丙", body: "", domain: "物理" },
      ],
      "manual",
      "t"
    );
    const mathIds = st().knowledge.filter((k) => k.domain === "数学").map((k) => k.id);
    st().removeKnowledgeMany(mathIds);
    const moc = st().knowledge.find((k) => k.title === "数学 · 目录");
    /* 科目只剩 MOC 自己（没有别的成员）时目录仍在，但正文不再指向已删笔记 */
    expect(moc?.body).not.toContain("[[甲]]");
    expect(moc?.body).not.toContain("[[乙]]");
    /* 未受影响的物理 MOC 不被牵连 */
    const phys = st().knowledge.find((k) => k.title === "物理 · 目录");
    expect(phys?.body).toContain("[[丙]]");
  });

  it("空数组是 no-op（不触发无谓的全库重算与写盘）", () => {
    const st = () => useAppStore.getState();
    st().addKnowledge([{ title: "甲", body: "", domain: "数学" }], "manual", "t");
    const before = st().knowledge;
    st().removeKnowledgeMany([]);
    expect(st().knowledge).toBe(before); // 引用不变 = 没有发生 set
  });

  it("等价性：删一篇时与 removeKnowledge 单篇调用的结果一致", () => {
    const st = () => useAppStore.getState();
    st().addKnowledge(
      [
        { title: "甲", body: "", domain: "数学" },
        { title: "乙", body: "[[甲]]", domain: "数学" },
      ],
      "manual",
      "t"
    );
    const snapshot = st().knowledge;
    const aId = snapshot.find((k) => k.title === "甲")!.id;
    st().removeKnowledgeMany([aId]);
    const batchResult = st().knowledge;
    useAppStore.setState({ knowledge: snapshot });
    st().removeKnowledge(aId);
    const singleResult = st().knowledge;
    expect(batchResult.map((k) => k.id).sort()).toEqual(singleResult.map((k) => k.id).sort());
    expect(batchResult.find((k) => k.title === "乙")?.links).toEqual(
      singleResult.find((k) => k.title === "乙")?.links
    );
  });
});
