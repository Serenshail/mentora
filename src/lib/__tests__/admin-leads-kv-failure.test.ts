import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 后台线索接口的通道故障兜底回归锁。
 * 修复前：GET 的 dbList、POST 的 dbGet/dbPut、PATCH 的 dbGet/dbPut 全部裸奔，
 * 任一 KV 通道故障（db.ts 的 upstash/d1/rds/dcs/github 各分支 throw）都会让 Next
 * 兜底成非 JSON 的 500——走 x-admin-password 的外部后台拿不到 {error} 结构化信息，
 * 与兄弟管理路由（users/members/overview/reading-metrics 的 503 JSON）口径不一致。
 * 另锁 POST 的孤儿码：createBatch 成功后 dbPut 失败必须补偿（作废刚生成的码），
 * 否则管理员重试会重复发码。 */

const state = vi.hoisted(() => ({
  failList: false,
  failGet: false,
  failPut: false,
  revokeFails: false,
  store: new Map<string, unknown>(),
  revoked: [] as string[],
  createdBatches: 0,
}));

vi.mock("../server/db", () => ({
  dbList: vi.fn(async (dir: string) => {
    if (state.failList) throw new Error("DB 列目录失败（500）");
    return [...state.store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .sort()
      .map((k) => ({ name: k.slice(dir.length + 1), sha: "mem" }));
  }),
  dbGet: vi.fn(async (path: string) => {
    if (state.failGet) throw new Error("DB 读取失败（500）");
    return state.store.get(path) ?? null;
  }),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    if (state.failPut) throw new Error("DB 写入失败（500）");
    state.store.set(path, value);
    return { sha: "mem" };
  }),
}));

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("../server/admin-auth", () => ({
  authorizeAdmin: vi.fn(async () => ({ ok: true, email: "admin@x.com", name: "admin" })),
  /* mock 补全（F7 配套）：route 已改用 detailed 版取四类失败原因，返回同一 ok 对象 */
  authorizeAdminDetailed: vi.fn(async () => ({ ok: true, email: "admin@x.com", name: "admin" })),
}));

vi.mock("../server/license", () => ({
  createBatch: vi.fn(async () => {
    state.createdBatches++;
    return { codes: ["TRIAL-CODE"], batch: { id: "b1" } };
  }),
  revokeLicense: vi.fn(async (code: string) => {
    if (state.revokeFails) throw new Error("DB 写入失败（500）");
    state.revoked.push(code);
    return { code, status: "revoked" };
  }),
}));

import { GET, PATCH, POST } from "../../app/api/admin/leads/route";

const req = (body?: unknown) =>
  ({
    headers: { get: () => null },
    json: async () => body,
  }) as unknown as import("next/server").NextRequest;

const LEAD = "leads/20261101-abc.json";

beforeEach(() => {
  state.failList = false;
  state.failGet = false;
  state.failPut = false;
  state.revokeFails = false;
  state.store.clear();
  state.revoked = [];
  state.createdBatches = 0;
  state.store.set(LEAD, {
    id: "20261101-abc",
    email: "a@x.com",
    contact: "c",
    note: "",
    createdAt: "2026-11-01T00:00:00.000Z",
    status: "new",
  });
});

describe("admin leads 通道故障兜底", () => {
  it("GET：dbList 抛错 → 503 且 body 是 JSON {error}", async () => {
    state.failList = true;
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });

  it("POST：dbGet 抛错 → 503 JSON，且不会去生成卡密", async () => {
    state.failGet = true;
    const res = await POST(req({ id: "20261101-abc" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toBeTruthy();
    expect(state.createdBatches).toBe(0);
  });

  it("POST：createBatch 抛错 → 503 JSON", async () => {
    const license = await import("../server/license");
    vi.mocked(license.createBatch).mockRejectedValueOnce(new Error("DB 写入失败（500）"));
    const res = await POST(req({ id: "20261101-abc" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toBeTruthy();
  });

  it("POST：createBatch 成功但 dbPut 失败 → 503 JSON 且补偿作废刚生成的码（不留孤儿码）", async () => {
    state.failPut = true;
    const res = await POST(req({ id: "20261101-abc" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.error).toBeTruthy();
    /* 已作废 → 不回传码；重试安全 */
    expect(body.code).toBeUndefined();
    expect(state.revoked).toEqual(["TRIAL-CODE"]);
  });

  it("POST：dbPut 与作废都失败 → 503 JSON 但仍回传码，供后台人工核销", async () => {
    state.failPut = true;
    state.revokeFails = true;
    const res = await POST(req({ id: "20261101-abc" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.error).toBeTruthy();
    expect(body.code).toBe("TRIAL-CODE");
  });

  it("PATCH：dbGet 抛错 → 503 JSON", async () => {
    state.failGet = true;
    const res = await PATCH(req({ id: "20261101-abc", status: "ignored" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toBeTruthy();
  });

  it("PATCH：dbPut 抛错 → 503 JSON", async () => {
    state.failPut = true;
    const res = await PATCH(req({ id: "20261101-abc", status: "ignored" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toBeTruthy();
  });

  it("正常路径不受影响：PATCH 改状态 200，GET 返回列表", async () => {
    const patch = await PATCH(req({ id: "20261101-abc", status: "ignored" }));
    expect(patch.status).toBe(200);
    const get = await GET(req());
    expect(get.status).toBe(200);
    const body = (await get.json()) as { leads: { status: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.leads[0].status).toBe("ignored");
  });
});
