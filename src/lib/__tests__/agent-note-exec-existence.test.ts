import { beforeEach, describe, expect, it, vi } from "vitest";

/* 回归锁：批准到执行之间笔记被删除时，update_note / delete_note / review_queue
 * 不得静默空操作却报成功（store 的 updateKnowledge/removeKnowledge/enableReview/
 * recordReview 对不存在的 id 都是 no-op）。与 book/session 类分支的「存在性守卫」同口径。 */

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
vi.mock("@/lib/utils", () => ({ uid: (p: string) => `${p}_t`, todayISO: () => "2026-11-23" }));
vi.mock("@/lib/resources", () => ({
  parseResourceConstraint: () => ({ resourceType: "video" }),
  classifyResource: () => ({}),
  validateResources: () => ({ verdicts: [] }),
}));

const calls: string[] = [];
const mutable = { knowledge: [] as { id: string; title: string; body: string; domain: string; links: string[] }[] };
vi.mock("@/lib/store", () => ({
  useAppStore: {
    getState: () => ({
      ...mutable,
      books: [],
      goals: [],
      sessions: [],
      settings: {},
      updateKnowledge: (id: string) => calls.push(`update:${id}`),
      removeKnowledge: (id: string) => calls.push(`remove:${id}`),
      enableReview: (id: string) => calls.push(`enable:${id}`),
      recordReview: (id: string) => calls.push(`record:${id}`),
    }),
    setState: () => {},
    subscribe: () => () => {},
  },
}));

import { executeAction } from "../agent/tool-executors";
import type { PendingAction } from "../agent/protocol";

const pa = (kind: PendingAction["kind"], payload: Record<string, unknown>, id = `pa_${kind}`): PendingAction => ({
  id,
  kind,
  label: kind,
  summary: "s",
  payload,
});

beforeEach(() => {
  calls.length = 0;
  /* 批准时笔记存在；执行时已被删除 —— 模拟「审批卡挂起期间另一入口删掉了它」 */
  mutable.knowledge = [];
});

describe("笔记类执行分支的存在性守卫", () => {
  it("update_note 目标已删 → 报未找到，不调用 updateKnowledge", async () => {
    const r = await executeAction(pa("update_note", { id: "k_gone", newTitle: "新标题" }, "pa_u1"));
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("未找到");
    expect(calls).toEqual([]);
  });

  it("delete_note 目标已删 → 报未找到，不调用 removeKnowledge", async () => {
    const r = await executeAction(pa("delete_note", { id: "k_gone", title: "旧标题" }, "pa_d1"));
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("review_queue record 目标已删 → 报未找到，不调用 recordReview", async () => {
    const r = await executeAction(pa("review_queue", { action: "record", id: "k_gone", title: "t", ok: true }, "pa_r1"));
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("目标存在时行为不变（正常更新）", async () => {
    mutable.knowledge = [{ id: "k1", title: "笔记A", body: "", domain: "笔记", links: [] }];
    const r = await executeAction(pa("update_note", { id: "k1", newTitle: "笔记B" }, "pa_u2"));
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["update:k1"]);
  });

  it("执行期改成与另一篇同名 → 拒绝（不制造重复标题）", async () => {
    mutable.knowledge = [
      { id: "k1", title: "笔记A", body: "", domain: "笔记", links: [] },
      { id: "k2", title: "笔记B", body: "", domain: "笔记", links: [] },
    ];
    const r = await executeAction(pa("update_note", { id: "k1", newTitle: "笔记B" }, "pa_u3"));
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("同名已存在");
    expect(calls).toEqual([]);
  });
});
