import { beforeEach, describe, expect, it, vi } from "vitest";

/* 回归锁：manage_workspace / manage_goal 的「意图段」埋点不能缺失。
 * 背景：executeTool 里这两个复合工具在 track("agent_tool_intent") 之前就 early-return，
 * 它们（workspace 还带 writeActions create/update/delete）从不产生该事件，
 * 依赖这个漏斗的转化分析会系统性漏掉两类高频复合操作。 */

const tracked: { event: string; props: Record<string, unknown> }[] = [];
vi.mock("@/lib/track", () => ({
  track: (event: string, props: Record<string, unknown>) => tracked.push({ event, props }),
}));
vi.mock("@/lib/ai/client", () => ({
  streamChat: vi.fn(async () => "{}"),
  extractJson: () => ({}),
  readingPlanSchema: { parse: (x: unknown) => x },
  personaDistillSchema: { parse: (x: unknown) => x },
  phaseListSchema: {},
}));
vi.mock("@/lib/book-verify", () => ({ verifyBook: vi.fn(async () => null) }));
vi.mock("@/lib/rag", () => ({ buildContext: () => "", wikiRetrieve: () => [] }));
vi.mock("@/lib/utils", () => ({ uid: (p: string) => `${p}_t`, todayISO: () => "2026-11-23" }));
vi.mock("@/lib/resources", () => ({
  parseResourceConstraint: () => ({ resourceType: "video" }),
  classifyResource: () => ({}),
  validateResources: () => ({ verdicts: [] }),
}));

const mutable = { knowledge: [], goals: [], books: [], sessions: [], settings: {} };
vi.mock("@/lib/store", () => ({
  useAppStore: {
    getState: () => ({
      ...mutable,
      createKnowledge: () => "k_new",
      updateKnowledge: () => {},
      removeKnowledge: () => {},
      updateGoal: () => {},
      removeGoalAndNotes: () => {},
    }),
    setState: () => {},
    subscribe: () => () => {},
  },
}));

import { executeTool } from "../agent/tool-executors";

beforeEach(() => {
  tracked.length = 0;
});

describe("agent_tool_intent 覆盖复合工具", () => {
  it("manage_workspace 的调用产生意图事件（list 读动作 write=0）", async () => {
    await executeTool("manage_workspace", { action: "list" });
    const ev = tracked.find((t) => t.event === "agent_tool_intent" && t.props.tool === "manage_workspace");
    expect(ev).toBeTruthy();
    expect(ev!.props.write).toBe(0);
  });

  it("manage_workspace 的写动作（create）标 write=1", async () => {
    await executeTool("manage_workspace", { action: "create", title: "我的页面", blocks: [] });
    const ev = tracked.find((t) => t.event === "agent_tool_intent" && t.props.tool === "manage_workspace");
    expect(ev!.props.write).toBe(1);
  });

  it("manage_goal 的调用产生意图事件（risk=write → write=1）", async () => {
    await executeTool("manage_goal", { action: "update", id: "g_missing" });
    const ev = tracked.find((t) => t.event === "agent_tool_intent" && t.props.tool === "manage_goal");
    expect(ev).toBeTruthy();
    expect(ev!.props.write).toBe(1);
  });
});
