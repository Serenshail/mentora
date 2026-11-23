import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* ============ 回归锁：reading-metrics 迁移六分类口径 = 唯一真源 transferOutcome（FIX 2026-11-09）============
 * 修复前 route.ts 与 types.ts transferOutcome（v26.1 G3 硬禁令）相悖：
 *  ① 复检 stage=recheck 的 independent_success 无条件计独立成功——assisted 模式不降级；
 *  ② 未复检 used_correct 只看 mode，忽略事件里的 hintUsed（store.ts:1410 有带）；
 *  ③ naming_only+assisted 计 partial_success，真源应计 assisted_success；
 *  ④ 复检 incomplete 计 incomplete，真源归 partial_success（transferOutcome:427）；
 *  ⑤ 复检埋点（store.ts attachTransferRecheck）不带 mode，路由想降级也无数据。
 * 本锁用真路由 GET + 伪造 events 行逐支钉死：后台独立成功率不得再被系统性高估。 */

const rows: { name: string; account: string; props: string; created_at: string }[] = [];

vi.mock("../server/db", () => ({
  dbReadingEvents: vi.fn(async () => rows),
}));

vi.mock("../server/admin-auth", () => ({
  authorizeAdminDetailed: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../server/config", () => ({
  logEvent: vi.fn(),
}));

/* trackReading 挂 vi.fn：既捕获 store 复检埋点的 props，又让 Node 下无副作用 */
vi.mock("../track", () => ({
  track: vi.fn(),
  trackReading: vi.fn(),
}));

import { GET } from "../../app/api/admin/reading-metrics/route";
import { useAppStore } from "../store";
import { trackReading } from "../track";

function req(days = 30) {
  return {
    nextUrl: { searchParams: { get: () => String(days) } },
    headers: { get: () => null },
  } as unknown as import("next/server").NextRequest;
}

const hashAccount = (name: string) => crypto.createHash("sha256").update(name).digest("hex").slice(0, 16);
const push = (account: string, props: Record<string, unknown>) => {
  rows.push({
    name: "transfer_evaluated",
    account: hashAccount(account),
    props: JSON.stringify(props),
    created_at: "2026-11-01 10:00:00",
  });
};

beforeEach(() => {
  rows.length = 0;
  vi.mocked(trackReading).mockClear();
});

async function outcomes() {
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; transfer: { outcomes: Record<string, number> } };
  expect(body.ok).toBe(true);
  return body.transfer.outcomes;
}

const ZERO = { independent_success: 0, assisted_success: 0, partial_success: 0, incorrect: 0, incomplete: 0, ungradable: 0 };

describe("reading-metrics 六分类：复检口径（stage=recheck）", () => {
  it("① assisted 复检 independent_success 降级为 assisted_success（不再虚增独立成功）", async () => {
    push("u1", { bookId: "b", stage: "recheck", result: "independent_success", mode: "assisted" });
    expect(await outcomes()).toEqual({ ...ZERO, assisted_success: 1 });
  });

  it("② independent 复检 independent_success 才计独立成功", async () => {
    push("u1", { bookId: "b", stage: "recheck", result: "independent_success", mode: "independent" });
    expect(await outcomes()).toEqual({ ...ZERO, independent_success: 1 });
  });

  it("③ 老数据无 mode 的复检 independent_success 保守计独立成功（发送端已补 mode）", async () => {
    push("u1", { bookId: "b", stage: "recheck", result: "independent_success" });
    expect(await outcomes()).toEqual({ ...ZERO, independent_success: 1 });
  });

  it("④ 复检 incomplete 归 partial_success（对齐 transferOutcome:427）", async () => {
    push("u1", { bookId: "b", stage: "recheck", result: "incomplete" });
    expect(await outcomes()).toEqual({ ...ZERO, partial_success: 1 });
  });

  it("⑤ 复检 assisted_success/incorrect/ungradable 直通", async () => {
    push("u1", { bookId: "b", stage: "recheck", result: "assisted_success" });
    push("u2", { bookId: "b", stage: "recheck", result: "incorrect" });
    push("u3", { bookId: "b", stage: "recheck", result: "ungradable" });
    const o = await outcomes();
    expect(o).toEqual({ ...ZERO, assisted_success: 1, incorrect: 1, ungradable: 1 });
  });
});

