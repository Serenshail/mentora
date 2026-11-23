import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../store";
import type { Goal } from "../types";

/* V26.2-H5：阶段重排语义（快照留痕 + 标题对齐沿用 id + 成绩保留）的 store 级验证。
 * 直接真导入 store（依赖面无 server-only/@别名），绕开浏览器云同步竞态。 */

const stubDay = (id: string, phaseId: string, title: string, status: "locked" | "passed" | "active") => ({
  id,
  phaseId,
  title,
  stub: true,
  knowledgePoints: [{ id: `${id}-kp1`, text: `${title}知识点` }],
  resources: [],
  method: "",
  acceptance: [],
  status,
  attempts: 0,
});

function seedGoal(): Goal {
  return {
    id: "g-h5-test",
    topic: "H5测试学科",
    direction: "",
    domainKind: "coding",
    motivation: "",
    background: "",
    weeklyHours: 8,
    successCriteria: [],
    status: "active",
    createdAt: new Date().toISOString(),
    quizLog: [{ dayId: "d-old-1", date: new Date().toISOString(), passed: true, forced: false, items: [] }],
    intakeTranscript: [],
    plan: {
      summary: "s",
      totalDays: 3,
      weeklyHours: 8,
      startDate: "2026-11-07",
      createdAt: new Date().toISOString(),
      phases: [
        {
          id: "ph-1",
          title: "阶段一",
          outcome: "o",
          dayIds: ["d-old-1", "d-old-2", "d-old-3"],
          status: "active",
          catalog: [
            { id: "d-old-1", title: "Day 1：变量", knowledgePoints: ["甲"] },
            { id: "d-old-2", title: "Day 2：函数", knowledgePoints: ["乙"] },
            { id: "d-old-3", title: "Day 3：数组", knowledgePoints: ["丙"] },
          ],
        },
      ],
      days: {
        "d-old-1": stubDay("d-old-1", "ph-1", "Day 1：变量", "passed"),
        "d-old-2": stubDay("d-old-2", "ph-1", "Day 2：函数", "locked"),
        "d-old-3": stubDay("d-old-3", "ph-1", "Day 3：数组", "locked"),
      },
    },
  };
}

beforeEach(() => {
  useAppStore.setState({ goals: [seedGoal()] as ReturnType<typeof useAppStore.getState>["goals"] });
});

describe("snapshotPhase（V26.2-H5 重排前快照）", () => {
  it("快照包含旧目录与原因，且 days 为深拷贝", () => {
    useAppStore.getState().snapshotPhase("g-h5-test", "ph-1", "想要更实践向");
    const g = useAppStore.getState().goals.find((x) => x.id === "g-h5-test")!;
    expect(g.planHistory).toHaveLength(1);
    const h = g.planHistory![0];
    expect(h.reason).toBe("想要更实践向");
    expect(h.phaseId).toBe("ph-1");
    expect(h.dayIds).toEqual(["d-old-1", "d-old-2", "d-old-3"]);
    expect(h.days).toHaveLength(3);
    expect(h.days[0].status).toBe("passed");
    /* 深拷贝：改原对象不影响快照 */
    h.days[0].title = "已改";
    expect(g.plan!.days["d-old-1"].title).not.toBe("已改");
  });

  it("只保留最近 5 次，只增不删", () => {
    for (let i = 0; i < 7; i++) useAppStore.getState().snapshotPhase("g-h5-test", "ph-1", `第${i}次`);
    const g = useAppStore.getState().goals.find((x) => x.id === "g-h5-test")!;
    expect(g.planHistory).toHaveLength(5);
    expect(g.planHistory![0].reason).toBe("第2次");
    expect(g.planHistory![4].reason).toBe("第6次");
  });
});

