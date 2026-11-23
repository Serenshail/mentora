import { beforeEach, describe, expect, it } from "vitest";

/* Node 环境没有 localStorage：zustand persist 的 setItem 会炸。给个最小内存实现。 */
if (typeof globalThis.localStorage === "undefined") {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => void mem.clear(),
      key: (i: number) => Array.from(mem.keys())[i] ?? null,
      get length() {
        return mem.size;
      },
    },
    configurable: true,
  });
}

import { DEFAULT_SETTINGS, useAppStore } from "../store";
import { planProgress } from "../plan-progress";

/* ============ plan 深层结构校验回归锁 ============
 * sanitizeBackup 曾只对 goal.plan 做 isRecord 浅校验：`plan:{"phases":"oops"}` 这种
 * 「是对象、但深层结构坏」的备份（设置页导入 / 云端恢复两条路都走 importData）
 * 会通过校验落库，随后任何交互都在这里当场 TypeError——
 *   store.unlockNext            → goal.plan.phases.find（store.ts:255）
 *   store.setPhaseCatalog       → structuredClone(g.plan) 后 plan.phases.find（store.ts:659-660）
 *   learn/[id] 计划时间线       → plan.phases.map（learn/[id]/page.tsx:1170）
 *   learn 列表卡                → Object.values(goal.plan.days)（learn/page.tsx:19）
 * 正是 importData 注释（store.ts:500-503）点名要消灭的「坏数据崩死全应用」类。 */

const importData = (data: unknown) => useAppStore.getState().importData(data);

function goalWithPlan(plan: unknown) {
  return {
    id: "g-plan",
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
    plan,
  };
}

beforeEach(() => {
  useAppStore.setState({
    goals: [],
    knowledge: [],
    books: [],
    sessions: [],
    customPersonas: [],
    folders: [],
    settings: { ...DEFAULT_SETTINGS },
  });
});

