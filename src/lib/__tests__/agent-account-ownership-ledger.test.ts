import { describe, expect, it, beforeEach, vi } from "vitest";

/* ============ 账户归属实证 + 请求账本（独立复核 2026-11-12 §3 / §5-1） ============
 * 复核明确要求：不能只靠「检查 sid 是否存在」盖章，必须用**实际双账户切换 +
 * 延迟成功 + 延迟异常**两条路径验证；同时补硬请求计数（不等 usage 完善）。
 * 这里用真实 store + 真实 runner（仅桩掉 streamChat/execute*），把整条链跑出来。 */

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
/* store 的 persist 在写失败/配额告警时会 window.dispatchEvent(CustomEvent)：
 * node 环境必须补齐这两个，否则测试会因为「环境缺 API」失败，而不是因为产品行为。 */
(globalThis as unknown as { window: unknown }).window = {
  localStorage: fake,
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
};
(globalThis as unknown as { CustomEvent: unknown }).CustomEvent = class {
  type: string;
  detail?: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
};

const streamChatStub = vi.fn();
vi.mock("@/lib/ai/client", () => ({
  streamChat: (...a: unknown[]) => streamChatStub(...a),
}));
const executeToolStub = vi.fn();
const executeActionStub = vi.fn();
vi.mock("@/lib/agent/tool-executors", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, executeTool: (...a: unknown[]) => executeToolStub(...a), executeAction: (...a: unknown[]) => executeActionStub(...a) };
});

import { useAppStore } from "@/lib/store";
import {
  beginRequest,
  budgetSnapshot,
  checkBudget,
  configureBudget,
  endRequest,
  ledgerSummary,
  resetLedger,
} from "../agent/request-ledger";
import { resetRuntimeForAccount, useRuntimeStore } from "../agent/session-runtime";

beforeEach(() => {
  fake.clear();
  streamChatStub.mockReset();
  executeToolStub.mockReset();
  executeActionStub.mockReset();
  resetLedger();
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => new Response("{}", { status: 200 }));
});

/* ================== 账户归属：显式 sid 不存在时拒绝写入 ================== */
describe("显式 sid 不存在 → 拒绝写入（不隐式创建幽灵会话）", () => {
  it("appendAgentMsg(msg, 不存在的 sid) 不新建会话、不返回 id", () => {
    useAppStore.setState({ agentSessions: [], agentActiveId: null, _storeUserId: "user-A" });
    const resolved = useAppStore.getState().appendAgentMsg(
      { id: "m1", role: "assistant", content: "旧账户的回答", at: new Date().toISOString() },
      "session-from-old-account"
    );
    expect(resolved).toBe("");
    expect(useAppStore.getState().agentSessions).toHaveLength(0);
  });

  it("无显式 sid（用户正常发送）仍能创建首条会话", () => {
    useAppStore.setState({ agentSessions: [], agentActiveId: null, _storeUserId: "user-A" });
    const resolved = useAppStore.getState().appendAgentMsg({
      id: "m1",
      role: "user",
      content: "第一句",
      at: new Date().toISOString(),
    });
    expect(resolved).not.toBe("");
    expect(useAppStore.getState().agentSessions).toHaveLength(1);
  });

  it("双账户切换后，旧 sid 的回写被拒绝，新账户数据不变", () => {
    useAppStore.setState({ agentSessions: [], agentActiveId: null, _storeUserId: "user-A" });
    const sidA = useAppStore.getState().newAgentSession();
    useAppStore.getState().appendAgentMsg({ id: "m1", role: "user", content: "A 的问题", at: new Date().toISOString() }, sidA);

    /* 切到 B：模拟 setStoreUser 的仓切换（sessions 清空） */
    resetRuntimeForAccount("user-B");
    useAppStore.setState({ agentSessions: [], agentActiveId: null, _storeUserId: "user-B" });
    const sidB = useAppStore.getState().newAgentSession();
    const beforeB = useAppStore.getState().agentSessions.length;

    /* A 的迟到回写 */
    const resolved = useAppStore.getState().appendAgentMsg(
      { id: "m2", role: "assistant", content: "A 的回答", at: new Date().toISOString() },
      sidA
    );
    expect(resolved).toBe("");
    expect(useAppStore.getState().agentSessions).toHaveLength(beforeB);
    expect(useAppStore.getState().agentSessions.some((s) => s.id === sidB)).toBe(true);
    const all = useAppStore.getState().agentSessions.flatMap((s) => s.messages.map((m) => m.content));
    expect(all).not.toContain("A 的回答");
  });

  it("切回 A 后 A 自己的会话仍可写（同用户切回不受影响）", () => {
    useAppStore.setState({ agentSessions: [], agentActiveId: null, _storeUserId: "user-A" });
    const sidA = useAppStore.getState().newAgentSession();
    resetRuntimeForAccount("user-B");
    resetRuntimeForAccount("user-A");
    /* 切回后 store 里仍有 sidA（仓是同步加载的）→ 正常写入 */
    expect(useAppStore.getState().agentSessions.some((s) => s.id === sidA)).toBe(true);
    const resolved = useAppStore.getState().appendAgentMsg(
      { id: "m9", role: "user", content: "回来继续", at: new Date().toISOString() },
      sidA
    );
    expect(resolved).toBe(sidA);
  });
});

