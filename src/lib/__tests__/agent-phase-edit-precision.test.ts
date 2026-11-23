import { describe, expect, it, beforeEach } from "vitest";

/* ============ ACT-01：计划的精确定位与小改动落地（L1 确定性验证） ============
 * 用户报的两个真实问题：
 *  1) 说「把 Python 第二阶段的标题改成…」——模型拿不到阶段的稳定 id，也读不到
 *     「第二阶段」对应的 phaseId，只能猜，edit_phase 必然报「阶段不存在」；
 *  2) 计划调整「只检索、不落地」：读完目标就空转，业务对象始终没变。
 * 本锁验证：
 *  - get_goal 现在返回带 id 与序号（用户口语顺序）的阶段清单；
 *  - 明确、可逆的**单个阶段改名**按原指令直接执行一次（不再二次批准），业务对象真的变了；
 *  - 结构性改动（多阶段/多字段/增删）仍走审批门，不静默写入。 */

import { useAppStore } from "@/lib/store";
import { executeTool } from "@/lib/agent/tool-executors";
import type { DayPlan, Goal, Plan } from "@/lib/types";

const ISO = "2026-11-11T00:00:00.000Z";

function day(id: string, phaseId: string, title: string, status: DayPlan["status"] = "locked"): DayPlan {
  return {
    id,
    phaseId,
    title,
    knowledgePoints: [],
    resources: [],
    method: "",
    acceptance: [],
    status,
    attempts: 0,
  };
}

function makePlan(): Plan {
  return {
    summary: "Python 从基础到文件处理",
    totalDays: 5,
    weeklyHours: 3,
    startDate: ISO,
    createdAt: ISO,
    phases: [
      {
        id: "phase-basics",
        title: "第一阶段 语法基础",
        outcome: "能写简单脚本",
        dayIds: ["d1"],
        status: "active",
        catalog: [{ id: "d1", title: "变量与类型", knowledgePoints: [] }],
        estDays: 3,
      },
      {
        id: "phase-files",
        title: "第二阶段 文件读写",
        outcome: "能读写文件",
        dayIds: ["d2", "d3"],
        status: "locked",
        catalog: [
          { id: "d2", title: "打开与关闭", knowledgePoints: [] },
          { id: "d3", title: "异常处理", knowledgePoints: [] },
        ],
        estDays: 2,
      },
    ],
    days: {
      d1: day("d1", "phase-basics", "变量与类型", "passed"),
      d2: day("d2", "phase-files", "打开与关闭"),
      d3: day("d3", "phase-files", "异常处理", "skipped"),
    },
  };
}

function makeGoal(id = "goal-python-1", topic = "Python"): Goal {
  return {
    id,
    topic,
    direction: "文件处理",
    motivation: "",
    status: "active",
    createdAt: ISO,
    plan: makePlan(),
    quizLog: [],
    successCriteria: [],
  } as unknown as Goal;
}

function seed(goals: Goal[]) {
  useAppStore.setState({ goals });
}

const titleOf = (goalId: string, phaseId: string) =>
  useAppStore.getState().goals.find((g) => g.id === goalId)!.plan!.phases.find((p) => p.id === phaseId)!.title;

beforeEach(() => {
  seed([makeGoal()]);
});

describe("get_goal 暴露阶段稳定 id 与口语序号（ACT-01 前提）", () => {
  it("返回每个阶段的序号、phaseId、完成天数", async () => {
    const out = await executeTool("get_goal", { id: "goal-python-1" }, {});
    expect(out.result.ok).toBe(true);
    const c = out.result.content;
    expect(c).toContain("phase-basics");
    expect(c).toContain("phase-files");
    expect(c).toMatch(/1\. 第一阶段 语法基础/);
    expect(c).toMatch(/2\. 第二阶段 文件读写/);
    // 第二阶段 2 天里有 1 天是 skipped
    expect(c).toContain("1/2 天已完成");
  });
});

describe("明确的小改动按原指令直接落地（ACT-01 / A01）", () => {
  it("单阶段改名：不产生审批卡，业务对象当场改变", async () => {
    const out = await executeTool(
      "edit_phase",
      { id: "goal-python-1", changes: { phaseMeta: { "phase-files": { title: "第二阶段 文件与数据处理" } } } },
      {}
    );
    expect(out.action, "单阶段改名不应再要求二次批准").toBeUndefined();
    expect(out.result.ok).toBe(true);
    expect(titleOf("goal-python-1", "phase-files")).toBe("第二阶段 文件与数据处理");
    /* 其它阶段与天目录不受影响 */
    expect(titleOf("goal-python-1", "phase-basics")).toBe("第一阶段 语法基础");
    expect(Object.keys(useAppStore.getState().goals[0].plan!.days).sort()).toEqual(["d1", "d2", "d3"]);
  });

  it("改名留下历史版本（可恢复），不是无痕迹偷改", async () => {
    await executeTool(
      "edit_phase",
      { id: "goal-python-1", changes: { phaseMeta: { "phase-files": { title: "新标题" } } } },
      {}
    );
    const hist = useAppStore.getState().goals[0].planHistory ?? [];
    expect(hist.length).toBeGreaterThan(0);
    expect(hist[hist.length - 1].phaseId).toBe("phase-files");
  });
});

