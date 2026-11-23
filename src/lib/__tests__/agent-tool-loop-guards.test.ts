import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";

/* ============ 工具循环守卫的三条行为级回归锁 ============
 *  1. 打转守卫：只有**本轮全部**调用都与上一轮重复才强制收尾；批内混有全新调用时
 *     必须执行它们（旧实现 sigs.some(...) 会把合法新检索整批丢弃）。
 *  2. 进展守卫：A01 单阶段改名这类**直接执行**的写入（不产生 PendingAction）也算进展，
 *     连续两轮小改名不得触发「连续 2 轮没有获得新信息」强制收尾。
 *  3. 轮次级私语过滤：带工具调用的轮次里，正文合法提到「调用工具」等词时整段仍要入列
 *     （旧实现用轮次级粗正则命中即整轮丢弃，违反「最终消息与流式内容相符」）。
 */

class FakeStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
const fake = new FakeStorage();
(globalThis as unknown as { window: unknown }).window = { localStorage: fake };
afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

const streamChatStub = vi.fn();
vi.mock("@/lib/ai/client", () => ({
  streamChat: (...args: unknown[]) => streamChatStub(...args),
}));
const executeToolStub = vi.fn();
const executeActionStub = vi.fn();
vi.mock("@/lib/agent/tool-executors", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    executeTool: (...a: unknown[]) => executeToolStub(...a),
    executeAction: (...a: unknown[]) => executeActionStub(...a),
  };
});

import { runAgent } from "../agent/runner";

beforeEach(() => {
  fake.clear();
  streamChatStub.mockReset();
  executeToolStub.mockReset();
  executeActionStub.mockReset();
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => new Response("{}", { status: 200 }));
});

function cb() {
  return {
    onPhase: () => {},
    onPlan: () => {},
    onTool: () => {},
    onReasoning: () => {},
    onDelta: () => {},
    requestApproval: async () => [],
  };
}

function run(question: string) {
  return runAgent({
    question,
    context: "{}",
    history: [{ role: "user", content: question }],
    deep: false,
    signal: new AbortController().signal,
    cb: cb(),
  });
}

const toolBlock = (name: string, args: Record<string, unknown>) =>
  "```tool\n" + JSON.stringify({ name, args }) + "\n```";

describe("打转守卫：只有整批重复才收尾", () => {
  it("上一轮 get_goal(X) + 本轮 get_goal(X) 与新 web_search → 新检索必须执行", async () => {
    executeToolStub.mockResolvedValue({ result: { ok: true, content: "结果", summary: "ok" } });
    let round = 0;
    streamChatStub.mockImplementation(async () => {
      const n = round++;
      if (n === 0) return toolBlock("get_goal", { id: "g1" });
      if (n === 1) return toolBlock("get_goal", { id: "g1" }) + toolBlock("web_search", { query: "Next.js 15 新特性" });
      return "最终回答。";
    });
    await run("查一下计划再搜点资料");
    const called = executeToolStub.mock.calls.map((c) => (c as unknown[])[0]);
    /* 第 2 轮里的全新 web_search 必须真的执行——旧实现遇到重复签名就整批跳过，
     * 这个新检索会被静默丢弃（get_goal 的重复由 progress-guard 的读缓存复用兜住，
     * 所以它不会二次执行，这是预期行为）。 */
    expect(called.filter((n) => n === "web_search")).toHaveLength(1);
  });

  it("整批都与上一轮相同 → 仍强制收尾（不走工具执行）", async () => {
    executeToolStub.mockResolvedValue({ result: { ok: true, content: "结果", summary: "ok" } });
    let round = 0;
    streamChatStub.mockImplementation(async () => {
      const n = round++;
      if (n === 0) return toolBlock("get_goal", { id: "g1" });
      if (n === 1) return toolBlock("get_goal", { id: "g1" });
      return "收尾回答。";
    });
    const r = await run("看看计划");
    expect(r.answer).toContain("收尾回答");
    /* 第 2 轮的重复调用不执行（只有第 1 轮那一次） */
    expect(executeToolStub.mock.calls.filter((c) => (c as unknown[])[0] === "get_goal")).toHaveLength(1);
  });
});

describe("进展守卫：直接执行的写入也算进展", () => {
  it("连续两轮 A01 单阶段改名（无 PendingAction）不触发停滞收尾", async () => {
    /* edit_phase 只改 title 时 validateWriteTool 直接执行并返回 ok:true、无 action */
    executeToolStub.mockResolvedValue({ result: { ok: true, content: "阶段标题已更新", summary: "已更新" } });
    let round = 0;
    const stallPrompt = vi.fn();
    streamChatStub.mockImplementation(async (opts: { messages: { role: string; content: unknown }[] }) => {
      const last = opts.messages[opts.messages.length - 1];
      if (typeof last?.content === "string" && last.content.includes("连续") && last.content.includes("没有获得新信息")) {
        stallPrompt();
      }
      const n = round++;
      if (n === 0) return toolBlock("edit_phase", { topic: "Python", changes: { phaseMeta: { p1: { title: "语法基础" } } } });
      if (n === 1) return toolBlock("edit_phase", { topic: "Python", changes: { phaseMeta: { p1: { title: "语法与类型" } } } });
      return "两处标题都改好了。";
    });
    const r = await run("把第二阶段标题改成语法基础");
    expect(stallPrompt).not.toHaveBeenCalled();
    expect(r.answer).toContain("两处标题都改好了");
  });
});

describe("轮次级私语过滤：合法讲解段不因出现元话语词被整段丢弃", () => {
  it("带工具调用的轮次里，含「调用工具函数」的教学段整段保留（句子级负向断言生效）", async () => {
    executeToolStub.mockResolvedValue({ result: { ok: true, content: "笔记内容", summary: "ok" } });
    /* 「调用工具函数」在句子级判据里有负向断言（META_ZH_WORDS 的 调用工具(?!函数)），
     * 明确属于教学内容；但旧实现的轮次级粗正则 `调用工具` 无此保护，命中就把**整轮**排除，
     * 这段在流式里看得到、落库的最终消息却没了。 */
    const teaching = "写解析器时，你可以调用工具函数 parseLine 把这一行拆成字段，这是最省事的做法。";
    let round = 0;
    streamChatStub.mockImplementation(async () => {
      const n = round++;
      if (n === 0) return teaching + "\n" + toolBlock("search_brain", { query: "解析器" });
      return "补充回答。";
    });
    const r = await run("讲讲怎么解析这一行");
    expect(r.answer).toContain("调用工具函数 parseLine");
    expect(r.answer).toContain("补充回答");
  });
});
