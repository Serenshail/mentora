import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../store";
import type { KnowledgeItem } from "../types";

/* ============ addKnowledge 必须收养同标题 unresolved 占位（与 importKnowledge 同口径）============
 * 历史缺陷：addKnowledge 按「全部标题」去重（`new Set(get().knowledge.map(k => k.title))`），
 * unresolved 占位也被算作重复——先导入 Obsidian 库产生 [[X]] 占位后，学习/读书恰好产出
 * 同名知识点 X 时会被整条静默丢弃：用户的笔记没进库、占位永远灰着、指向占位 id 的既有
 * 链接永久悬空。importKnowledge 早已原位升级占位（v18.1），这里对齐：
 *  · 真笔记已存在 → 仍然丢弃（保留既有去重语义）
 *  · 是 unresolved 占位 → 原位升级、收养其 id（新正文进得来，链接不悬空、不留同名双笔记）
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

describe("addKnowledge：同标题占位原位升级", () => {
  beforeEach(() => {
    useAppStore.setState({ knowledge: [], folders: [] });
  });

  it("unresolved 占位被收养：id 不变、正文更新、不再悬空", () => {
    useAppStore.setState({
      knowledge: [note({ id: "ph1", title: "特征值", domain: "数学", unresolved: true, links: [] })],
    });
    const added = useAppStore.getState().addKnowledge([{ title: "特征值", body: "真实正文", domain: "数学" }], "learn", "验收");
    expect(added).toBe(1);

    const st = useAppStore.getState().knowledge;
    expect(st.filter((k) => k.title === "特征值").length).toBe(1); // 不留同名双笔记
    const adopted = st.find((k) => k.id === "ph1")!;
    expect(adopted.body).toBe("真实正文");
    expect(adopted.unresolved).toBeFalsy(); // 占位已升级为真笔记
    expect(adopted.source).toBe("learn");
  });

  it("收养后加入科目 MOC 目录（链接指向同一 id）", () => {
    useAppStore.setState({
      knowledge: [note({ id: "ph2", title: "熵", domain: "物理", unresolved: true })],
    });
    useAppStore.getState().addKnowledge([{ title: "熵", body: "热力学熵", domain: "物理" }], "learn", "t");
    const moc = useAppStore.getState().knowledge.find((k) => k.title === "物理 · 目录");
    expect(moc?.body).toContain("[[熵]]");
    // 目录里的 wikilink 解析到的实体仍是占位 id
    expect(useAppStore.getState().knowledge.find((k) => k.title === "熵")?.id).toBe("ph2");
  });

  it("同标题真笔记仍按原语义被去重丢弃（返回 0、正文不变）", () => {
    useAppStore.setState({ knowledge: [note({ id: "k1", title: "牛顿第二定律", body: "旧正文", domain: "物理" })] });
    const added = useAppStore.getState().addKnowledge([{ title: "牛顿第二定律", body: "新正文", domain: "物理" }], "manual", "t");
    expect(added).toBe(0);
    const st = useAppStore.getState().knowledge;
    expect(st.length).toBe(1);
    expect(st[0].body).toBe("旧正文");
  });
});