describe("结构性改动仍走审批门（ACT-02）", () => {
  it("同时改两个阶段 → 出审批卡，且此刻业务对象未变", async () => {
    const out = await executeTool(
      "edit_phase",
      {
        id: "goal-python-1",
        changes: {
          phaseMeta: { "phase-basics": { title: "A" }, "phase-files": { title: "B" } },
        },
      },
      {}
    );
    expect(out.action, "多阶段改动必须先看方案再批准").toBeTruthy();
    expect(titleOf("goal-python-1", "phase-files")).toBe("第二阶段 文件读写");
  });

  it("改标题同时改预估天数 → 出审批卡", async () => {
    const out = await executeTool(
      "edit_phase",
      { id: "goal-python-1", changes: { phaseMeta: { "phase-files": { title: "新标题", estDays: 5 } } } },
      {}
    );
    expect(out.action).toBeTruthy();
    expect(titleOf("goal-python-1", "phase-files")).toBe("第二阶段 文件读写");
  });

  it("删除阶段 → 出审批卡（带完成日警告）", async () => {
    const out = await executeTool(
      "edit_phase",
      { id: "goal-python-1", changes: { removePhaseIds: ["phase-files"] } },
      {}
    );
    expect(out.action).toBeTruthy();
    expect(out.action!.payload.removedCompletedDays).toBe(1);
    expect(useAppStore.getState().goals[0].plan!.phases.length).toBe(2);
  });

  it("只改一个阶段的天目录（phaseCatalogs）→ 仍出审批卡", async () => {
    const out = await executeTool(
      "edit_phase",
      {
        id: "goal-python-1",
        changes: { phaseCatalogs: { "phase-files": [{ title: "打开与关闭" }, { title: "异常处理" }, { title: "上下文管理器" }] } },
      },
      {}
    );
    expect(out.action).toBeTruthy();
  });
});

describe("对象消歧：同名项目必须问，不能默认第一个 active（ACT-01/A02）", () => {
  it("两个同名 Python 目标 → 返回候选而不是任选一个", async () => {
    seed([makeGoal("goal-python-1"), makeGoal("goal-python-2")]);
    const out = await executeTool("edit_phase", { topic: "Python", changes: { phaseMeta: { "phase-files": { title: "X" } } } }, {});
    expect(out.action).toBeUndefined();
    expect(out.result.ok).toBe(false);
    expect(out.result.summary).toBe("需消歧");
    // 两个目标都没被改动
    expect(titleOf("goal-python-1", "phase-files")).toBe("第二阶段 文件读写");
    expect(titleOf("goal-python-2", "phase-files")).toBe("第二阶段 文件读写");
  });

  it("给了精确 id 就只作用于该对象", async () => {
    seed([makeGoal("goal-python-1"), makeGoal("goal-python-2")]);
    const out = await executeTool(
      "edit_phase",
      { id: "goal-python-2", changes: { phaseMeta: { "phase-files": { title: "只改第二个" } } } },
      {}
    );
    expect(out.result.ok).toBe(true);
    expect(titleOf("goal-python-2", "phase-files")).toBe("只改第二个");
    expect(titleOf("goal-python-1", "phase-files")).toBe("第二阶段 文件读写");
  });
});

describe("get_goal 天级明细（A04/Q08 前提：模型必须知道哪天已完成）", () => {
  it("返回每个学习日的 dayId 与状态，而不只是完成计数", async () => {
    const out = await executeTool("get_goal", { id: "goal-python-1" }, {});
    const c = out.result.content;
    /* fixture 里 d2 是 locked、d3 是 skipped */
    expect(c).toContain("打开与关闭（id=d2，未开始）");
    expect(c).toContain("异常处理（id=d3，已跳过）");
    expect(c).toContain("变量与类型（id=d1，已完成）");
    /* 反向断言：不能只有「1/2 天已完成」这种计数 */
    expect(c).not.toMatch(/^\s*2\. 第二阶段 文件读写.*\n(?!\s+- )/m);
  });
});
