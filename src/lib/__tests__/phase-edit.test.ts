import { describe, expect, it, vi } from "vitest";

/* phase-edit.ts 引用了带 @/ 别名的模块（store、phase-regen→ai/client），用 factory mock 拦截。
 * computePhaseEdit / diffPhaseDays / normalizeChanges 是纯函数，可独立单测；applyPhaseEdit 走真 store。 */
vi.mock("@/lib/store", async () => {
  const { create } = await import("zustand");
  return {
    useAppStore: create(() => ({ goals: [] })),
  };
});

import { computePhaseEdit, diffPhaseDays, normalizeChanges } from "../agent/phase-edit";
import type { Goal, Phase } from "../types";

const day = (id: string, title: string) => ({
  id, title, phaseId: "ph-1", stub: true,
  knowledgePoints: [], resources: [], method: "", acceptance: [], status: "locked" as const, attempts: 0,
});

function mkGoal(phases: Phase[]): Goal {
  return {
    id: "g-edit",
    topic: "Python",
    direction: "",
    domainKind: "coding",
    motivation: "",
    background: "",
    weeklyHours: 8,
    successCriteria: [],
    status: "active",
    createdAt: new Date().toISOString(),
    quizLog: [],
    intakeTranscript: [],
    plan: {
      summary: "s", totalDays: 5, weeklyHours: 8, startDate: "2026-11-09",
      createdAt: new Date().toISOString(),
      phases,
      days: Object.fromEntries(
        // 为每个 phase 的天补全 DayPlan
        phases.flatMap((p) => p.dayIds.map((id) => [id, { ...day(id, p.catalog?.find((c) => c.id === id)?.title ?? id), phaseId: p.id }]))
      ),
    },
  };
}

describe("normalizeChanges（编辑集校验）", () => {
  it("空编辑集返回错误", () => {
    expect(normalizeChanges({}).ok).toBe(false);
  });
  it("过滤空白标题的新增阶段", () => {
    const r = normalizeChanges({ addPhases: [{ title: "   " }, { title: "实战" }] });
    if (!r.ok) throw new Error("should be ok");
    expect(r.changes.addPhases).toEqual([{ title: "实战", outcome: undefined, estDays: undefined }]);
  });
});

describe("diffPhaseDays（AG-04：天目录差异与旧 id 保留）", () => {
  it("部分匹配沿用旧 id，新增标题标新增/移除（按标题精确对齐，近似标题算新增）", () => {
    const days: Record<string, { id: string; title: string }> = {
      d1: { id: "d1", title: "Day 1：变量" },
      d2: { id: "d2", title: "Day 2：函数" },
      d3: { id: "d3", title: "Day 3：对象" },
    };
    const d = diffPhaseDays(["d1", "d2", "d3"], days, ["Day 1：变量", "闭包专题"]);
    expect(d.kept).toEqual(["Day 1：变量"]);
    expect(d.added).toEqual(["闭包专题"]);
    expect(d.removed).toEqual(["Day 2：函数", "Day 3：对象"]);
    expect(d.newDayIds[0]).toBe("d1");
    expect(d.newDayIds[1].startsWith("day_")).toBe(true);
  });
});

describe("computePhaseEdit（L04/L05：方案计算，只计算不写盘）", () => {
  it("阶段元信息修改：检测到标题/目标变化", () => {
    const goal = mkGoal([
      { id: "ph-1", title: "第一阶段", outcome: "o1", dayIds: ["d1"], status: "active",
        catalog: [{ id: "d1", title: "Day 1", knowledgePoints: [] }] },
    ]);
    const r = computePhaseEdit(goal, { phaseMeta: { "ph-1": { title: "改后的第一阶段" } } });
    if (!r.ok) throw new Error("should be ok");
    expect(r.draft.perPhase[0].meta).toMatchObject({ "标题": "第一阶段 → 改后的第一阶段" });
    expect(r.draft.changes.phaseMeta!["ph-1"].title).toBe("改后的第一阶段");
  });

  it("天目录重出：影响文本包含保留/新增/移除统计", () => {
    const goal = mkGoal([
      { id: "ph-1", title: "P", outcome: "o", dayIds: ["d1", "d2"], status: "active",
        catalog: [{ id: "d1", title: "Day 1", knowledgePoints: [] }, { id: "d2", title: "Day 2", knowledgePoints: [] }] },
    ]);
    const r = computePhaseEdit(goal, { phaseCatalogs: { "ph-1": [{ title: "Day 1" }, { title: "全新主题" }] } });
    if (!r.ok) throw new Error("should be ok");
    expect(r.draft.perPhase[0].dayDiff).toBeTruthy();
    expect(r.draft.perPhase[0].dayDiff!.kept).toEqual(["Day 1"]);
    expect(r.draft.perPhase[0].dayDiff!.added).toEqual(["全新主题"]);
    /* 场景1：必须列出修改前后具体内容，不能只给计数 */
    expect(r.draft.impactText).toContain("原：Day 1、Day 2");
    expect(r.draft.impactText).toContain("新：Day 1、全新主题");
    expect(r.draft.impactText).toContain("保留（沿用原 id、进度不丢）：Day 1");
    expect(r.draft.impactText).toContain("新增：全新主题");
    expect(r.draft.impactText).toContain("移出当前路线（成绩/笔记保留）：Day 2");
  });

  it("阶段顺序变化被识别", () => {
    const goal = mkGoal([
      { id: "ph-1", title: "A", outcome: "o", dayIds: [], status: "locked" },
      { id: "ph-2", title: "B", outcome: "o", dayIds: [], status: "locked" },
    ]);
    const r = computePhaseEdit(goal, { phaseOrder: ["ph-2", "ph-1"] });
    if (!r.ok) throw new Error("should be ok");
    expect(r.draft.phaseOrderChanged).toBe(true);
  });

  it("无计划时返回错误", () => {
    const noPlan: Goal = {
      id: "g-edit", topic: "P", direction: "", domainKind: "coding", motivation: "", background: "",
      weeklyHours: 8, successCriteria: [], status: "draft", createdAt: new Date().toISOString(), quizLog: [], intakeTranscript: [],
    };
    const r = computePhaseEdit(noPlan, { phaseMeta: { "x": { title: "y" } } });
    expect(r.ok).toBe(false);
  });

  /* 自查缺陷回归：删除含已完成天的阶段必须告警（AG-04 / EX-07） */
  it("删除含已完成天的阶段：统计 removedCompletedDays 并写进影响文本", () => {
    const goal = mkGoal([
      { id: "ph-1", title: "已完成阶段", outcome: "o", dayIds: ["d1", "d2"], status: "passed",
        catalog: [{ id: "d1", title: "Day 1", knowledgePoints: [] }, { id: "d2", title: "Day 2", knowledgePoints: [] }] },
      { id: "ph-2", title: "后续阶段", outcome: "o", dayIds: [], status: "locked" },
    ]);
    /* 把 d1 标为已完成 */
    goal.plan!.days["d1"].status = "passed";
    const r = computePhaseEdit(goal, { removePhaseIds: ["ph-1"] });
    if (!r.ok) throw new Error("should be ok");
    expect(r.draft.removedCompletedDays).toBe(1);
    expect(r.draft.impactText).toContain("1 个已完成的学习日");
    expect(r.draft.impactText).toContain("成绩与笔记保留");
  });
});