import { beforeEach, describe, expect, it } from "vitest";

/* Node 环境没有 localStorage：zustand persist 的 setItem 会炸。给个最小内存实现。 */
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

import { DEFAULT_SETTINGS, useAppStore } from "../store";

/* ============ 导入校验回归锁 ============
 * 旧实现 importData 只做 JSON.parse + 裸合并：坏字段直接落盘，刷新后
 * goals.map / PROVIDERS[provider] 抛 TypeError，全应用崩死且应用内无法自救。 */

const importData = (data: unknown) => useAppStore.getState().importData(data);

beforeEach(() => {
  useAppStore.setState({
    goals: [],
    knowledge: [],
    books: [],
    sessions: [],
    customPersonas: [],
    folders: [],
    settings: { ...DEFAULT_SETTINGS, provider: "deepseek", apiKey: "sk-live" },
  });
});

describe("sanitizeBackup / importData", () => {
  it("拒绝整体类型错误的数据，且不写入任何状态", () => {
    expect(importData({ goals: "x" })).toBe(false);
    expect(importData([1, 2, 3])).toBe(false);
    expect(importData("not-json")).toBe(false);
    expect(importData({ knowledge: { bad: true } })).toBe(false);
    expect(useAppStore.getState().goals).toEqual([]);
    expect(useAppStore.getState().knowledge).toEqual([]);
  });

  it("合法备份正常导入", () => {
    expect(
      importData({
        goals: [{ id: "g1", topic: "Python", status: "active", quizLog: [] }],
      })
    ).toBe(true);
    const goals = useAppStore.getState().goals;
    expect(goals).toHaveLength(1);
    expect(goals[0].topic).toBe("Python");
  });

  it("非法 provider 被丢弃，保留本机当前 provider", () => {
    expect(importData({ settings: { provider: "evil" } })).toBe(true);
    expect(useAppStore.getState().settings.provider).toBe("deepseek");
  });

  it("备份里的空 apiKey 不会抹掉本机已配置的 Key", () => {
    expect(importData({ settings: { apiKey: "" } })).toBe(true);
    expect(useAppStore.getState().settings.apiKey).toBe("sk-live");
  });

  it("脏知识条目被规范化成可渲染形状", () => {
    expect(
      importData({ knowledge: [{ id: "k1", title: "笔记", body: 123, links: "nope" }] })
    ).toBe(true);
    const note = useAppStore.getState().knowledge[0];
    expect(note.body).toBe("");
    expect(note.links).toEqual([]);
  });
});

describe("logQuiz 裁剪", () => {
  it("只保留最近 200 条，长文本按字段截断", () => {
    const gid = useAppStore.getState().seedSampleGoal();
    const long = "x".repeat(2000);
    for (let i = 0; i < 205; i++) {
      useAppStore.getState().logQuiz(gid, {
        dayId: "d1",
        date: "2026-01-01",
        passed: true,
        forced: false,
        items: [
          { itemId: "a1", question: long, userAnswer: long, verdict: "correct", feedback: long },
        ],
      });
    }
    const goal = useAppStore.getState().goals.find((g) => g.id === gid)!;
    expect(goal.quizLog).toHaveLength(200);
    expect(goal.quizLog[0].items[0].question).toHaveLength(600);
    expect(goal.quizLog[0].items[0].userAnswer).toHaveLength(600);
    expect(goal.quizLog[0].items[0].feedback).toHaveLength(600);
  });
});
