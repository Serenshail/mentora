import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";

/* ============ 独立复核 2026-11-12 的 R1–R3 回归锁 ============
 * 三个缺陷都是「默认放行」型的边界漏洞，因此这里的断言全部是**行为级**：
 * 真的跑一遍代码路径，数实际写入次数 / 读实际存储键，而不是扫源码正则。
 *
 *  R1 审批执行边界默认放行：`if (!d || d.approved)` 把「没有决定」当批准。
 *  R2 首次身份登记不设作用域：登录用户第一轮的在途标记写成 `anon:<sid>`。
 *  R3 消费当前账户中断标记时清空全部账户：B 的标记被 A 的登录清掉。
 */

/* node 环境没有 window/localStorage：补最小实现（同 agent-session-runtime.test.ts） */
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
  /** 直接读原始条目（断言键名用） */
  keys() {
    return [...this.m.keys()];
  }
}
const fake = new FakeStorage();
(globalThis as unknown as { window: unknown }).window = { localStorage: fake };
afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

/* runAgent 依赖浏览器环境下的 streamChat；用 vi.mock 换成可编排的桩，
 * 这样测的是 runner 自己的审批执行边界，而不是上游。 */
const streamChatStub = vi.fn();
vi.mock("@/lib/ai/client", () => ({
  streamChat: (...args: unknown[]) => streamChatStub(...args),
}));
/* tool-executors 很重（依赖 store/网络）；只替换 executeTool / executeAction，
 * 保留真实的 isWriteCall 等纯函数语义由 runner 自行判断。 */
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
import {
  beginRun,
  cancelRun,
  markInterruptedOnLoad,
  releaseRun,
  resetRuntimeForAccount,
  useRuntimeStore,
} from "../agent/session-runtime";
import type { PendingAction } from "../agent/protocol";

function ndjsonResponse(lines: unknown[]) {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const encoder = new TextEncoder();
  let sent = false;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(encoder.encode(text));
      },
    }),
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
  );
}

/** 让第 1 轮返回一个待审批的写入工具调用，第 2 轮返回正文 */
function primeWriteRound(action: PendingAction) {
  streamChatStub.mockReset();
  streamChatStub
    .mockResolvedValueOnce("```tool\n" + JSON.stringify({ name: "save_note", args: { title: "T", body: "B" } }) + "\n```")
    .mockResolvedValueOnce("好了。");
  executeToolStub.mockResolvedValue({
    result: { ok: true, content: "草稿已生成", summary: "等待确认" },
    action,
  });
  executeActionStub.mockReset();
  executeActionStub.mockResolvedValue({ ok: true, content: "已保存", summary: "已保存" });
}

async function runOnce(decisions: { actionId: string; approved: boolean }[]) {
  return runAgent({
    question: "存一篇笔记",
    context: "{}",
    history: [{ role: "user", content: "存一篇笔记" }],
    deep: false,
    signal: new AbortController().signal,
    cb: {
      onPhase: () => {},
      onPlan: () => {},
      onTool: () => {},
      onReasoning: () => {},
      onDelta: () => {},
      requestApproval: async () => decisions,
    },
  });
}

const ACTION: PendingAction = {
  id: "pa_1",
  kind: "save_note",
  label: "存为新笔记",
  summary: "存一篇",
  payload: { title: "T", body: "B" },
};

beforeEach(() => {
  streamChatStub.mockReset();
  executeToolStub.mockReset();
  executeActionStub.mockReset();
  // fetch 也被 runner 之外的路径用到（normalizeHttpUrl 不需要），这里给个兜底
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => new Response("{}", { status: 200 }));
  fake.clear();
  for (const sid of ["sA", "sB"]) {
    cancelRun(sid, "switch");
    useRuntimeStore.getState().dropSession(sid);
  }
});

