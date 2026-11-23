import { beforeEach, describe, expect, it, vi } from "vitest";

/* 回归锁：隐式批次（生产主对话）必须能自动滚动，否则 48 次 provider 请求之后
 * 该浏览器档案的主对话链路永久停摆（账本持久化在 localStorage、批次从不更换）。
 * 同时锁住 checkBudget 按调用层各查各的口径（provider 请求不被 browser 额度挡）。 */

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

async function reloadLedger() {
  vi.resetModules();
  return await import("../agent/request-ledger");
}

beforeEach(() => {
  fake.clear();
});

const base = { userId: "u", sessionId: "s", runId: "r", task: "agent", layer: "provider" as const };

describe("隐式批次自动滚动（防永久停摆）", () => {
  it("超过 TTL 后 providerUsed 归零、batchId 更换", async () => {
    const m = await reloadLedger();
    /* 默认预算 providerLimit=48，purpose="other"（生产主对话走这条） */
    for (let i = 0; i < 3; i++) {
      const r = m.beginRequest({ ...base, round: i });
      m.endRequest(r.id, { ok: true });
    }
    const beforeBatch = m.currentBatchId();
    expect(m.budgetSnapshot().providerUsed).toBe(3);

    /* 把「本批开始时刻」往前推 13 小时（模拟隔天再来） */
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 13 * 60 * 60 * 1000);
    try {
      const snap = m.budgetSnapshot();
      expect(snap.providerUsed).toBe(0);
      expect(snap.batchId).not.toBe(beforeBatch);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("显式跑批批次（purpose 非 other）不自动滚动——换批仍须显式", async () => {
    const m = await reloadLedger();
    m.startNewBatch("eval");
    m.configureBudget(10, 10, "eval");
    const r = m.beginRequest({ ...base, round: 0 });
    m.endRequest(r.id, { ok: true });
    const batch = m.currentBatchId();

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 13 * 60 * 60 * 1000);
    try {
      expect(m.budgetSnapshot().providerUsed).toBe(1);
      expect(m.currentBatchId()).toBe(batch);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("旧数据（无 batchStartedAt）用最早记录时间近似批次起点", async () => {
    const longAgo = Date.now() - 13 * 60 * 60 * 1000;
    fake.setItem(
      "mentora:agent:ledger.state",
      JSON.stringify({
        batchId: "b_old",
        records: [{ id: "rq_1", batchId: "b_old", userId: "u", sessionId: "s", runId: "r", layer: "provider", task: "agent", round: 0, startedAt: longAgo, usageSource: "unknown" }],
        rejected: 0,
      })
    );
    const m = await reloadLedger();
    /* 首次 snapshot 就该滚进新批（不是再等 12 小时） */
    expect(m.budgetSnapshot().providerUsed).toBe(0);
    expect(m.currentBatchId()).not.toBe("b_old");
  });
});

describe("checkBudget 按层各查各的口径", () => {
  it("provider 触顶不挡 browser 层请求（反之亦然）", async () => {
    const m = await reloadLedger();
    m.configureBudget(5, 1, "x");
    const p = m.beginRequest({ ...base, round: 0 });
    m.endRequest(p.id, { ok: true });
    /* provider 已到 1/1 */
    expect(m.checkBudget({ ...base }).ok).toBe(false);
    /* browser 口径 0/5，仍放行 */
    expect(m.checkBudget({ ...base, layer: "browser" }).ok).toBe(true);
  });
});
