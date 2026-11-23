import { beforeEach, describe, expect, it, vi } from "vitest";

/* 回归锁：AG-01 消歧纪律必须覆盖笔记与阶段定位。
 * 背景：findNote / regenerate_phase / update_plan_resources 此前都用
 * `find(x => x.title.includes(q))` 贪心取第一个命中——库里有《Python》和《Python 进阶》
 * 时 delete_note 可能删错、get_note 把错误正文直接喂给模型；阶段同理会改错阶段。
 * 目标/书/会话早已用 resolveGoal/resolveBook/resolveSession 做精确→唯一→歧义，
 * 这里把笔记与阶段补齐到同一口径。 */

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
vi.mock("@/lib/utils", () => ({
  uid: (p: string) => `${p}_test`,
  todayISO: () => "2026-11-23",
}));
vi.mock("@/lib/resources", () => ({
  parseResourceConstraint: () => ({ resourceType: "video" }),
  classifyResource: () => ({}),
  validateResources: () => ({ verdicts: [] }),
}));

const removed: string[] = [];
const mutable = {
  knowledge: [] as { id: string; title: string; body: string; domain: string; links: string[] }[],
  goals: [] as unknown[],
  books: [] as unknown[],
  sessions: [] as unknown[],
  settings: {},
};
vi.mock("@/lib/store", () => ({
  useAppStore: {
    getState: () => ({
      ...mutable,
      removeKnowledge: (id: string) => removed.push(id),
      updateKnowledge: () => {},
      enableReview: () => {},
      recordReview: () => {},
      linkNotes: () => {},
    }),
    setState: () => {},
    subscribe: () => () => {},
  },
}));

import { executeTool } from "../agent/tool-executors";

const note = (id: string, title: string) => ({
  id,
  title,
  body: `${title} 的正文`,
  domain: "笔记",
  links: [] as string[],
});

function goalWithPhases() {
  return {
    id: "g1",
    topic: "Python",
    direction: "数据分析",
    status: "active",
    createdAt: "2026-11-01",
    plan: {
      summary: "从基础到文件",
      totalDays: 4,
      weeklyHours: 3,
      startDate: "2026-11-01",
      createdAt: "2026-11-01",
      phases: [
        { id: "p1", title: "第一阶段 语法", outcome: "", dayIds: ["d1"], status: "active" },
        { id: "p2", title: "第二阶段 基础", outcome: "", dayIds: ["d2"], status: "locked" },
        { id: "p3", title: "第二阶段 进阶", outcome: "", dayIds: ["d3"], status: "locked" },
      ],
      days: {
        d1: { id: "d1", phaseId: "p1", title: "变量", knowledgePoints: [], resources: [], method: "", acceptance: [], status: "passed", attempts: 0 },
        d2: { id: "d2", phaseId: "p2", title: "函数", knowledgePoints: [], resources: [], method: "", acceptance: [], status: "locked", attempts: 0 },
        d3: { id: "d3", phaseId: "p3", title: "模块", knowledgePoints: [], resources: [], method: "", acceptance: [], status: "locked", attempts: 0 },
      },
    },
    quizLog: [],
    successCriteria: [],
  };
}

beforeEach(() => {
  removed.length = 0;
  mutable.knowledge = [note("k1", "Python"), note("k2", "Python 进阶")];
  mutable.goals = [goalWithPhases()];
  mutable.books = [];
  mutable.sessions = [];
  mutable.settings = {};
});

describe("笔记定位 AG-01：同/近名不得贪心取值", () => {
  it("get_note 遇到近名笔记 → 返回候选而不是第一篇正文", async () => {
    const out = await executeTool("get_note", { title: "Python" });
    /* 精确同名《Python》唯一命中，仍是 exact——这里验证不会误取《Python 进阶》 */
    expect(out.result.content).toContain("《Python》");
    expect(out.result.content).not.toContain("Python 进阶 的正文");
  });

  it("delete_note 简称命中两篇 → 需消歧，不产生删除动作", async () => {
    mutable.knowledge = [note("k1", "Python 入门"), note("k2", "Python 进阶")];
    const out = await executeTool("delete_note", { title: "Python" });
    expect(out.action).toBeUndefined();
    expect(out.result.content).toContain("相近笔记");
  });

  it("link_notes 任一侧歧义 → 整体拒绝并列候选", async () => {
    mutable.knowledge = [note("k1", "Python 入门"), note("k2", "Python 进阶"), note("k3", "社会认同")];
    const out = await executeTool("link_notes", { from: "Python", to: "社会认同" });
    expect(out.action).toBeUndefined();
    expect(out.result.content).toContain("相近笔记");
  });

  it("update_note 改成已存在的标题 → 拒绝（不制造重复标题）", async () => {
    const out = await executeTool("update_note", { id: "k1", newTitle: "Python 进阶" });
    expect(out.action).toBeUndefined();
    expect(out.result.content).toContain("同名");
  });
});

describe("阶段定位 AG-01：近名阶段不得贪心取值", () => {
  it("regenerate_phase 阶段名命中两个 → 需消歧", async () => {
    const out = await executeTool("regenerate_phase", { topic: "Python", phaseTitle: "第二阶段" });
    expect(out.action).toBeUndefined();
    expect(out.result.content).toContain("相近阶段");
  });

  it("regenerate_phase 精确阶段名 → 绑定到该阶段", async () => {
    const out = await executeTool("regenerate_phase", { topic: "Python", phaseTitle: "第二阶段 进阶" });
    expect(out.action?.payload.phaseId).toBe("p3");
  });

  it("update_plan_resources 阶段名命中两个 → 需消歧", async () => {
    const out = await executeTool("update_plan_resources", {
      topic: "Python",
      phaseTitle: "第二阶段",
      constraintText: "只要B站视频",
    });
    expect(out.action).toBeUndefined();
    expect(out.result.content).toContain("相近阶段");
  });
});
