import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：POST /api/tasks 的 dbPut 失败曾被 .catch(() => {}) 静默吞掉且
 * 无条件返回 { ok: true }，也无 logEvent 留痕——故障在 API 契约上不可表达。本文件 GET
 * （33-39 行注释）刚按「故障态必须与空态可区分」纪律修复，而 GET 的数据正来自这条 POST：
 * GitHub 等通道故障期间，startPlanTask 的 emit("running") 与 45s 心跳（plan-tasks.ts，
 * 本就 fire-and-forget 不看响应）全部写失败且无任何信号，用户整页刷新后 GET 返回
 * 「真空列表」，中断恢复引导静默消失、生成结果丢失。修复：写失败 → logEvent 留痕 +
 * 503 { ok:false }（与 memory DELETE 503、account DELETE partial 的「失败必须可见」纪律
 * 一致）。 */

const h = vi.hoisted(() => ({
  failPut: false,
  logEvent: vi.fn(() => {}),
}));

vi.mock("../server/db", () => ({
  dbGet: vi.fn(async () => null),
  dbPut: vi.fn(async () => {
    if (h.failPut) throw new Error("D1 请求失败（500）");
    return { sha: "mem" };
  }),
  dbList: vi.fn(async () => []),
}));

vi.mock("../server/auth", () => ({
  verifySession: vi.fn(async () => ({ userId: "u_me", email: "me@x.dev", name: "我", sv: 0 })),
}));

vi.mock("../server/config", () => ({ logEvent: h.logEvent }));

import { POST } from "../../app/api/tasks/route";

const req = () =>
  ({
    json: async () => ({ taskId: "pt_abc123", goalId: "g1", status: "running", startedAt: "2026-01-01T00:00:00.000Z" }),
    nextUrl: new URL("http://localhost/api/tasks"),
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  h.failPut = false;
  h.logEvent.mockClear();
});

describe("POST /api/tasks：状态写入失败必须可见", () => {
  it("dbPut 抛错 → 503 { ok:false } + logEvent 留痕（不再无条件 ok:true）", async () => {
    h.failPut = true;
    const res = await POST(req());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("写入失败");
    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ route: "tasks", ev: "put-fail", userId: "u_me", taskId: "pt_abc123" })
    );
  });

  it("写成功 → 200 { ok: true }（存量路径逐字不变）", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(h.logEvent).not.toHaveBeenCalled();
  });
});