/* ================== R1：审批执行边界 ================== */
describe("R1 审批执行边界默认拒绝", () => {
  it("空决定数组（没有收到任何批准）→ executeAction 0 次", async () => {
    primeWriteRound(ACTION);
    const { meta } = await runOnce([]);
    expect(executeActionStub).toHaveBeenCalledTimes(0);
    const call = meta.tools.find((t) => t.id === "tc0" || t.name === "save_note");
    expect(call?.status).toBe("declined");
    expect(call?.summary).toMatch(/未获批准/);
  });

  it("显式批准 → executeAction 1 次（对照）", async () => {
    primeWriteRound(ACTION);
    await runOnce([{ actionId: ACTION.id, approved: true }]);
    expect(executeActionStub).toHaveBeenCalledTimes(1);
  });

  it("显式拒绝 → executeAction 0 次（对照）", async () => {
    primeWriteRound(ACTION);
    const { meta } = await runOnce([{ actionId: ACTION.id, approved: false }]);
    expect(executeActionStub).toHaveBeenCalledTimes(0);
    expect(meta.tools.find((t) => t.name === "save_note")?.status).toBe("declined");
  });

  it("未知 actionId（决定对不上号）→ 不执行", async () => {
    primeWriteRound(ACTION);
    await runOnce([{ actionId: "pa_other", approved: true }]);
    expect(executeActionStub).toHaveBeenCalledTimes(0);
  });

  it("部分决定（两张卡只批一张）→ 只执行被批的那张", async () => {
    const a1: PendingAction = { ...ACTION, id: "pa_1" };
    const a2: PendingAction = { ...ACTION, id: "pa_2", summary: "第二篇" };
    streamChatStub.mockReset();
    streamChatStub
      .mockResolvedValueOnce(
        "```tool\n" +
          JSON.stringify({ name: "save_note", args: { title: "A", body: "a" } }) +
          "\n```\n```tool\n" +
          JSON.stringify({ name: "save_note", args: { title: "B", body: "b" } }) +
          "\n```"
      )
      .mockResolvedValueOnce("好了。");
    executeToolStub.mockResolvedValueOnce({ result: { ok: true, content: "草稿", summary: "等待确认" }, action: a1 });
    executeToolStub.mockResolvedValueOnce({ result: { ok: true, content: "草稿", summary: "等待确认" }, action: a2 });
    executeActionStub.mockResolvedValue({ ok: true, content: "已保存", summary: "已保存" });

    await runOnce([{ actionId: "pa_1", approved: true }]);
    expect(executeActionStub).toHaveBeenCalledTimes(1);
    expect(executeActionStub.mock.calls[0][0].id).toBe("pa_1");
  });

  it("批准与停止竞态：signal 已中止 → 即使有批准也不写", async () => {
    primeWriteRound(ACTION);
    const ac = new AbortController();
    const p = runAgent({
      question: "存一篇笔记",
      context: "{}",
      history: [{ role: "user", content: "存一篇笔记" }],
      deep: false,
      signal: ac.signal,
      cb: {
        onPhase: () => {},
        onPlan: () => {},
        onTool: () => {},
        onReasoning: () => {},
        onDelta: () => {},
        requestApproval: async () => {
          ac.abort(); // 用户在这张卡上点了停止
          return [{ actionId: ACTION.id, approved: true }];
        },
      },
    });
    const { meta } = await p;
    expect(executeActionStub).toHaveBeenCalledTimes(0);
    const call = meta.tools.find((t) => t.name === "save_note");
    expect(call?.status).toBe("declined");
    expect(call?.summary).toMatch(/已停止/);
  });

  it("重复批准同一 action 不会造成第二次副作用", async () => {
    primeWriteRound(ACTION);
    await runOnce([
      { actionId: ACTION.id, approved: true },
      { actionId: ACTION.id, approved: true },
    ]);
    expect(executeActionStub).toHaveBeenCalledTimes(1);
  });
});

/* ================== R2：首次身份登记的作用域 ================== */
describe("R2 首次登记登录账户即设置作用域", () => {
  it("新实例里首次 resetRuntimeForAccount('user-A') 之后，在途标记前缀是 user-A", () => {
    /* 模拟「全新模块实例」：用 vi.resetModules 重新加载，避免上一个测试留下的
     * runtimeAccountKey 让本次走「非首次」分支。 */
    return import("../agent/session-runtime").then(async (fresh) => {
      /* 清空残留 */
      fake.clear();
      fresh.resetRuntimeForAccount("user-A");
      const ac = fresh.beginRun("session-A", "run-A");
      const keys = fake.keys();
      expect(keys.some((k) => k === "mentora:agent:inflight")).toBe(true);
      const raw = JSON.parse(fake.getItem("mentora:agent:inflight") || "{}");
      expect(Object.keys(raw)).toContain("user-A:session-A");
      expect(Object.keys(raw).some((k) => k.startsWith("anon:"))).toBe(false);
      fresh.releaseRun("session-A");
      ac.abort();
    });
  });

  it("匿名状态下的运行标记前缀是 anon", () => {
    resetRuntimeForAccount(null);
    fake.clear();
    beginRun("session-N", "run-N");
    const raw = JSON.parse(fake.getItem("mentora:agent:inflight") || "{}");
    expect(Object.keys(raw)).toContain("anon:session-N");
    releaseRun("session-N");
  });

  it("A→B 切换：旧账户的运行被取消，新运行只用新前缀", () => {
    resetRuntimeForAccount(null);
    resetRuntimeForAccount("user-A");
    fake.clear();
    const acA = beginRun("session-A", "run-A");
    resetRuntimeForAccount("user-B");
    expect(acA.signal.aborted).toBe(true);
    beginRun("session-B", "run-B");
    const raw = JSON.parse(fake.getItem("mentora:agent:inflight") || "{}");
    expect(Object.keys(raw)).toContain("user-B:session-B");
    expect(Object.keys(raw).some((k) => k.startsWith("user-A:"))).toBe(false);
    releaseRun("session-B");
  });

  it("退出登录后作用域回到 anon", () => {
    resetRuntimeForAccount("user-A");
    resetRuntimeForAccount(null);
    fake.clear();
    beginRun("session-X", "run-X");
    const raw = JSON.parse(fake.getItem("mentora:agent:inflight") || "{}");
    expect(Object.keys(raw)).toContain("anon:session-X");
    releaseRun("session-X");
  });
});

