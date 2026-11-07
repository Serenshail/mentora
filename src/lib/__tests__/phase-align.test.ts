import { describe, expect, it, vi } from "vitest";

/* 只测纯函数 alignPhaseDayIds（V26.2-H5：标题对齐沿用旧 id）。
 * phase-regen.ts 引用了带 @/ 别名的模块，用工厂 mock 拦截（同 meta-filter.test.ts 先例）。 */
vi.mock("@/lib/ai/client", () => ({
  streamChat: async () => "",
  extractJson: () => null,
  readingPlanSchema: {},
  phaseListSchema: {},
}));
vi.mock("@/lib/store", () => ({
  useAppStore: { getState: () => ({ goals: [] }), setState: () => {}, subscribe: () => () => {} },
}));

import { alignPhaseDayIds } from "../agent/phase-regen";

describe("alignPhaseDayIds（V26.2-H5：重排按标题沿用旧 id，成绩/quizLog 引用保留）", () => {
  const days: Record<string, { id: string; title: string }> = {
    d1: { id: "d1", title: "Day 1：变量与类型" },
    d2: { id: "d2", title: "Day 2：函数与作用域" },
    d3: { id: "d3", title: "Day 3：对象与数组" },
  };

  it("标题完全相同的天沿用旧 id", () => {
    const r = alignPhaseDayIds(
      ["d1", "d2", "d3"],
      days,
      ["Day 1：变量与类型", "Day 2：函数与作用域", "Day 3：对象与数组"],
    );
    expect(r).toEqual(["d1", "d2", "d3"]);
  });

  it("标题不同（换角度重排）→ 新 id（空串占位，由调用方生成）", () => {
    const r = alignPhaseDayIds(["d1", "d2", "d3"], days, [
      "函数深入：参数与返回值",
      "闭包与作用域链",
      "数组高阶操作",
    ]);
    expect(r).toEqual(["", "", ""]);
  });

  it("部分匹配：只有命中的沿用，其余为新", () => {
    const r = alignPhaseDayIds(["d1", "d2", "d3"], days, [
      "Day 2：函数与作用域",
      "闭包专题",
      "Day 3：对象与数组（进阶）",
    ]);
    expect(r).toEqual(["d2", "", ""]);
  });

  it("标题空白差异归一化后匹配", () => {
    const r = alignPhaseDayIds(["d1"], days, ["Day  1：变量与类型"]);
    expect(r).toEqual(["d1"]);
  });

  it("同名标题只沿用一次（防重复 id）", () => {
    const r = alignPhaseDayIds(["d1", "d2"], days, ["Day 1：变量与类型", "Day 1：变量与类型"]);
    expect(r).toEqual(["d1", ""]);
  });

  it("旧 dayIds 指向不存在的天（脏数据）不崩溃", () => {
    const r = alignPhaseDayIds(["ghost"], { ...days, ghost: undefined as never }, ["任意标题"]);
    expect(r).toEqual([""]);
  });
});