describe("importData 对 plan 的深层结构校验", () => {
  it("phases 不是数组：半截 plan 不落库（目标保留），后续阶段操作不再抛", () => {
    expect(importData({ goals: [goalWithPlan({ phases: "oops", days: {} })] })).toBe(true);
    const g = useAppStore.getState().goals[0];
    expect(g.topic).toBe("Python");
    expect(g.plan).toBeUndefined();
    /* 旧行为：plan 落库后这里 structuredClone + plan.phases.find 抛 TypeError */
    expect(() =>
      useAppStore
        .getState()
        .setPhaseCatalog(g.id, "p1", "", [{ id: "d1", title: "Day 1", knowledgePoints: ["a"] }])
    ).not.toThrow();
  });

  it("days 不是对象表：同样不落库，setDayStatus/unlockNext 路径不再抛", () => {
    expect(importData({ goals: [goalWithPlan({ phases: [], days: "oops" })] })).toBe(true);
    const g = useAppStore.getState().goals[0];
    expect(g.plan).toBeUndefined();
    expect(() => useAppStore.getState().setDayStatus(g.id, "d1", "passed")).not.toThrow();
    expect(planProgress(g.plan)).toBe(0);
  });

  it("phases/days 形状对但天缺 map 字段：归一成空数组，验收与资源渲染不再抛", () => {
    expect(
      importData({
        goals: [
          goalWithPlan({
            summary: "s",
            phases: [
              { id: "p1", title: "阶段1", outcome: "o", dayIds: ["d1"], status: "active" },
            ],
            days: { d1: { id: "d1", phaseId: "p1", title: "Day 1", status: "active" } },
          }),
        ],
      })
    ).toBe(true);
    const day = useAppStore.getState().goals[0].plan!.days["d1"];
    expect(day.knowledgePoints).toEqual([]);
    expect(day.resources).toEqual([]);
    expect(day.acceptance).toEqual([]);
    expect(day.method).toBe("");
    /* 旧行为：day.knowledgePoints 为 undefined 时 learn 页 1350/1719/1867 的 .map 抛 */
    expect(() => day.knowledgePoints.map((k) => k.text)).not.toThrow();
  });

  it("坏阶段元素被过滤，合法阶段与天完整保留（不误伤正常备份）", () => {
    expect(
      importData({
        goals: [
          goalWithPlan({
            summary: "整段路径",
            totalDays: 2,
            weeklyHours: 8,
            startDate: "2026-11-11",
            createdAt: "2026-11-10T00:00:00.000Z",
            phases: [
              "oops",
              { id: "p1", title: "阶段1", outcome: "能跑通", dayIds: ["d1"], status: "active" },
            ],
            days: {
              d1: {
                id: "d1",
                phaseId: "p1",
                title: "Day 1：变量",
                knowledgePoints: [{ id: "kp1", text: "变量" }],
                resources: [{ title: "官方文档", url: "https://example.com/doc", why: "最权威" }],
                method: "先读再写",
                acceptance: [{ id: "a1", kind: "explain", question: "什么是变量" }],
                status: "active",
                attempts: 0,
              },
            },
          }),
        ],
      })
    ).toBe(true);
    const plan = useAppStore.getState().goals[0].plan!;
    expect(plan.summary).toBe("整段路径");
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0].id).toBe("p1");
    expect(plan.phases[0].dayIds).toEqual(["d1"]);
    expect(plan.days["d1"].title).toBe("Day 1：变量");
    expect(plan.days["d1"].knowledgePoints[0].text).toBe("变量");
    expect(plan.days["d1"].acceptance[0].question).toBe("什么是变量");
    expect(planProgress(plan)).toBe(0);
  });

  it("云端恢复同一条路径：坏 plan 不写入，整体快照的其余字段照常生效", () => {
    expect(
      importData({
        goals: [goalWithPlan({ phases: { bad: true } })],
        knowledge: [{ id: "k1", title: "笔记", body: "正文" }],
      })
    ).toBe(true);
    expect(useAppStore.getState().goals[0].plan).toBeUndefined();
    expect(useAppStore.getState().knowledge[0].title).toBe("笔记");
  });

  it("phase.dayIds 不是数组：归一成空表，时间线 phase.dayIds.map 不再抛", () => {
    expect(
      importData({
        goals: [
          goalWithPlan({
            summary: "s",
            phases: [{ id: "p1", title: "阶段1", outcome: "o", dayIds: "d1,d2", status: "active" }],
            days: {},
          }),
        ],
      })
    ).toBe(true);
    const phase = useAppStore.getState().goals[0].plan!.phases[0];
    expect(phase.dayIds).toEqual([]);
    /* 旧行为：learn/[id]/page.tsx:1175 `phase.dayIds.map` 抛 TypeError */
    expect(() => phase.dayIds.map((id) => id)).not.toThrow();
  });

  it("planHistory 坏条目被归一/丢弃，历史版本面板与恢复入口不再抛", () => {
    expect(
      importData({
        goals: [
          {
            ...goalWithPlan({
              summary: "s",
              phases: [{ id: "p1", title: "阶段1", outcome: "o", dayIds: [], status: "active" }],
              days: {},
            }),
            planHistory: [
              "oops",
              { phaseId: "p1", at: 123, dayIds: "d1", days: [{ id: "d-old", title: "旧天" }] },
            ],
          },
        ],
      })
    ).toBe(true);
    const hist = useAppStore.getState().goals[0].planHistory!;
    expect(hist).toHaveLength(1);
    expect(hist[0].at).toBe("");
    expect(hist[0].dayIds).toEqual([]);
    expect(hist[0].days[0].title).toBe("旧天");
    expect(hist[0].days[0].knowledgePoints).toEqual([]);
    /* 旧行为：learn/[id]/page.tsx:1240 `h.at.slice` / `h.days.map(d => d.title)` 抛 */
    expect(() => hist[0].at.slice(0, 10)).not.toThrow();
    expect(() => hist[0].days.map((d) => d.title)).not.toThrow();
  });
});