describe("setPhaseCatalog × alignPhaseDayIds（重排后成绩引用保留）", () => {
  it("标题匹配的天沿用旧 id：passed 状态与 quizLog 的 dayId 引用不丢", () => {
    const s = useAppStore.getState();
    s.snapshotPhase("g-h5-test", "ph-1", "换一批角度");
    /* alignPhaseDayIds 的对齐结果由 phase-align.test.ts 单测锁定；
     * 此处用其对齐语义的直接产物（只有 Day 1 标题相同）验证 store 侧行为 */
    const aligned = ["d-old-1", "", ""]; // ["Day 1：变量", "Day 2：新的函数视角", "Day 3：综合实战"] 的对齐结果
    s.setPhaseCatalog("g-h5-test", "ph-1", "", [
      { id: aligned[0], title: "Day 1：变量", knowledgePoints: ["甲"] },
      { id: `day_${Math.random().toString(36).slice(2, 8)}`, title: "Day 2：新的函数视角", knowledgePoints: ["乙"] },
      { id: `day_${Math.random().toString(36).slice(2, 8)}`, title: "Day 3：综合实战", knowledgePoints: ["丙"] },
    ]);
    const g = useAppStore.getState().goals.find((x) => x.id === "g-h5-test")!;
    expect(g.plan!.phases[0].dayIds[0]).toBe("d-old-1");
    expect(g.plan!.days["d-old-1"].status).toBe("passed"); // 完成状态保留
    expect(g.quizLog[0].dayId).toBe("d-old-1"); // quizLog 引用仍指向真实存在的天
    /* stub 天的目录索引跟随新目录更新（setPhaseCatalog 设计行为），状态/引用不动 */
    expect(g.plan!.days["d-old-1"].knowledgePoints[0].text).toBe("甲");
  });

  it("全换角度（无标题命中）时旧天对象保留在 days（绝不删除用户记录）", () => {
    const s = useAppStore.getState();
    const g0 = s.goals.find((x) => x.id === "g-h5-test")!;
    const beforeDays = Object.keys(g0.plan!.days);
    s.setPhaseCatalog("g-h5-test", "ph-1", "", [
      { id: "d-new-1", title: "全新角度 A", knowledgePoints: ["甲"] },
      { id: "d-new-2", title: "全新角度 B", knowledgePoints: ["乙"] },
    ]);
    const g = useAppStore.getState().goals.find((x) => x.id === "g-h5-test")!;
    expect(g.plan!.phases[0].dayIds).toEqual(["d-new-1", "d-new-2"]);
    for (const id of beforeDays) expect(g.plan!.days[id], `旧天 ${id} 不应被删除`).toBeTruthy();
    expect(g.quizLog[0].dayId).toBe("d-old-1");
  });
});

describe("restorePlanVersion（PRD AG-04 / EX-08：恢复只回退该次计划，不覆盖之后成绩/笔记）", () => {
  it("快照旧版→重排→恢复：阶段结构回退，恢复后新增成绩保留，quizLog 引用不丢", () => {
    const s = useAppStore.getState();
    /* 1) 快照旧版 */
    s.snapshotPhase("g-h5-test", "ph-1", "换一批角度");
    const g1 = useAppStore.getState().goals.find((x) => x.id === "g-h5-test")!;
    const histEntryId = g1.planHistory![0].id!;
    /* 2) 重排成全新目录（无标题命中） */
    s.setPhaseCatalog("g-h5-test", "ph-1", "", [
      { id: "d-new-1", title: "全新角度 A", knowledgePoints: ["甲"] },
      { id: "d-new-2", title: "全新角度 B", knowledgePoints: ["乙"] },
    ]);
    /* 3) 之后新增一次成绩（应保留，不能被恢复覆盖） */
    useAppStore.setState((st) => ({
      goals: st.goals.map((gg) => gg.id === "g-h5-test" ? { ...gg, quizLog: [...gg.quizLog, { dayId: "d-new-1", date: new Date().toISOString(), passed: true, forced: false, items: [] }] } : gg),
    }));
    /* 4) 恢复旧版 */
    const ok = useAppStore.getState().restorePlanVersion("g-h5-test", histEntryId);
    expect(ok).toBe(true);
    const g = useAppStore.getState().goals.find((x) => x.id === "g-h5-test")!;
    /* 阶段结构与边界回退到旧目录 */
    expect(g.plan!.phases[0].dayIds).toEqual(["d-old-1", "d-old-2", "d-old-3"]);
    expect(g.plan!.phases[0].catalog!.map((c) => c.title)).toEqual(["Day 1：变量", "Day 2：函数", "Day 3：数组"]);
    /* 之后新增的成绩保留（quizLog 含新旧成绩，未因恢复被清空） */
    expect(g.quizLog.filter((q) => q.dayId === "d-new-1").length).toBeGreaterThanOrEqual(1);
    /* 恢复本身形成一条新历史（可再回退）；原历史仍在 */
    expect(g.planHistory!.length).toBeGreaterThanOrEqual(2);
    expect(g.quizLog[0].dayId).toBe("d-old-1");
  });

  it("恢复到已展开内容不覆盖之后编辑（EX-08 核心：只回退结构）", () => {
    const s = useAppStore.getState();
    s.snapshotPhase("g-h5-test", "ph-1", "初版");
    const entryId = useAppStore.getState().goals.find((x) => x.id === "g-h5-test")!.planHistory![0].id!;
    /* 重排 */
    s.setPhaseCatalog("g-h5-test", "ph-1", "", [
      { id: "d-new-1", title: "全新角度 A", knowledgePoints: ["甲"] },
    ]);
    /* 恢复 */
    useAppStore.getState().restorePlanVersion("g-h5-test", entryId);
    const g = useAppStore.getState().goals.find((x) => x.id === "g-h5-test")!;
    /* 被重排顶掉但之后可能在恢复期间出现的新天：d-old-2/d3 为 stub 占位，未删除 */
    expect(g.plan!.days["d-old-2"]).toBeTruthy();
    expect(g.plan!.days["d-old-3"]).toBeTruthy();
    /* 已完成的 d-old-1 状态仍保留（不因恢复丢失完成证据） */
    expect(g.plan!.days["d-old-1"].status).toBe("passed");
  });
});

