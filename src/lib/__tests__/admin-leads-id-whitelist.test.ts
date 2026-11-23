import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* F4 回归锁：admin/leads POST/PATCH 的 id 字符白名单。
 *
 * 历史缺陷：id 只 trim 不校验就拼 leadPath(id)=`leads/${id}.json`。GitHub Contents
 * 通道把整条 path 拼进 api.github.com URL（db.ts remoteResponse），fetch 的 URL
 * 规范化会消解点段——id="../users/<hash>" 即落到 contents/users/<hash>.json，
 * PATCH/POST 可对任意用户档案做读-改-写（把档案数据混进 lead 字段污染档案）。
 * KV 四通道是扁平键、`..` 惰性无害，但校验统一放数据层入口一次兜住（与 personal.ts
 * isValidItemId 同一威胁模型：memory/reminders 已接入，leads 此前漏用）。 */

const state = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  gotPaths: [] as string[],
  putPaths: [] as string[],
}));

vi.mock("../server/db", () => ({
  dbList: vi.fn(async () => []),
  dbGet: vi.fn(async (path: string) => {
    state.gotPaths.push(path);
    return state.store.get(path) ?? null;
  }),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    state.putPaths.push(path);
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
  authorizeAdminDetailed: vi.fn(async () => ({ ok: true, email: "admin@x.com", name: "admin" })),
}));

vi.mock("../server/license", () => ({
  createBatch: vi.fn(async () => ({ codes: ["TRIAL-CODE"], batch: { id: "b1" } })),
  revokeLicense: vi.fn(async () => ({})),
}));

import { PATCH, POST } from "../../app/api/admin/leads/route";

const req = (body?: unknown) =>
  ({
    headers: { get: () => null },
    json: async () => body,
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  state.store.clear();
  state.gotPaths = [];
  state.putPaths = [];
});

describe("admin leads id 白名单", () => {
  it("POST：id=../users/<hash> → 400，不发起任何 dbGet（不越出 leads/）", async () => {
    const res = await POST(req({ id: "../users/5e884898da280471" }));
    expect(res.status).toBe(400);
    expect(state.gotPaths).toEqual([]);
  });

  it("PATCH：../ 点段 / 内嵌斜杠 / 纯点 / 超长 id → 400，不产生任何读写", async () => {
    for (const id of ["../users/abc", "a/b", "..", "a".repeat(81)]) {
      const res = await PATCH(req({ id, status: "ignored" }));
      expect(res.status).toBe(400);
    }
    expect(state.gotPaths).toEqual([]);
    expect(state.putPaths).toEqual([]);
  });

  it("合法 id（trial-request 的 YYYYMMDD-hex 形状）照常进入读取与写入路径", async () => {
    state.store.set("leads/20261101-ab12cd34.json", {
      id: "20261101-ab12cd34", email: "a@x.com", contact: "", note: "",
      createdAt: "2026-11-01T00:00:00.000Z", status: "new",
    });
    const res = await PATCH(req({ id: "20261101-ab12cd34", status: "ignored" }));
    expect(res.status).toBe(200);
    expect(state.gotPaths).toEqual(["leads/20261101-ab12cd34.json"]);
    expect(state.putPaths).toEqual(["leads/20261101-ab12cd34.json"]);
  });
});
