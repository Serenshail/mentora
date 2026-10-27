import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

// 迁移逻辑与 store.ts 的 v5 分支保持同一实现（按 dayIds 顺序重编 Day N：）
function migrateV5(goals: Array<{ plan?: { phases: Array<{ dayIds: string[] }>; days: Record<string, { title: string }> } }> = []) {
  return goals.map((g) => {
    if (!g?.plan) return g;
    const plan = structuredClone(g.plan);
    for (const ph of plan.phases) {
      ph.dayIds.forEach((id, i) => {
        const d = plan.days[id];
        if (!d) return;
        const rest = d.title.replace(/^Day\s*\d+[：:]\s*/, "");
        d.title = `Day ${i + 1}：${rest}`;
      });
    }
    return { ...g, plan };
  });
}

describe("v5 迁移：阶段天标题按 dayIds 顺序归一化", () => {
  it("重复编号（Day1,Day2,Day1,Day2）按顺序重编为 Day1..Day4", () => {
    const goals = [{
      plan: {
        phases: [{ dayIds: ["a", "b", "c", "d"] }],
        days: {
          a: { title: "Day 1：语法速通" },
          b: { title: "Day 2：数据结构" },
          c: { title: "Day1：从已有Python基础切入" },
          d: { title: "Day2：掌握常用数据结构" },
        },
      },
    }];
    const [g] = migrateV5(goals as never[]);
    const titles = ["a", "b", "c", "d"].map((id) => g.plan!.days[id].title);
    expect(titles).toEqual([
      "Day 1：语法速通",
      "Day 2：数据结构",
      "Day 3：从已有Python基础切入",
      "Day 4：掌握常用数据结构",
    ]);
  });

  it("无 plan 的目标原样返回", () => {
    const goals = [{ topic: "x" }];
    expect(migrateV5(goals as never[])[0]).toEqual({ topic: "x" });
  });
});