/* ===== 2026-11-10 自查修复的回归锁（AG-03 / AG-04 数据不丢） ===== */
describe("自查缺陷回归：updatePhaseMeta 不得清空未传字段", () => {
  it("只改 outcome 时标题与 estDays 保持原值（Object.assign 会写 undefined）", () => {
    useAppStore.setState((st) => ({
      goals: st.goals.map((g) =>
        g.id === "g-h5-test"
          ? { ...g, plan: { ...g.plan!, phases: g.plan!.phases.map((p) => ({ ...p, estDays: 5 })) } }
          : g
      ),
    }));
    useAppStore.getState().updatePhaseMeta("g-h5-test", "ph-1", { outcome: "新目标" });
    const ph = useAppStore.getState().goals.find((g) => g.id === "g-h5-test")!.plan!.phases[0];
    expect(ph.title).toBe("阶段一");   // 未被 undefined 清空
    expect(ph.outcome).toBe("新目标");
    expect(ph.estDays).toBe(5);        // 未被 undefined 清空
  });
});

describe("自查缺陷回归：restorePlanVersion 不得丢掌握证据", () => {
  it("恢复后已展开天的知识点保留 masteryStatus/historicalHighest，且不回退成 stub", () => {
    /* 造一个已展开的天，知识点带掌握证据 */
    useAppStore.setState((st) => ({
      goals: st.goals.map((g) => {
        if (g.id !== "g-h5-test") return g;
        const plan = structuredClone(g.plan!);
        plan.days["d-old-1"] = {
          ...plan.days["d-old-1"],
          stub: false,
          knowledgePoints: [
            { id: "kp-1", text: "甲", masteryStatus: "independent", historicalHighest: "independent", hintLevel: 1 },
          ],
        };
        return { ...g, plan };
      }),
    }));
    useAppStore.getState().snapshotPhase("g-h5-test", "ph-1", "改版前");
    const entryId = useAppStore.getState().goals.find((g) => g.id === "g-h5-test")!.planHistory![0].id!;
    /* 重排后恢复 */
    useAppStore.getState().setPhaseCatalog("g-h5-test", "ph-1", "", [
      { id: "d-new-1", title: "全新角度 A", knowledgePoints: ["乙"] },
    ]);
    expect(useAppStore.getState().restorePlanVersion("g-h5-test", entryId)).toBe(true);
    const day = useAppStore.getState().goals.find((g) => g.id === "g-h5-test")!.plan!.days["d-old-1"];
    const kp = day.knowledgePoints.find((k) => k.text === "甲")!;
    expect(kp.masteryStatus).toBe("independent");        // 掌握状态未丢
    expect(kp.historicalHighest).toBe("independent");    // 历史最高未丢
    expect(kp.id).toBe("kp-1");                       // 沿用原对象，未重新生成
    expect(day.stub).toBe(false);                     // 已展开的天不回退成 stub
  });
});
