import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../store";
import { computePhaseEdit, applyPhaseEdit } from "../agent/phase-edit";
import { executeTool, executeAction } from "../agent/tool-executors";
import type { Goal } from "../types";

/* 独立复核 7 项探针的正式回归版（2026-11-10）。
 * 来源：docs/evidence/batch1-independent-review-2026-11-10/probe.ts
 * 复核发现 R1–R5 五类缺陷并全部复现；本文件把同样的业务断言纳入默认 npm test，
 * 防止「单独改边界不写入 / 增删排序无快照 / 恢复不还原元信息 / 旧方案覆盖新修改 / 未知或重复阶段 ID」再次回归。
 * 断言按 PRD 预期行为写死，不得为让缺陷通过而放宽。 */

const goal = (): Goal => ({
  id: "audit-goal",
  topic: "审查专用目标",
  direction: "",
  domainKind: "coding",
  motivation: "",
  background: "",
  weeklyHours: 3,
  successCriteria: [],
  status: "active",
  createdAt: "2026-11-10T00:00:00Z",
  quizLog: [],
  intakeTranscript: [],
  plan: {
    summary: "audit",
    totalDays: 1,
    weeklyHours: 3,
    startDate: "2026-11-10",
    createdAt: "2026-11-10T00:00:00Z",
    phases: [
      {
        id: "p1", title: "原阶段", outcome: "原目标", estDays: 3, boundary: "原边界",
        status: "active", dayIds: ["d1"],
        catalog: [{ id: "d1", title: "原课程", knowledgePoints: ["指针"] }],
      },
      { id: "p2", title: "后续阶段", outcome: "链表", status: "locked", dayIds: [] },
    ],
    days: {
      d1: {
        id: "d1", phaseId: "p1", title: "原课程", stub: true,
        knowledgePoints: [{ id: "k1", text: "指针" }],
        resources: [], method: "", acceptance: [], status: "passed", attempts: 1,
      },
    },
  },
});

const current = () => useAppStore.getState().goals[0];

beforeEach(() => useAppStore.setState({ goals: [goal()], knowledge: [] }));

describe("第一批独立复核回归（R1–R5）", () => {
  it("R1 只改边界必须真实写入", () => {
    const c = computePhaseEdit(current(), { boundaryChanges: { p1: "仅学习指针" } });
    if (!c.ok) throw new Error(c.content);
    expect(applyPhaseEdit(c.draft).ok).toBe(true);
    expect(current().plan!.phases[0].boundary).toBe("仅学习指针");
  });

  it("R2 删除阶段必须留下可恢复版本，且能恢复回来", () => {
    const c = computePhaseEdit(current(), { removePhaseIds: ["p1"] });
    if (!c.ok) throw new Error(c.content);
    expect(applyPhaseEdit(c.draft).ok).toBe(true);
    expect(current().planHistory?.length ?? 0).toBeGreaterThan(0);
    const h = current().planHistory!.at(-1)!;
    expect(useAppStore.getState().restorePlanVersion("audit-goal", h.id!)).toBe(true);
    expect(current().plan!.phases.map((x) => x.id)).toContain("p1");
  });

  it("R2b 仅调整阶段顺序也必须留下可恢复版本", () => {
    const c = computePhaseEdit(current(), { phaseOrder: ["p2", "p1"] });
    if (!c.ok) throw new Error(c.content);
    applyPhaseEdit(c.draft);
    expect(current().planHistory?.length ?? 0).toBeGreaterThan(0);
  });

  it("R3 恢复必须还原阶段标题/目标/预估天数", () => {
    const c = computePhaseEdit(current(), { phaseMeta: { p1: { title: "新阶段", outcome: "新目标", estDays: 8 } } });
    if (!c.ok) throw new Error(c.content);
    applyPhaseEdit(c.draft);
    const h = current().planHistory!.at(-1)!;
    expect(useAppStore.getState().restorePlanVersion("audit-goal", h.id!)).toBe(true);
    expect(current().plan!.phases[0]).toMatchObject({ title: "原阶段", outcome: "原目标", estDays: 3 });
  });

  it("R4 批准后发生的并发修改必须使旧方案失效（不得静默覆盖）", async () => {
    /* 用**多阶段**改动构造待批方案：单阶段只改标题的明确小改动自 2026-11-11 起
       按原指令直接执行（ACT-01/A01），不再产生审批卡，也就没有「批准前被改」的窗口。 */
    const preview = await executeTool("edit_phase", {
      id: "audit-goal",
      changes: { phaseMeta: { p1: { title: "草稿标题" }, p2: { title: "草稿标题二" } } },
    });
    expect(preview.action).toBeDefined();
    useAppStore.getState().updatePhaseMeta("audit-goal", "p1", { title: "另一标签页的新标题" });
    const result = await executeAction(preview.action!);
    expect(result.ok).toBe(false);
    expect(current().plan!.phases[0].title).toBe("另一标签页的新标题");
  });

  it("R5 阶段顺序不得产生重复阶段", () => {
    const c = computePhaseEdit(current(), { phaseOrder: ["p2", "p2", "p1"] });
    if (c.ok) applyPhaseEdit(c.draft);
    const ids = current().plan!.phases.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("R5b 引用不存在的阶段 ID 必须失败，不能伪成功", () => {
    expect(computePhaseEdit(current(), { phaseMeta: { missing: { title: "新标题" } } }).ok).toBe(false);
  });
});
