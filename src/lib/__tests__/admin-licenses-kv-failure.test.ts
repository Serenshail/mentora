import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 后台卡密接口的通道故障兜底回归锁（与 admin-leads-kv-failure 同口径）。
 * 修复前：GET 的 listBatches、POST 的 createBatch、PATCH 的 revokeLicense 全部裸调用，
 * 任一 KV 通道故障（license.ts 内部 dbList/dbPut 抛错）都会让 Next 兜底成非 JSON 的 500，
 * 走 x-admin-password 的外部后台拿不到结构化 {error}。
 * 关键语义：PATCH 失败必须是 503，绝不能落成 404——否则管理员会把「服务故障」
 * 误判成「这张码不存在」，以为该码已处理。 */

const state = vi.hoisted(() => ({
  failList: false,
  failCreate: false,
  failRevoke: false,
  created: 0,
  revoked: [] as string[],
}));

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("../server/admin-auth", () => ({
  authorizeAdmin: vi.fn(async () => ({ ok: true, email: "admin@x.com", name: "admin" })),
}));

vi.mock("../server/license", () => ({
  listBatches: vi.fn(async () => {
    if (state.failList) throw new Error("DB 列目录失败（500）");
    return [{ id: "B1", plan: "month", days: 30, codes: [] }];
  }),
  createBatch: vi.fn(async () => {
    if (state.failCreate) throw new Error("DB 写入失败（500）");
    state.created++;
    return { batch: { id: "B1", codes: [] }, codes: ["AAAA-BBBB-CCCC"] };
  }),
  revokeLicense: vi.fn(async (code: string) => {
    if (state.failRevoke) throw new Error("DB 写入失败（500）");
    if (code === "MISSING") return null;
    state.revoked.push(code);
    return { code, status: "revoked" };
  }),
}));

import { GET, PATCH, POST } from "../../app/api/admin/licenses/route";

const req = (body?: unknown) =>
  ({
    headers: { get: () => null },
    json: async () => body,
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  state.failList = false;
  state.failCreate = false;
  state.failRevoke = false;
  state.created = 0;
  state.revoked = [];
});

describe("admin licenses 通道故障兜底", () => {
  it("GET：listBatches 抛错 → 503 且 body 是 JSON {error}", async () => {
    state.failList = true;
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; batches?: unknown };
    expect(typeof body.error).toBe("string");
    expect(body.batches).toBeUndefined();
  });

  it("POST：createBatch 抛错 → 503 JSON（不是裸 500）", async () => {
    state.failCreate = true;
    const res = await POST(req({ count: 1, plan: "month" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; ok?: boolean };
    expect(typeof body.error).toBe("string");
    expect(body.ok).toBeUndefined();
  });

  it("PATCH：revokeLicense 抛错 → 503 JSON，且不得误报 404", async () => {
    state.failRevoke = true;
    const res = await PATCH(req({ code: "MTR-ABCD-EFGH" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });

  it("PATCH：码不存在 → 仍是 404（与故障 503 区分）", async () => {
    const res = await PATCH(req({ code: "MISSING" }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe("找不到这张激活码");
  });

  it("正常路径不受影响：GET/POST/PATCH 均 200", async () => {
    expect((await GET(req())).status).toBe(200);
    expect((await POST(req({ count: 1, plan: "month" }))).status).toBe(200);
    const patch = await PATCH(req({ code: "MTR-ABCD-EFGH" }));
    expect(patch.status).toBe(200);
    expect(state.revoked).toEqual(["MTR-ABCD-EFGH"]);
  });
});
