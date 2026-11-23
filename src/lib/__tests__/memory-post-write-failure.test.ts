import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：POST /api/memory 未捕获 addMemory 的存储故障——
 * addMemory（personal.ts）内部走 listMemory→dbList 与 dbPut，通道故障时按数据层纪律
 * 直接 throw。同文件 GET/DELETE 都对对应函数 try/catch → 结构化 503 + logEvent 留痕，
 * 唯独 POST 裸奔：异常穿透到 Next 兜底，客户端拿到非 JSON 的裸 500，既没有本文件承诺的
 * 错误语义，也没有 logEvent 留痕。触发条件：Upstash/D1/GitHub 任一存储通道故障期间调用
 * POST /api/memory（含 Obsidian 插件经设备令牌的写入）。 */

const h = vi.hoisted(() => ({
  failAdd: false,
  logEvent: vi.fn(() => {}),
}));

vi.mock("@/lib/server/personal", () => ({
  listMemory: vi.fn(async () => []),
  addMemory: vi.fn(async () => {
    if (h.failAdd) throw new Error("D1 请求失败（500）");
    return { id: "mem_1", text: "记住这件事", tags: [], source: "agent", createdAt: "2026-11-23T00:00:00.000Z" };
  }),
  deleteMemory: vi.fn(async () => undefined),
  isValidItemId: vi.fn(() => true),
  sanitizeMemoryInput: vi.fn(() => ({ text: "记住这件事", tags: [], source: "agent" })),
}));

vi.mock("@/lib/server/device-auth", () => ({
  verifyAnyAuth: vi.fn(async () => ({ userId: "u1", email: "u1@x.dev" })),
}));

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
}));

vi.mock("@/lib/server/config", () => ({ logEvent: h.logEvent }));

import { POST } from "../../app/api/memory/route";

const req = () =>
  ({
    headers: { get: () => null },
    json: async () => ({ text: "记住这件事" }),
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  h.failAdd = false;
  h.logEvent.mockClear();
});

describe("POST /api/memory：写入故障必须 503 + 留痕（不得裸 500）", () => {
  it("addMemory 抛错（存储通道故障）→ 结构化 503，logEvent 记录 add-fail", async () => {
    h.failAdd = true;
    const res = await POST(req());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("写入失败");
    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ route: "memory", ev: "add-fail", userId: "u1" })
    );
  });

  it("正常写入 → 200 { entry }（存量路径不受影响）", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entry: { id: string } };
    expect(body.entry.id).toBe("mem_1");
    expect(h.logEvent).not.toHaveBeenCalled();
  });
});
