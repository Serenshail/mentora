import { beforeEach, describe, expect, it } from "vitest";

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
import type { DayPlan, Goal, NodeStatus } from "../types";

/* ============ 计划类动作改为定点 patch，不再深拷贝整个 plan ============
 * 旧实现 incrementAttempts/setDayDetail/updateDayResources/setPhaseCatalog 对 g.plan
 * 整体 structuredClone——plan.days 缓存着每天的讲义与问答，数月目标可达 MB 级，
 * 每次点击都深拷贝 + GC。现在只重建受影响的字段/天，其余 days 保持引用不变。
 * 本锁用「未受影响天的引用保持不变」证明未发生全量深拷贝，并校验行为不变。 */

const makeDay = (id: string, phaseId: string, status: NodeStatus): DayPlan =>
  ({
    id,
    phaseId,
    title: `Day ${id}`,
    stub: true,
    knowledgePoints: [],
    resources: [],
    method: "",
    acceptance: [],
    status,
    attempts: 0,
  }) as unknown as DayPlan;

function seedGoal(): Goal {
  return {
    id: "g1",
    topic: "T",
    direction: "",
    domainKind: "coding",
    motivation: "",
    background: "",
    weeklyHours: 5,
    successCriteria: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    quizLog: [],
    intakeTranscript: [],
    plan: {
      summary: "s",
      totalDays: 4,
      weeklyHours: 5,
      startDate: "2026-01-01",
      createdAt: "2026-01-01T00:00:00.000Z",
      phases: [
        {
          id: "p1",
          title: "P",
          outcome: "o",
          dayIds: ["d1", "d2", "d3"],
          status: "active",
          catalog: [
            { id: "d1", title: "Day d1", knowledgePoints: [] },
            { id: "d2", title: "Day d2", knowledgePoints: [] },
            { id: "d3", title: "Day d3", knowledgePoints: [] },
          ],
        },
      ],
      days: {
        d1: makeDay("d1", "p1", "active"),
        d2: makeDay("d2", "p1", "locked"),
        d3: makeDay("d3", "p1", "locked"),
        d4: makeDay("d4", "p1", "locked"), // 不在 catalog 里，用于验证未被波及
      },
    },
  };
}

const goals = () => useAppStore.getState().goals;
const p = () => goals()[0].plan!;

beforeEach(() => {
  useAppStore.setState({ goals: [seedGoal()], settings: { ...DEFAULT_SETTINGS } });
});

describe("计划类动作定点 patch（不全量深拷贝 plan）", () => {
  it("incrementAttempts：只重建目标天，其余天引用不变", () => {
    const d2Before = p().days["d2"];
    const d4Before = p().days["d4"];
    useAppStore.getState().incrementAttempts("g1", "d1");
    expect(p().days["d1"].attempts).toBe(1);
    expect(p().days["d2"]).toBe(d2Before);
    expect(p().days["d4"]).toBe(d4Before);
    // 再点一次仍只加 1
    useAppStore.getState().incrementAttempts("g1", "d1");
    expect(p().days["d1"].attempts).toBe(2);
  });

  it("updateDayResources：只替换目标天的 resources", () => {
    const d4Before = p().days["d4"];
    useAppStore.getState().updateDayResources("g1", "d3", [
      { title: "r", url: "https://example.com", why: "" },
    ]);
    expect(p().days["d3"].resources).toHaveLength(1);
    expect(p().days["d4"]).toBe(d4Before);
  });

  it("setDayDetail：回填当天、重算 planned，且不深拷其余天", () => {
    const d1AfterIncrement = (() => {
      useAppStore.getState().incrementAttempts("g1", "d1");
      return p().days["d1"];
    })();
    useAppStore.getState().setDayDetail("g1", "p1", "d2", {
      ...makeDay("d2", "p1", "locked"),
      stub: false,
      title: "Day d2",
    } as DayPlan);
    expect(p().days["d2"].stub).toBe(false);
    expect(p().days["d1"]).toBe(d1AfterIncrement);
    expect(p().phases[0].planned).toBe(false); // d3 仍是 stub
  });

  it("setPhaseCatalog：只动 catalog 相关的天，未涉及的天引用不变", () => {
    const d4Before = p().days["d4"];
    useAppStore.getState().setPhaseCatalog("g1", "p1", "范围与不学说明", [
      { id: "d1", title: "Day d1", knowledgePoints: ["甲"] },
      { id: "d2", title: "Day d2", knowledgePoints: ["乙"] },
      { id: "d3", title: "Day d3", knowledgePoints: ["丙"] },
    ]);
    expect(p().phases[0].boundary).toBe("范围与不学说明");
    expect(p().phases[0].dayIds).toEqual(["d1", "d2", "d3"]);
    expect(p().days["d1"].knowledgePoints.map((k) => k.text)).toEqual(["甲"]);
    expect(p().days["d4"]).toBe(d4Before);
  });
});