describe("reading-metrics 六分类：未复检口径（verdict+mode+hintUsed）", () => {
  it("⑥ used_correct + mode=assisted → assisted_success", async () => {
    push("u1", { bookId: "b", verdict: "used_correct", mode: "assisted" });
    expect(await outcomes()).toEqual({ ...ZERO, assisted_success: 1 });
  });

  it("⑦ used_correct + mode=independent + hintUsed=true → assisted_success（不再漏看 hintUsed）", async () => {
    push("u1", { bookId: "b", verdict: "used_correct", mode: "independent", hintUsed: true });
    expect(await outcomes()).toEqual({ ...ZERO, assisted_success: 1 });
  });

  it("⑧ used_correct + mode=independent 未用提示 → partial_success（未过独立复检不算独立成功）", async () => {
    push("u1", { bookId: "b", verdict: "used_correct", mode: "independent", hintUsed: false });
    expect(await outcomes()).toEqual({ ...ZERO, partial_success: 1 });
  });

  it("⑨ used_wrong → incorrect", async () => {
    push("u1", { bookId: "b", verdict: "used_wrong", mode: "independent" });
    expect(await outcomes()).toEqual({ ...ZERO, incorrect: 1 });
  });

  it("⑩ naming_only + assisted → assisted_success（真源口径，不再是 partial_success）", async () => {
    push("u1", { bookId: "b", verdict: "naming_only", mode: "assisted" });
    expect(await outcomes()).toEqual({ ...ZERO, assisted_success: 1 });
  });

  it("⑪ naming_only + independent → partial_success", async () => {
    push("u1", { bookId: "b", verdict: "naming_only", mode: "independent" });
    expect(await outcomes()).toEqual({ ...ZERO, partial_success: 1 });
  });

  it("⑫ 坏 props JSON 跳过不炸整个接口", async () => {
    rows.push({ name: "transfer_evaluated", account: hashAccount("u1"), props: "{broken", created_at: "2026-11-01 10:00:00" });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

/* ============ store 侧：复检埋点必须带原迁移的 mode（路由降级的数据前提）============ */

const bookWithTransfers = (bookId: string) => ({
  books: [
    {
      id: bookId,
      title: "埋点锁",
      status: "reading" as const,
      readStatus: "reading" as const,
      chapters: [{ id: "c1", title: "节点", focusQuestion: "f", status: "todo" as const }],
      insights: [],
      chat: [],
      createdAt: new Date().toISOString(),
      transfers: [
        {
          id: "tf-assisted",
          chapterIds: ["c1"],
          task: "任务",
          answer: "作答",
          verdict: "used_correct" as const,
          evidence: "e",
          feedback: "f",
          mode: "assisted" as const,
          at: new Date().toISOString(),
        },
        {
          id: "tf-legacy",
          chapterIds: ["c1"],
          task: "任务2",
          answer: "作答2",
          verdict: "used_correct" as const,
          evidence: "e",
          feedback: "f",
          at: new Date().toISOString(),
        },
      ],
    },
  ],
  knowledge: [],
});

describe("attachTransferRecheck 埋点带 mode（路由降级的数据前提）", () => {
  beforeEach(() => {
    useAppStore.setState({ books: [], knowledge: [] });
  });

  it("assisted 迁移的复检埋点携带 mode=assisted；无 mode 的旧迁移回退 independent", () => {
    const bookId = "b-track";
    useAppStore.setState(bookWithTransfers(bookId));
    const s = useAppStore.getState();
    s.attachTransferRecheck(bookId, "tf-assisted", {
      task: "复检题", answer: "复检答", verdict: "independent_success", evidence: "", at: new Date().toISOString(),
    });
    s.attachTransferRecheck(bookId, "tf-legacy", {
      task: "复检题2", answer: "复检答2", verdict: "assisted_success", evidence: "", at: new Date().toISOString(),
    });
    const recheckCalls = vi.mocked(trackReading).mock.calls.filter(([n]) => n === "transfer_evaluated");
    expect(recheckCalls).toHaveLength(2);
    const first = recheckCalls[0][1] as { stage?: string; mode?: string; result?: string };
    const second = recheckCalls[1][1] as { stage?: string; mode?: string; result?: string };
    expect(first).toMatchObject({ stage: "recheck", result: "independent_success", mode: "assisted" });
    expect(second).toMatchObject({ stage: "recheck", result: "assisted_success", mode: "independent" });
  });

  it("埋点不发也照常写回 recheck 字段（fire-and-forget 纪律不变）", () => {
    const bookId = "b-track2";
    useAppStore.setState(bookWithTransfers(bookId));
    useAppStore.getState().attachTransferRecheck(bookId, "tf-assisted", {
      task: "复检题", answer: "复检答", verdict: "partial_success", evidence: "", at: new Date().toISOString(),
    });
    expect(useAppStore.getState().books[0].transfers![0].recheck?.verdict).toBe("partial_success");
  });
});
