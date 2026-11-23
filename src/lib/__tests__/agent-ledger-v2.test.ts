import { describe, expect, it, beforeEach, vi } from "vitest";

/* ============ 请求账本 v2（独立复核第二轮 E1 的验收要求） ============
 * 复核指出 v1 的四个缺陷，这里逐条锁住：
 *  1. 只看浏览器 API，看不到服务端对上游的重试 → 现在 api / provider 两层分开计
 *  2. 只存内存，脚本重启/刷新即归零 → 现在 localStorage 持久化 + 稳定 batchId
 *  3. 关联靠「最近一个未结束请求」猜 → 现在每条带 batchId/caseId/attemptId/runId
 *  4. 没有 batchId → 现在有，且换批必须显式开新批
 *
 * 复核要求「先用 mock 验证脚本重启/刷新/重试/并发不会重置或漏算」——
 * 下面用「重新 import 模块」模拟刷新/重启。 */

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
  keys() {
    return [...this.m.keys()];
  }
}
const fake = new FakeStorage();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: fake,
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
};

/** 模拟「页面刷新 / 脚本重启」：清模块缓存后重新 import。 */
async function reloadLedger() {
  vi.resetModules();
  return await import("../agent/request-ledger");
}

beforeEach(async () => {
  fake.clear();
  const m = await reloadLedger();
  m.startNewBatch("test");
});

const base = { userId: "user-A", sessionId: "s1", runId: "r1", task: "agent" };

describe("E1-1：api 与 provider 两层分开计", () => {
  it("一次 API 请求 + 两次上游重试 = 1 api + 3 provider", async () => {
    const m = await reloadLedger();
    m.configureBudget(10, 10, "test");
    /* 浏览器发 1 次 */
    const api = m.beginRequest({ ...base, layer: "browser", round: 0 });
    m.endRequest(api.id, { ok: true });
    /* 服务端对它重试了 3 次 */
    for (let i = 1; i <= 3; i++) {
      const p = m.beginRequest({ ...base, layer: "provider", round: 0, providerAttempt: i, retryOf: api.id });
      m.endRequest(p.id, { ok: i === 3 });
    }
    const snap = m.budgetSnapshot();
    expect(snap.apiUsed).toBe(1);
    expect(snap.providerUsed).toBe(3);
    const sum = m.ledgerSummary();
    expect(sum.byLayer.browser.requests).toBe(1);
    expect(sum.byLayer.provider.requests).toBe(3);
    expect(sum.byLayer.provider.failed).toBe(2);
  });

  it("provider 口径触顶即拒绝（api 还有余量也不能再发）", async () => {
    const m = await reloadLedger();
    m.configureBudget(100, 2, "test");
    for (let i = 0; i < 2; i++) {
      const p = m.beginRequest({ ...base, layer: "provider", round: i });
      m.endRequest(p.id, { ok: true });
    }
    const gate = m.checkBudget({ ...base, layer: "provider" });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/provider 2 次/);
  });
});

describe("E1-2：刷新/重启不重置计数（稳定 batchId）", () => {
  it("重新 import 模块后，批次与已用计数都还在", async () => {
    const m1 = await reloadLedger();
    m1.configureBudget(10, 10, "persist");
    const batch = m1.currentBatchId();
    const r = m1.beginRequest({ ...base, layer: "provider", round: 0 });
    m1.endRequest(r.id, { ok: true, inputTokens: 100, outputTokens: 20, usageSource: "provider" });
    expect(m1.budgetSnapshot().providerUsed).toBe(1);

    /* 模拟刷新/重启 */
    const m2 = await reloadLedger();
    expect(m2.currentBatchId()).toBe(batch);
    expect(m2.budgetSnapshot().providerUsed).toBe(1);
    expect(m2.requestRecords().length).toBe(1);
  });

  it("换批次必须显式开新批；开新批后计数从 0 起，旧批次记录不再计入", async () => {
    const m = await reloadLedger();
    m.configureBudget(10, 10, "batchA");
    const a = m.currentBatchId();
    const r = m.beginRequest({ ...base, layer: "provider", round: 0 });
    m.endRequest(r.id, { ok: true });
    expect(m.budgetSnapshot().providerUsed).toBe(1);

    const b = m.startNewBatch("batchB");
    expect(b).not.toBe(a);
    expect(m.budgetSnapshot().providerUsed).toBe(0);
    expect(m.currentBatchId()).toBe(b);
  });
});

describe("E1-3：显式关联，不靠下标猜", () => {
  it("每条记录带 batchId/caseId/attemptId/runId/sessionId", async () => {
    const m = await reloadLedger();
    const r = m.beginRequest({
      ...base,
      layer: "provider",
      round: 2,
      caseId: "Q04",
      attemptId: 2,
      retryOf: "rq_prev",
    });
    m.endRequest(r.id, { ok: true });
    const rec = m.requestRecords().find((x) => x.id === r.id)!;
    expect(rec.batchId).toBe(m.currentBatchId());
    expect(rec.caseId).toBe("Q04");
    expect(rec.attemptId).toBe(2);
    expect(rec.runId).toBe("r1");
    expect(rec.sessionId).toBe("s1");
    expect(rec.retryOf).toBe("rq_prev");
    expect(rec.round).toBe(2);
  });

  it("并发请求各自独立结束，不互相覆盖", async () => {
    const m = await reloadLedger();
    const a = m.beginRequest({ ...base, layer: "provider", round: 0, caseId: "Q01" });
    const b = m.beginRequest({ ...base, sessionId: "s2", runId: "r2", layer: "provider", round: 0, caseId: "Q02" });
    /* 后发先至：B 先结束 */
    m.endRequest(b.id, { ok: true, inputTokens: 200, outputTokens: 30, usageSource: "provider" });
    m.endRequest(a.id, { ok: false, error: "timeout" });
    const recs = m.requestRecords();
    const ra = recs.find((x) => x.id === a.id)!;
    const rb = recs.find((x) => x.id === b.id)!;
    expect(ra.ok).toBe(false);
    expect(ra.error).toBe("timeout");
    expect(ra.inputTokens).toBeUndefined();
    expect(rb.ok).toBe(true);
    expect(rb.inputTokens).toBe(200);
  });
});

describe("E1-4：usage 缺失不写 0", () => {
  it("没给 usage 记 unknown，且不计入 token 合计", async () => {
    const m = await reloadLedger();
    const r = m.beginRequest({ ...base, layer: "provider", round: 0 });
    m.endRequest(r.id, { ok: true });
    const sum = m.ledgerSummary();
    expect(sum.byLayer.provider.unknownUsage).toBe(1);
    expect(sum.byLayer.provider.input).toBe(0);
    expect(m.requestRecords()[0].usageSource).toBe("unknown");
  });

  it("给了 usage 标 provider 并计入合计", async () => {
    const m = await reloadLedger();
    const r = m.beginRequest({ ...base, layer: "provider", round: 0 });
    m.endRequest(r.id, { ok: true, inputTokens: 500, outputTokens: 60, cachedTokens: 400, usageSource: "provider" });
    const sum = m.ledgerSummary();
    expect(sum.byLayer.provider.input).toBe(500);
    expect(sum.byLayer.provider.output).toBe(60);
    expect(sum.byLayer.provider.unknownUsage).toBe(0);
  });
});
