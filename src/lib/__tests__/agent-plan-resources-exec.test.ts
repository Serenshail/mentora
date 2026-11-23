import { beforeEach, describe, expect, it, vi } from "vitest";

/* 回归锁：update_plan_resources 执行期不得把「服务端故障」吞成「没找到合格视频」，
 * 也不得静默只处理前 5 天却报告整阶段已换。
 *  - 旧实现：fetch('/api/search') 后只 res.json()，从不查 res.ok/j.error → 5xx/限流
 *    被当成空结果，最终文案让用户「换关键词再试」，而事实是服务不可用；
 *  - 旧实现：for (dayId of executableDayIds.slice(0,5))，成功文案的 Y 也是截断后的数量，
 *    第 6 天及以后仍是旧资源却报「已为 X 天换上」。 */

vi.mock("@/lib/ai/client", () => ({
  streamChat: vi.fn(async () => "{}"),
  extractJson: () => ({}),
  readingPlanSchema: { parse: (x: unknown) => x },
  personaDistillSchema: { parse: (x: unknown) => x },
  phaseListSchema: {},
}));
vi.mock("@/lib/track", () => ({ track: () => {} }));
vi.mock("@/lib/book-verify", () => ({ verifyBook: vi.fn(async () => null) }));
vi.mock("@/lib/rag", () => ({ buildContext: () => "", wikiRetrieve: () => [] }));
vi.mock("@/lib/utils", () => ({ uid: (p: string) => `${p}_t`, todayISO: () => "2026-11-23" }));
/* 真实 validateResources 依赖 classifyResource；这里让所有结果都判定为「合规视频」，
 * 这样「替换成功/失败」只取决于 fetch 的响应，与本次要锁的行为解耦。 */
vi.mock("@/lib/resources", () => ({
  parseResourceConstraint: () => ({ resourceType: "video", language: "zh", region: "mainland", excluded: [] }),
  classifyResource: () => ({ resType: "video", access: "verified" }),
  validateResources: (list: { title: string; url: string }[]) => ({
    verdicts: list.map((r) => ({ ...r, resType: "video", access: "verified", violations: [] })),
  }),
}));

const updatedDays: string[] = [];
function makePlan(n: number) {
  const days: Record<string, unknown> = {};
  const dayIds: string[] = [];
  for (let i = 1; i <= n; i++) {
    days[`d${i}`] = {
      id: `d${i}`, phaseId: "p1", title: `第${i}天`, knowledgePoints: [], resources: [],
      method: "", acceptance: [], status: "locked", attempts: 0,
    };
    dayIds.push(`d${i}`);
  }
  return {
    summary: "s", totalDays: n, weeklyHours: 3, startDate: "2026-11-01", createdAt: "2026-11-01",
    phases: [{ id: "p1", title: "第一阶段", outcome: "", dayIds, status: "active" }],
    days,
  };
}

const mutable = {
  goals: [] as unknown[],
  knowledge: [] as unknown[],
  books: [] as unknown[],
  sessions: [] as unknown[],
  settings: {},
};
vi.mock("@/lib/store", () => ({
  useAppStore: {
    getState: () => ({
      ...mutable,
      updateDayResources: (_g: string, dayId: string) => updatedDays.push(dayId),
    }),
    setState: () => {},
    subscribe: () => () => {},
  },
}));

import { executeAction } from "../agent/tool-executors";
import type { PendingAction } from "../agent/protocol";

function action(n: number, id = `pa_${n}`): PendingAction {
  const plan = makePlan(n);
  return {
    id,
    kind: "update_plan_resources",
    label: "重出阶段视频资源",
    summary: "s",
    payload: {
      goalId: "g1",
      phaseId: "p1",
      phaseTitle: "第一阶段",
      topic: "Python",
      constraintText: "只要B站视频",
      dayIds: (plan.phases[0] as { dayIds: string[] }).dayIds,
    },
  };
}

beforeEach(() => {
  updatedDays.length = 0;
  mutable.goals = [{ id: "g1", topic: "Python", status: "active", createdAt: "2026-11-01", plan: makePlan(8), quizLog: [], successCriteria: [] }];
  mutable.knowledge = [];
  mutable.books = [];
  mutable.sessions = [];
  mutable.settings = {};
});

describe("update_plan_resources 执行期：错误态不得伪装成空态", () => {
  it("/api/search 返回 5xx → 结论是「检索失败」而不是「没找到合格视频」", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })
    );
    const r = await executeAction(action(3, "pa_err"));
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("检索失败");
    expect(r.content).toContain("检索");
    expect(r.content).not.toContain("不会用文档凑数");
  });

  it("服务端 200 但没有 results → 仍是「没找到合格视频」（真实空态）", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 })
    );
    const r = await executeAction(action(3, "pa_empty"));
    expect(r.ok).toBe(false);
    expect(r.content).toContain("没有找到合格的中文视频资源");
  });
});

describe("update_plan_resources 执行期：不静默截断", () => {
  it("8 天的阶段全部处理（不再只处理前 5 天）", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ title: "B站教程", url: "https://www.bilibili.com/video/BV1xx", snippet: "s" }] }), { status: 200 })
    );
    const r = await executeAction(action(8));
    expect(r.ok).toBe(true);
    /* 8 天都在目标范围内且都成功写入 */
    expect(updatedDays.sort()).toEqual(["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"]);
    expect(r.content).toContain("8/8 天");
  });
});
