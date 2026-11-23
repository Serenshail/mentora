import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* 后台会员管理路由的 404 回归锁：
 * extend/setExpiry/revoke 对档案不存在的邮箱会 throw「账号不存在」
 * （entitlement.ts grantDays/setExpiry/extendMembership 里的 if (!rec) throw），
 * 路由不先判存在性就把 throw 顶上去，变成无 JSON 错误体的裸 500。
 * 锁三件事：
 *  1) 邮箱不存在（手误/刚删除）→ 404 JSON，不再是裸 500；
 *  2) 邮箱存在 → 照常写库返回 ok，存量成功路径不被 404 误伤；
 *  3) 读库没问题但写库真故障 → 503 JSON，能和「邮箱写错」区分开。 */

const store = new Map<string, unknown>();
let failPut = false;

vi.mock("../server/db", () => ({
  emailHash: (email: string) =>
    crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24),
  dbGet: vi.fn(async (path: string) => (store.has(path) ? structuredClone(store.get(path)) : null)),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    if (failPut) throw new Error("kv unavailable");
    store.set(path, structuredClone(value));
    return { sha: "mem" };
  }),
  dbPutIfAbsent: vi.fn(async (path: string, value: unknown) => {
    if (store.has(path)) return false;
    store.set(path, structuredClone(value));
    return true;
  }),
  dbDelete: vi.fn(async (path: string) => {
    store.delete(path);
  }),
  dbList: vi.fn(async () => []),
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

vi.mock("../server/reset-code", () => ({
  issueResetCode: vi.fn(async () => ({ code: "AAAA-BBBB", expiresAt: Date.now() + 86_400_000 })),
}));

import { POST } from "../../app/api/admin/members/route";

const KEY = (email: string) =>
  `users/${crypto.createHash("sha256").update(email).digest("hex").slice(0, 24)}.json`;
const DAY = 86_400_000;

function seedUser(email: string) {
  store.set(KEY(email), {
    userId: `u-${email}`,
    email,
    name: email.split("@")[0],
    salt: "",
    hash: "",
    createdAt: new Date().toISOString(),
    plan: "month",
    planExpiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
    planHistory: [],
  });
}

const req = (body: Record<string, unknown>) =>
  ({
    json: async () => body,
    headers: { get: () => null },
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  store.clear();
  failPut = false;
});

describe("admin members 路由", () => {
  it("extend：账号不存在 → 404 JSON（不是裸 500）", async () => {
    const res = await POST(req({ action: "extend", email: "ghost@x.com", days: 30 }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "账号不存在" });
  });

  it("setExpiry：账号不存在 → 404", async () => {
    const res = await POST(req({ action: "setExpiry", email: "nope@x.com", expiresAt: new Date().toISOString() }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "账号不存在" });
  });

  it("revoke：账号不存在 → 404", async () => {
    const res = await POST(req({ action: "revoke", email: "ghost2@x.com" }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "账号不存在" });
  });

  it("issueResetCode：账号不存在 → 404（口径与旧实现一致）", async () => {
    const res = await POST(req({ action: "issueResetCode", email: "ghost3@x.com" }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "账号不存在" });
  });

  it("extend：账号存在 → 照常 200 并真的把到期时间延长", async () => {
    const email = "live@x.com";
    seedUser(email);
    const res = await POST(req({ action: "extend", email, days: 30 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; entitlement: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.entitlement.status).toBe("active");
    expect((store.get(KEY(email)) as { planExpiresAt: string }).planExpiresAt).toBeTruthy();
  });

  it("revoke：账号存在 → 200 且到期时间被拨到过去", async () => {
    const email = "live2@x.com";
    seedUser(email);
    const res = await POST(req({ action: "revoke", email }));
    expect(res.status).toBe(200);
    expect((store.get(KEY(email)) as { planExpiresAt: string }).planExpiresAt).toBeTruthy();
  });

  it("读库正常但写库故障 → 503 JSON，可与邮箱写错区分", async () => {
    const email = "live3@x.com";
    seedUser(email);
    failPut = true;
    const res = await POST(req({ action: "extend", email, days: 30 }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "写入失败，请稍后再试" });
  });

  it("未知操作 → 400（try 块之外仍生效）", async () => {
    const res = await POST(req({ action: "whatever", email: "live4@x.com" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "未知操作" });
  });

  it("extend：非法天数 → 400 校验仍生效", async () => {
    const email = "live5@x.com";
    seedUser(email);
    const res = await POST(req({ action: "extend", email, days: 9999 }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "天数需在 1-3650 之间" });
  });
});
