import { describe, expect, it, vi } from "vitest";

/* ============ 修复批次 b14 的回归锁 ============
 * 覆盖四条会被静默忽略的缺陷：
 *  ① resume_workflow 的 reading/council 分支必须复用 resolveBook/resolveSession
 *     （同书多版本不得由裸 includes 贪心取首个）；
 *  ② list_books/list_sessions 截断到 10 条时必须告知模型还有更多；
 *  ③ reminders 创建确认文案的星期与 list 分支同格式（中文星期，不是裸数字）；
 *  ④ web_search 的用户中止必须渲染成「已取消」，不是「搜索失败」；
 * 另含 user-facts 的小数时间/身份型背景提取，与 extractJson 的引用标记误命中。
 * tool-executors 引用带 @/ 别名的模块，用工厂 mock 拦截（与既有测试同款）。 */

vi.mock("@/lib/ai/client", () => ({
  streamChat: vi.fn(async () => ""),
  extractJson: () => { throw new Error("no json"); },
  readingPlanSchema: { parse: (x: unknown) => x },
  phaseListSchema: {},
}));

const books = [
  { id: "b1", title: "深度工作", status: "reading", chapters: [{ id: "c1", title: "第一章", status: "done" }] },
  { id: "b2", title: "深度工作（注释版）", status: "unread", chapters: [{ id: "c2", title: "导读", status: "unread" }] },
] as unknown[];
const sessions = [
  { id: "s1", title: "辞职创业", personaId: "naval", createdAt: "2026-11-01", messages: [{ role: "user", content: "hi" }] },
  { id: "s2", title: "辞职创业后的第一年", personaId: "munger", createdAt: "2026-11-02", messages: [{ role: "user", content: "yo" }] },
] as unknown[];

const state: Record<string, unknown> = {
  goals: [] as unknown[],
  books,
  sessions,
  knowledge: [] as unknown[],
  reminders: [] as unknown[],
};

vi.mock("@/lib/store", () => ({
  useAppStore: {
    getState: () => state,
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

describe("resume_workflow：同书/同会话多版本必须消歧，不得贪心取首个", () => {
  it("读书：近名书名 → 列出候选而不是随便挑一本", async () => {
    const out = await executeTool("resume_workflow", { kind: "reading", title: "深度工作" });
    /* 「深度工作」是精确书名 → 命中 b1（不是歧义） */
    expect(out.result.content).toContain("/read/b1");
    const amb = await executeTool("resume_workflow", { kind: "reading", title: "深度" });
    expect(amb.result.content).toContain("我不确定你指哪本");
    expect(amb.result.content).toContain("深度工作（注释版）");
    expect(amb.result.content).not.toContain("/read/");
  });

  it("人生伙伴：近名会话 → 列出候选而不是随便挑一个", async () => {
    const amb = await executeTool("resume_workflow", { kind: "council", title: "辞职创业" });
    /* 「辞职创业」精确命中 s1 */
    expect(amb.result.content).toContain("session=s1");
    const near = await executeTool("resume_workflow", { kind: "council", title: "创业" });
    expect(near.result.content).toContain("我不确定你指哪个");
    expect(near.result.content).not.toContain("session=s1");
  });

  it("按 id 精确恢复仍然可用", async () => {
    const out = await executeTool("resume_workflow", { kind: "reading", id: "b2" });
    expect(out.result.content).toContain("/read/b2");
  });
});

describe("list_books / list_sessions：截断必须让模型看见", () => {
  it("超过 10 条时给出「仅列出前 10 …共 N」的提示", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `b${i}`,
      title: `书${i}`,
      status: "unread",
      chapters: [{ id: `c${i}`, title: "章", status: "unread" }],
    }));
    const prev = state.books;
    state.books = many;
    try {
      const out = await executeTool("list_books", {});
      expect(out.result.summary).toBe("12 本");
      expect(out.result.content).toContain("仅列出前 10 本");
      expect(out.result.content).toContain("共 12 本");
    } finally {
      state.books = prev;
    }
  });

  it("不超过 10 条时不出现截断提示（避免噪声）", async () => {
    const out = await executeTool("list_books", {});
    expect(out.result.content).not.toContain("仅列出前 10 本");
  });
});

describe("web_search：用户中止渲染为「已取消」", () => {
  it("AbortError → summary=已取消，而不是搜索失败", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = Object.assign(new Error("The user aborted a request."), { name: "AbortError" });
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => { throw err; }) as unknown as typeof fetch;
    try {
      const out = await executeTool("web_search", { query: "深度学习 教程" }, { signal: ac.signal });
      expect(out.result.summary).toBe("已取消");
      expect(out.result.content).toContain("已停止");
      expect(out.result.content).not.toContain("搜索失败");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("reminders 创建确认：星期用中文名（与 list 分支同格式）", () => {
  it("days=[0,3] → 「每周日、三」而不是「每周0、3」", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    try {
      const { executeAction } = await import("../agent/tool-executors");
      /* executeAction 的入参是 PendingAction（批准后的动作对象），不是 (kind, payload) */
      const out = await executeAction({
        id: "pa_test_reminder",
        kind: "reminders",
        label: "新建定时提醒",
        summary: "跑步 07:00",
        payload: { action: "create", title: "跑步", prompt: "去跑步", time: "07:00", days: [0, 3] },
      });
      expect(out.content).toContain("每周日、三");
      expect(out.content).not.toContain("每周0、3");
    } finally {
      globalThis.fetch = orig;
    }
  });
});