/* ================== R3：只消费当前账户的标记 ================== */
describe("R3 恢复当前账户的中断任务不得删除其他账户标记", () => {
  it("A 恢复后 B 的标记原样保留，切到 B 仍能恢复自己的提示", () => {
    fake.setItem(
      "mentora:agent:inflight",
      JSON.stringify({
        "user-A:sA": { runId: "rA", startedAt: Date.now() },
        "user-B:sB": { runId: "rB", startedAt: Date.now() },
      })
    );
    resetRuntimeForAccount("user-A");
    const ids = markInterruptedOnLoad();
    expect(ids).toEqual(["sA"]);
    const raw = JSON.parse(fake.getItem("mentora:agent:inflight") || "{}");
    expect(Object.keys(raw)).toEqual(["user-B:sB"]); // B 的还在

    /* 切到 B：仍能恢复自己的中断提示 */
    resetRuntimeForAccount("user-B");
    const idsB = markInterruptedOnLoad();
    expect(idsB).toEqual(["sB"]);
    const after = fake.getItem("mentora:agent:inflight");
    expect(after).toBeNull(); // 都消费完了
  });

  it("恢复只标 interrupted，不重放任何写动作", () => {
    fake.setItem(
      "mentora:agent:inflight",
      JSON.stringify({ "user-A:sA": { runId: "rA", startedAt: Date.now() } })
    );
    resetRuntimeForAccount("user-A");
    markInterruptedOnLoad();
    const run = useRuntimeStore.getState().views.sA.run;
    expect(run?.status).toBe("interrupted");
    expect(run?.partialAnswer).toBe("");
    expect(executeActionStub).toHaveBeenCalledTimes(0);
    expect(executeToolStub).toHaveBeenCalledTimes(0);
  });

  it("R4：无归属旧标记一律隔离，绝不认领给任何用户（独立复核第二轮）", () => {
    fake.setItem(
      "mentora:agent:inflight",
      JSON.stringify({ "unknown-session": { runId: "rU", startedAt: Date.now() } })
    );
    /* 首次登录 user-B：独立探针正是在这里被误认领的 */
    resetRuntimeForAccount("user-B");

    const raw = JSON.parse(fake.getItem("mentora:agent:inflight") || "{}");
    /* 不得出现任何用户的键 */
    expect(Object.keys(raw).some((k) => k.startsWith("user-B:"))).toBe(false);
    expect(Object.keys(raw)).not.toContain("unknown-session");

    /* 隔离区保留原值以便审计 */
    const q = JSON.parse(fake.getItem("mentora:agent:inflight.quarantine") || "{}");
    expect(Object.keys(q)).toContain("unknown-session");
    expect(q["unknown-session"].runId).toBe("rU");
    expect(typeof q["unknown-session"].quarantinedAt).toBe("string");

    /* 且不会被当成当前用户的中断任务返回 */
    const ids = markInterruptedOnLoad();
    expect(ids).toEqual([]);
  });

  it("R4：带 owner 的旧记录也不跨用户认领", () => {
    fake.setItem(
      "mentora:agent:inflight",
      JSON.stringify({
        "user-A:sA": { runId: "rA", startedAt: Date.now(), owner: "user-A" },
        "user-A:sB": { runId: "rB", startedAt: Date.now(), owner: "user-C" },
      })
    );
    resetRuntimeForAccount("user-A");
    /* 键前缀是 A，但 owner 写着 user-C：不可信，跳过 */
    const ids = markInterruptedOnLoad();
    expect(ids).toEqual(["sA"]);
  });
});