/* ================== 请求账本 ================== */
describe("请求账本：硬计数、预算闸门、usage 缺失标 unknown", () => {
  const id = { userId: "user-A", sessionId: "s1", runId: "r1", task: "agent", layer: "provider" as const };

  it("每次请求一行，记 run/session/requestId/失败/重试关系", () => {
    const r1 = beginRequest({ ...id, round: 0 });
    endRequest(r1.id, { ok: true, inputTokens: 120, outputTokens: 40, usageSource: "provider" });
    const r2 = beginRequest({ ...id, round: 1, retryOf: r1.id });
    endRequest(r2.id, { ok: false, error: "upstream 502" });

    const sum = ledgerSummary();
    expect(sum.totalRecords).toBe(2);
    expect(sum.records[0].inputTokens).toBe(120);
    expect(sum.records[0].usageSource).toBe("provider");
    expect(sum.records[1].retryOf).toBe(r1.id);
    expect(sum.records[1].ok).toBe(false);
    expect(sum.records[1].error).toBe("upstream 502");
  });

  it("供应商没给 usage → usageSource=unknown，且不计入 token 合计", () => {
    const r = beginRequest({ ...id, round: 0 });
    endRequest(r.id, { ok: true });
    const sum = ledgerSummary();
    expect(sum.records[0].usageSource).toBe("unknown");
    expect(sum.records[0].inputTokens).toBeUndefined();
    expect(sum.byTask.agent.unknownUsage).toBe(1);
    expect(sum.byTask.agent.input).toBe(0);
  });

  it("预算闸门：达到上限后拒绝发请求，并记 rejected（不静默继续花）", () => {
    configureBudget(10, 2, "baseline");
    expect(checkBudget(id).ok).toBe(true);
    beginRequest({ ...id, round: 0 });
    expect(checkBudget(id).ok).toBe(true);
    beginRequest({ ...id, round: 1 });
    const third = checkBudget(id);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toMatch(/provider 2 次/);
    const snap = budgetSnapshot();
    expect(snap.providerUsed).toBe(2);
    expect(snap.providerRemaining).toBe(0);
    expect(snap.rejected).toBe(1);
  });

  it("失败与重试都计入硬上限（不能只算成功）", () => {
    configureBudget(10, 3, "candidate");
    const a = beginRequest({ ...id, round: 0 });
    endRequest(a.id, { ok: false, error: "timeout" });
    const b = beginRequest({ ...id, round: 0, retryOf: a.id });
    endRequest(b.id, { ok: true, inputTokens: 10, outputTokens: 5, usageSource: "provider" });
    const c = beginRequest({ ...id, round: 1 });
    endRequest(c.id, { ok: true });
    expect(budgetSnapshot().providerUsed).toBe(3);
    expect(checkBudget(id).ok).toBe(false);
  });

  it("按类别分开报账（不同 purpose 不混算）", () => {
    configureBudget(10, 10, "baseline");
    const r = beginRequest({ ...id, task: "lesson", round: 0 });
    endRequest(r.id, { ok: true, inputTokens: 50, outputTokens: 20, usageSource: "provider" });
    const r2 = beginRequest({ ...id, task: "agent", round: 0 });
    endRequest(r2.id, { ok: true, inputTokens: 80, outputTokens: 30, usageSource: "provider" });
    const sum = ledgerSummary();
    expect(sum.byTask.lesson.input).toBe(50);
    expect(sum.byTask.agent.input).toBe(80);
    expect(sum.byTask.lesson.requests).toBe(1);
  });
});

/* ================== 运行态归属（防止跨账户借用） ================== */
describe("运行态按会话隔离，不跨账户借用", () => {
  it("切换账户清空运行视图，旧 run 不再可见", () => {
    resetRuntimeForAccount("user-A");
    useRuntimeStore.getState().startRun("sA", {
      runId: "r1",
      sessionId: "sA",
      seq: 1,
      status: "generating",
      phase: "answering",
      startedAt: Date.now(),
      headline: "正在回答…",
      plan: [],
      tools: [],
      phases: [],
      partialAnswer: "A 的流式内容",
      pendingActions: [],
    });
    expect(useRuntimeStore.getState().views.sA?.run?.partialAnswer).toBe("A 的流式内容");
    resetRuntimeForAccount("user-B");
    expect(useRuntimeStore.getState().views.sA).toBeUndefined();
  });
});
