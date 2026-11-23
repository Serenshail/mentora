import { describe, expect, it } from "vitest";
import { planProgress } from "../plan-progress";
import type { NodeStatus, Plan } from "../types";

/* 学习人生页进度环「把 active 计为已完成」的回归锁。
 * 背景：life-workspace.tsx 曾以 `status !== "locked"` 统计完成天数，
 * 但 NodeStatus = locked | active | passed | skipped：unlockNext 把下一天
 * 置为 active（正在学、尚未验收），只有验收通过/强制跳过才是完成。
 * 旧口径在 3 天计划刚开始就显示 33%（实际 0），学到最后一天未验收时
 * 显示 100% 却仍挂「进行中」徽章。正确口径与 learn/[id] 任务导航、
 * 小程序 overview 页一致：只数 passed / skipped。 */

function planWith(...statuses: NodeStatus[]): Plan {
  const days: Plan["days"] = {};
  statuses.forEach((status, i) => {
    const id = `d${i + 1}`;
    days[id] = {
      id,
      phaseId: "ph1",
      title: `第 ${i + 1} 天`,
      knowledgePoints: [],
      resources: [],
      method: "",
      acceptance: [],
      status,
      attempts: 0,
    };
  });
  return {
    summary: "",
    totalDays: statuses.length,
    weeklyHours: 0,
    startDate: "2026-11-09",
    phases: [{ id: "ph1", title: "阶段一", outcome: "", dayIds: Object.keys(days), status: "active" }],
    days,
    createdAt: "2026-11-09T00:00:00.000Z",
  };
}

describe("planProgress（学习人生进度环完成度口径）", () => {
  it("3 天计划刚开始（首日 active、其余 locked）为 0，不虚高一天", () => {
    expect(planProgress(planWith("active", "locked", "locked"))).toBe(0);
  });

  it("最后一天 active 未验收时为 (n-1)/n，不会显示 100% 自相矛盾", () => {
    expect(planProgress(planWith("passed", "passed", "active"))).toBeCloseTo(2 / 3);
  });

  it("passed 与 skipped 都算完成；active / locked 都不算", () => {
    expect(planProgress(planWith("passed", "skipped", "active", "locked"))).toBe(0.5);
  });

  it("全部完成才为 1", () => {
    expect(planProgress(planWith("passed", "skipped", "passed"))).toBe(1);
  });

  it("空计划 / 无计划返回 0，不产生 NaN", () => {
    expect(planProgress(planWith())).toBe(0);
    expect(planProgress(null)).toBe(0);
    expect(planProgress(undefined)).toBe(0);
  });
});
