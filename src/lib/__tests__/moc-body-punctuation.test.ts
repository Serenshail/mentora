import { beforeEach, describe, expect, it } from "vitest";

if (typeof globalThis.localStorage === "undefined") {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => Array.from(mem.keys())[i] ?? null,
      get length() {
        return mem.size;
      },
    },
    configurable: true,
  });
}

import { useAppStore } from "../store";

/* ============ MOC 自动目录正文的标点必须全角 ============
 * withMoc 生成的「科目 · 目录」正文混用半角逗号（「…都挂在这里,点链接跳转,…」），
 * 与全库中文文案的全角风格不一致。它是自动生成、每次增删笔记都会被重算覆盖的长期
 * 内容——用户手改正文也会被下次 withMoc 覆盖回混排版本，无法根治。本锁钉死全角。 */

/** 中文字符紧邻半角 , : ; —— 中文语境下应使用全角 ，：； */
const HALF_WIDTH_BETWEEN_CJK = /[\u4e00-\u9fff][,:;]|[,:;][\u4e00-\u9fff]/;

beforeEach(() => {
  useAppStore.setState({ knowledge: [], folders: [] });
});

describe("withMoc 目录正文标点", () => {
  it("自动生成的目录正文使用全角标点", () => {
    useAppStore.getState().addKnowledge([{ title: "甲", body: "", domain: "数学" }], "manual", "t");
    const moc = useAppStore.getState().knowledge.find((k) => k.title === "数学 · 目录");
    expect(moc).toBeTruthy();
    expect(moc!.body).toContain("本科目下所有笔记都挂在这里，点链接跳转，新笔记自动加入。");
    expect(HALF_WIDTH_BETWEEN_CJK.test(moc!.body)).toBe(false);
  });

  it("重算（删笔记触发）也不会回退成半角", () => {
    useAppStore.getState().addKnowledge(
      [
        { title: "甲", body: "", domain: "数学" },
        { title: "乙", body: "", domain: "数学" },
      ],
      "manual",
      "t"
    );
    const id = useAppStore.getState().knowledge.find((k) => k.title === "甲")!.id;
    useAppStore.getState().removeKnowledge(id);
    const moc = useAppStore.getState().knowledge.find((k) => k.title === "数学 · 目录");
    expect(moc!.body).not.toContain("都挂在这里,点链接");
    expect(HALF_WIDTH_BETWEEN_CJK.test(moc!.body)).toBe(false);
  });
});
