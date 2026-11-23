import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁：删号时邀请码索引必须真的被清掉。
 *
 * 旧实现 dropRefCode(email) 在函数内部读 users/<emailHash>.json 取 refCode，
 * 但两个删号路由都是先 dbDelete 用户档案、再调 dropRefCode——此时档案已删，
 * dbGet 返回 null，`ref/<code>.json` 索引永远不会被删（referral.ts 注释声称要防的
 * 「这个码永远指向不存在的账号」恰恰没防住）。修复：路由在删档案前取 refCode，
 * dropRefCode 直接收 code、不再回读档案。
 *
 * 锁三件事：
 *  1) dropRefCode(code) 直接删索引，完全不读 users/ 档案（无 dbGet）；
 *  2) /api/auth/account DELETE 端到端：档案删掉后 ref/<code>.json 也没了；
 *  3) /api/admin/users DELETE 同口径（后台删号不能留下死码）。 */

const store = new Map<string, unknown>();

const mocks = vi.hoisted(() => ({
  dbGet: vi.fn(),
  dbDelete: vi.fn(),
  dbDeleteDir: vi.fn(),
  dbPut: vi.fn(),
  dbPutIfAbsent: vi.fn(),
  verifySession: vi.fn(),
  verifyPassword: vi.fn(),
  clearSessionCookie: vi.fn(),
  authorizeAdmin: vi.fn(),
  purgePersonalData: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({
  emailHash: (email: string) => `h_${email.trim().toLowerCase()}`,
  dbGet: mocks.dbGet,
  dbPut: mocks.dbPut,
  dbPutIfAbsent: mocks.dbPutIfAbsent,
  dbDelete: mocks.dbDelete,
  dbDeleteDir: mocks.dbDeleteDir,
  dbList: vi.fn(async () => []),
}));
vi.mock("@/lib/server/auth", () => ({
  verifySession: mocks.verifySession,
  verifyPassword: mocks.verifyPassword,
  /* mock 补全（F12 配套）：route 已改用异步版；await 兼容同步布尔返回 */
  verifyPasswordAsync: mocks.verifyPassword,
  clearSessionCookie: mocks.clearSessionCookie,
}));
vi.mock("@/lib/server/admin-auth", () => ({
  authorizeAdmin: mocks.authorizeAdmin,
  /* mock 补全（F7 配套）：users 路由已改用 detailed 版；mocks.authorizeAdmin
   * 在 beforeEach 配置的 {ok:true,email,name} 恰为 detailed 成功形状 */
  authorizeAdminDetailed: mocks.authorizeAdmin,
}));
vi.mock("@/lib/server/config", () => ({ logEvent: vi.fn() }));
vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: async () => true,
  clientIp: () => "198.51.100.7",
}));
vi.mock("@/lib/server/personal", () => ({ purgePersonalData: mocks.purgePersonalData }));

import { dropRefCode } from "../server/referral";
import { DELETE as ACCOUNT_DELETE } from "@/app/api/auth/account/route";
import { DELETE as ADMIN_DELETE } from "@/app/api/admin/users/route";

const EMAIL = "user@example.com";
const USER_PATH = `users/h_${EMAIL}.json`;
const REF_PATH = "ref/ABC23456.json";

const accountReq = () =>
  new Request("http://localhost/api/auth/account", {
    method: "DELETE",
    body: JSON.stringify({ password: "pw" }),
  }) as unknown as Parameters<typeof ACCOUNT_DELETE>[0];

const adminReq = () =>
  new Request("http://localhost/api/admin/users", {
    method: "DELETE",
    body: JSON.stringify({ email: EMAIL }),
  }) as unknown as Parameters<typeof ADMIN_DELETE>[0];

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  mocks.dbGet.mockImplementation(async (key: string) =>
    store.has(key) ? structuredClone(store.get(key)) : null
  );
  mocks.dbDelete.mockImplementation(async (key: string) => {
    store.delete(key);
  });
  mocks.dbDeleteDir.mockResolvedValue(0);
  mocks.dbPut.mockResolvedValue({ sha: "mem" });
  mocks.dbPutIfAbsent.mockResolvedValue(false);
  mocks.verifySession.mockResolvedValue({ email: EMAIL });
  mocks.verifyPassword.mockReturnValue(true);
  mocks.clearSessionCookie.mockResolvedValue(undefined);
  mocks.authorizeAdmin.mockResolvedValue({ ok: true, email: "admin@x.com", name: "admin" });
  mocks.purgePersonalData.mockResolvedValue(undefined);
});

describe("dropRefCode 不再回读用户档案", () => {
  it("收 code 直接删 ref/<CODE>.json，且全程不读 users/（档案已删也照样清）", async () => {
    store.set(REF_PATH, { code: "ABC23456", email: EMAIL, userId: "u1", createdAt: "t" });
    // 档案已删（路由调用时的真实状态）
    expect(store.has(USER_PATH)).toBe(false);

    await dropRefCode("ABC23456");

    expect(store.has(REF_PATH)).toBe(false);
    expect(mocks.dbGet).not.toHaveBeenCalled(); // 旧实现会读 users/ 拿到 null
  });

  it("没有 refCode（老用户/未生成）时是纯 no-op，不抛错也不误删", async () => {
    store.set("ref/OTHER123.json", { code: "OTHER123" });

    await expect(dropRefCode(null)).resolves.toBeUndefined();
    await expect(dropRefCode(undefined)).resolves.toBeUndefined();

    expect(mocks.dbDelete).not.toHaveBeenCalled();
    expect(store.has("ref/OTHER123.json")).toBe(true);
  });
});

describe("删号路由：邀请码索引必须真的被清掉", () => {
  it("/api/auth/account DELETE：删档案前取 refCode，索引不残留", async () => {
    store.set(USER_PATH, { userId: "u1", salt: "s", hash: "h", refCode: "ABC23456" });
    store.set(REF_PATH, { code: "ABC23456", email: EMAIL, userId: "u1", createdAt: "t" });

    const res = await ACCOUNT_DELETE(accountReq());

    expect(res.status).toBe(200);
    expect(store.has(USER_PATH)).toBe(false);
    expect(store.has(REF_PATH)).toBe(false);
    // 索引清理失败也不阻断注销：dropRefCode 内部已吞错
    expect(mocks.purgePersonalData).toHaveBeenCalledWith("u1");
  });

  it("/api/admin/users DELETE：后台删号同样清索引", async () => {
    store.set(USER_PATH, { userId: "u2", email: EMAIL, refCode: "ABC23456" });
    store.set(REF_PATH, { code: "ABC23456", email: EMAIL, userId: "u2", createdAt: "t" });

    const res = await ADMIN_DELETE(adminReq());

    expect(res.status).toBe(200);
    expect(store.has(USER_PATH)).toBe(false);
    expect(store.has(REF_PATH)).toBe(false);
  });

  it("账号没有 refCode 时删号照常成功，且不误删别人的码", async () => {
    store.set(USER_PATH, { userId: "u3", salt: "s", hash: "h" });
    store.set("ref/OTHER123.json", { code: "OTHER123", email: "other@x.com" });

    const res = await ACCOUNT_DELETE(accountReq());

    expect(res.status).toBe(200);
    expect(store.has(USER_PATH)).toBe(false);
    expect(store.has("ref/OTHER123.json")).toBe(true);
  });
});
