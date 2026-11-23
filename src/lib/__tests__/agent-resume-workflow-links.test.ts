import { describe, expect, it, vi } from "vitest";

/* 回归锁：resume_workflow 的接续入口必须是可点击的 Markdown 链接。
 * 同为「交接跳转」交互，create_goal 成功后给的是 [继续引导对话](/learn/new?goal=…)（可点），
 * 而 resume_workflow 三个分支此前只给裸路径文本（/read/xxx、/council?session=…），
 * 在聊天区 Markdown 里不是链接——同类动作一个一键可达，一个要用户自己在导航里寻路。
 * 与 reading-notes-tools.test.ts 同款：tool-executors 引用带 @/ 别名的模块，用工厂 mock 拦截。 */

vi.mock("@/lib/ai/client", () => ({
  streamChat: vi.fn(async () => ""),
  extractJson: () => { throw new Error("no json"); },
  readingPlanSchema: { parse: (x: unknown) => x },
  phaseListSchema: {},
}));

const state = {
  goals: [{ id: "g1", topic: "线性代数", direction: "入门", status: "active", plan: { days: {} } }] as unknown[],
  books: [
    {
      id: "b1",
      title: "影响力",
      status: "reading",
      chapters: [{ id: "c1", title: "第一章", status: "done", focusQuestion: "为什么互惠有效？" }],
    },
  ] as unknown[],
  sessions: [
    { id: "s1", title: "辞职创业", personaId: "naval", createdAt: "2026-11-01", messages: [{ role: "user", content: "hi" }] },
  ] as unknown[],
  knowledge: [] as unknown[],
};
let goals: unknown[] = state.goals;

vi.mock("@/lib/store", () => ({
  useAppStore: {
    getState: () => ({ ...state, goals }),
    setState: () => {},
    subscribe: () => () => {},
  },
}));
vi.mock("@/lib/book-verify", () => ({ verifyBook: vi.fn(async () => null) }));
vi.mock("@/lib/rag", () => ({ buildContext: () => "", wikiRetrieve: () => [] }));
vi.mock("@/lib/track", () => ({ track: () => {} }));
vi.mock("@/lib/utils", () => ({ uid: (p: string) => `${p}_test`, todayISO: () => "2026-11-11" }));
vi.mock("@/lib/resources", () => ({
  parseResourceConstraint: () => ({ resourceType: "video" }),
  classifyResource: () => ({}),
  validateResources: () => ({ verdicts: [] }),
}));

import { executeTool } from "../agent/tool-executors";

describe("resume_workflow 接续入口是 Markdown 链接", () => {
  it("学习目标：有 plan → [继续学习](/learn/<id>)；draft → [继续引导对话](/learn/new?goal=)", async () => {
    const active = await executeTool("resume_workflow", { kind: "learning" });
    expect(active.result.content).toContain("[继续学习](/learn/g1)");

    goals = [{ id: "g1", topic: "线性代数", direction: "入门", status: "draft", plan: { days: {} } }];
    const draft = await executeTool("resume_workflow", { kind: "learning" });
    expect(draft.result.content).toContain("[继续引导对话](/learn/new?goal=g1)");
    goals = state.goals;
  });

  it("读书：给出 [继续阅读](/read/<id>) 而不是裸路径", async () => {
    const out = await executeTool("resume_workflow", { kind: "reading" });
    expect(out.result.content).toContain("[继续阅读](/read/b1)");
    expect(out.result.content).not.toContain("接续入口：/read/b1");
  });

  it("人生伙伴：给出 [进入这场讨论](/council?session=<id>)", async () => {
    const out = await executeTool("resume_workflow", { kind: "council" });
    expect(out.result.content).toContain("[进入这场讨论](/council?session=s1)");
  });
});
