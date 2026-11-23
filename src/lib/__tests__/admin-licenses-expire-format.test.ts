import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 后台卡密路由 expiresAt 校验顺序的回归锁：
 * 修复前第 46 行先执行 new Date(String(body.expiresAt)).toISOString()，
 * 对非法日期字符串（如 "not-a-date"）toISOString() 抛 RangeError: Invalid time value，
 * 未捕获直接变成无 JSON 错误体的裸 500；第 47 行的 400「卡密有效期格式不对」
 * 永远不可达（能走到 47 行说明 toISOString 已成功，Date.parse 必不 NaN）。
 * 该路由供外部后台自由 JSON 调用，传任意非日期字符串即触发。
 * 修复：先 Date.parse(String(...)) 校验返回 400，再 toISOString 转换。
 * 锁三件事：
 *  1) 非法 expiresAt → 400 JSON（不是裸 500），且不落库（createBatch 不被调用）；
 *  2) 合法 expiresAt → 200，createBatch 收到归一化后的 ISO 字符串；
 *  3) 缺省/空串/null expiresAt → 200，createBatch 收到 null（沿用套餐默认）。 */

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("../server/admin-auth", () => ({
  authorizeAdmin: vi.fn(async () => ({ ok: true, email: "admin@x.com", name: "admin" })),
}));

const createBatch = vi.fn(async (..._args: unknown[]) => ({
  batch: { id: "B1", codes: [] },
  codes: ["AAAA-BBBB-CCCC"],
}));
vi.mock("../server/license", () => ({
  createBatch: (...args: unknown[]) => createBatch(...args),
  listBatches: vi.fn(async () => []),
  revokeLicense: vi.fn(async () => null),
}));

import { POST } from "../../app/api/admin/licenses/route";

const req = (body: Record<string, unknown>) =>
  ({
    json: async () => body,
    headers: { get: () => null },
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  createBatch.mockClear();
});

describe("admin licenses 路由 expiresAt 校验顺序", () => {
  it("非法日期字符串 → 400 JSON（不是裸 500），且不落库", async () => {
    const res = await POST(req({ expiresAt: "not-a-date" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "卡密有效期格式不对" });
    expect(createBatch).not.toHaveBeenCalled();
  });

  it("非法 JSON 对象兜底文本（[object Object]）→ 400", async () => {
    const res = await POST(req({ expiresAt: { a: 1 } }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "卡密有效期格式不对" });
    expect(createBatch).not.toHaveBeenCalled();
  });

  it("超出范围的伪日期 2026-13-99 → 400", async () => {
    const res = await POST(req({ expiresAt: "2026-13-99" }));
    expect(res.status).toBe(400);
    expect(createBatch).not.toHaveBeenCalled();
  });

  it("合法日期 → 200，createBatch 收到归一化 ISO 字符串", async () => {
    const res = await POST(req({ expiresAt: "2026-12-31" }));
    expect(res.status).toBe(200);
    expect(createBatch).toHaveBeenCalledTimes(1);
    expect(createBatch.mock.calls[0][0]).toMatchObject({
      expiresAt: "2026-12-31T00:00:00.000Z",
    });
  });

  it("缺省 expiresAt → 200，createBatch 收到 null", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(200);
    expect(createBatch.mock.calls[0][0]).toMatchObject({ expiresAt: null });
  });

  it("空串 expiresAt → 200 且按缺省处理（null，不是 400）", async () => {
    const res = await POST(req({ expiresAt: "" }));
    expect(res.status).toBe(200);
    expect(createBatch.mock.calls[0][0]).toMatchObject({ expiresAt: null });
  });

  it("显式 null expiresAt → 200 且按缺省处理", async () => {
    const res = await POST(req({ expiresAt: null }));
    expect(res.status).toBe(200);
    expect(createBatch.mock.calls[0][0]).toMatchObject({ expiresAt: null });
  });
});
