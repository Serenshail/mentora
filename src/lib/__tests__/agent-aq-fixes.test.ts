import { describe, expect, it, vi } from "vitest";

/* 第一批 P0——AQ 精确修复与对象消歧（AG-01 / AQ-02 / AQ-03）回归锁。
 * tool-executors 引用带 @/ 别名的模块，用工厂 mock 拦截（同 fix-01-agent-pipeline.test.ts 先例）。 */
vi.mock("@/lib/ai/client", () => ({
  streamChat: vi.fn(async () => ""),
  extractJson: () => { throw new Error("no json"); },
  readingPlanSchema: {},
  phaseListSchema: {},
}));
vi.mock("@/lib/store", () => ({
  useAppStore: { getState: () => ({ goals: [], knowledge: [], books: [], sessions: [], settings: {} }), setState: () => {}, subscribe: () => () => {} },
}));
vi.mock("@/lib/book-verify", () => ({ verifyBook: vi.fn(async () => null) }));
vi.mock("@/lib/rag", () => ({ buildContext: () => "", wikiRetrieve: () => [] }));
vi.mock("@/lib/track", () => ({ track: () => {} }));
vi.mock("@/lib/utils", () => ({
  uid: (p: string) => `${p}_test_${Math.random().toString(36).slice(2, 8)}`,
  todayISO: () => "2026-11-09",
}));
vi.mock("@/lib/resources", () => ({
  parseResourceConstraint: () => ({ resourceType: "video" }),
  classifyResource: () => ({}),
  validateResources: () => ({ verdicts: [] }),
}));

import { resolveGoal } from "../agent/tool-executors";

const goals = [
  { id: "g-py", topic: "Python 数据分析", direction: "数据分析", status: "active" },
  { id: "g-py-web", topic: "Python Web 开发", direction: "后端", status: "active" },
  { id: "g-js", topic: "JavaScript", direction: "前端", status: "active" },
];

describe("resolveGoal / AG-01 对象精确消歧", () => {
  it("精确主题名唯一命中", () => {
    const r = resolveGoal(goals, "JavaScript");
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.goalId).toBe("g-js");
  });

  it("子串命中多个相近目标 → 返回歧义候选（不给误改）", () => {
    const r = resolveGoal(goals, "Python");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates.map((c) => c.goalId).sort()).toEqual(["g-py", "g-py-web"]);
    }
  });

  it("按精确 id 命中", () => {
    const r = resolveGoal(goals, "", "g-py-web");
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.goalId).toBe("g-py-web");
  });

  it("EX-01：两个名称相近项目不取首个匹配，而是要求消歧", () => {
    const near = [
      { id: "a", topic: "Python 数据分析", direction: "pandas", status: "active" },
      { id: "b", topic: "Python 自动化", direction: "脚本", status: "active" },
    ];
    const r = resolveGoal(near, "Python");
    expect(r.kind).toBe("ambiguous");
  });

  it("唯一识别（相近词只有一个目标命中其余都不含）→ 精确", () => {
    const mix = [
      { id: "a", topic: "Flask 教程", direction: "web", status: "active" },
      { id: "b", topic: "React 教程", direction: "前端", status: "active" },
    ];
    /* 「Flask」只出现在 a；「教程」两个都含 → 用 Flask 精确命中 */
    const r = resolveGoal(mix, "Flask");
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.goalId).toBe("a");
  });

  it("未找到", () => {
    expect(resolveGoal(goals, "Rust").kind).toBe("none");
  });
});

/* create_goal 的 background 落入草稿 —— 通过 executeTool 验证 F07（AQ-02） */
import { executeTool } from "../agent/tool-executors";

describe("create_goal / F07 background 交接", () => {
  it("draft payload 包含 background（此前丢失，导致交接 transcript 缺背景）", async () => {
    const out = await executeTool("create_goal", {
      topic: "Python",
      direction: "数据分析",
      motivation: "想转行",
      background: "每周只有周三晚上能学，基础是算法入门",
    });
    expect(out.result.ok).toBe(true);
    const action = out.action!;
    expect(action.payload.background).toBe("每周只有周三晚上能学，基础是算法入门");
  });
});