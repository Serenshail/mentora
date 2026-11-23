import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* GET/PATCH /api/auth/profile 限流回归锁。
 *
 * 历史缺陷：本项目其它用户路由都有 per-user/per-IP 持久桶（login:30、
 * feedback:16、memory:22、reminders:26、change-password:26），唯独 profile
 * 的 GET 和 PATCH 一次 rateLimitPersistent 都没调。PATCH 一次 =
 * verifySession 读 + dbGet + dbPut(gzip+AES) + 档案锁 2 次写，全是共享 KV
 * 配额上的写；一个登录用户开并发脚本即可在半小时量级打穿 D1 免费档日写配额，
 * 之后全站写入（登录建档/同步/注册）集体失败到次日重置——单用户拖垮全站。
 *
 * 本测试**不 mock rate-limit**：真实令牌桶 + 内存 KV 替身，断言的是
 *  1) 未登录不消耗桶（先 verifySession 后限流）；
 *  2) GET 真的过桶（键 profile:get:<userId>，桶落在 rl/<env>/<hash>.json）；
 *  3) PATCH 真的过桶（键 profile:patch:<userId>），超限回 429 且**不产生
 *     用户档案写入**（超限请求不能反过来多烧一次 dbPut）；
 *  4) 桶按 userId 隔离：刷爆 A 不影响 B；
 *  5) 正常操作额度够用（改名/换头像/移除头像连做不误伤）。 */

let store = new Map<string, unknown>();
const { session } = vi.hoisted(() => ({ session: { userId: "", email: "" } }));

vi.mock("../server/db", () => ({
  emailHash: (email: string) =>
    crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24),
  dbGet: vi.fn(async (path: string) => (store.has(path) ? structuredClone(store.get(path)) : null)),
  dbPut: vi.fn(async (path: string, value: unknown) => {
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
  /* 强制走 rate-limit 的远端持久桶分支（否则退化成进程桶，测不到 rl/ 落盘） */
  hasHealthyRemoteDb: vi.fn(() => true),
}));

vi.mock("../server/auth", () => ({
  verifySession: vi.fn(async () =>
    session.userId ? { userId: session.userId, email: session.email, name: "tester", sv: 0 } : null
  ),
  mintSession: vi.fn(async () => undefined),
}));

vi.mock("../server/body-limit", () => ({
  readJsonBody: vi.fn(async (req: { __body?: unknown }) => req.__body ?? {}),
}));

vi.mock("../server/deploy-env", () => ({
  deployEnv: () => "test",
  isDeployed: () => true,
  isProdDeploy: () => false,
}));

import { GET, PATCH } from "../../app/api/auth/profile/route";
import { dbPut } from "../server/db";

const KEY = (email: string) =>
  `users/${crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24)}.json`;
const RL_KEY = (bucket: string) =>
  `rl/test/${crypto.createHash("sha256").update(bucket).digest("hex").slice(0, 32)}.json`;

function seedUser(userId: string, email: string) {
  store.set(KEY(email), {
    userId,
    email,
    name: "oldname",
    salt: "salt",
    hash: "hash",
    createdAt: new Date().toISOString(),
    sv: 0,
  });
}

function as(userId: string, email: string) {
  session.userId = userId;
  session.email = email;
}

const patchReq = (body: Record<string, unknown>) =>
  ({ __body: body, json: async () => body, headers: { get: () => null } }) as unknown as import("next/server").NextRequest;

const patch = (body: Record<string, unknown>) => PATCH(patchReq(body));
const get = () => GET();

beforeEach(() => {
  store = new Map();
  session.userId = "";
  session.email = "";
  vi.mocked(dbPut).mockClear();
});

describe("GET/PATCH /api/auth/profile 限流", () => {
  it("未登录先 401，且不消耗任何限流桶（不写 rl/）", async () => {
    session.userId = "";
    expect((await get()).status).toBe(401);
    expect((await patch({ name: "x" })).status).toBe(401);
    expect([...store.keys()].some((k) => k.startsWith("rl/"))).toBe(false);
  });

  it("GET 过持久桶：键为 profile:get:<userId>，落盘到 rl/<env>/<hash>.json", async () => {
    as("u1", "a@x.com");
    seedUser("u1", "a@x.com");
    expect((await get()).status).toBe(200);
    expect(store.has(RL_KEY("profile:get:u1"))).toBe(true);
  });

  it("PATCH 过持久桶：键为 profile:patch:<userId>", async () => {
    as("u1", "a@x.com");
    seedUser("u1", "a@x.com");
    expect((await patch({ name: "newname" })).status).toBe(200);
    expect(store.has(RL_KEY("profile:patch:u1"))).toBe(true);
  });

  it("PATCH 刷穿容量后 429，且超限请求不再写用户档案", async () => {
    as("u2", "b@x.com");
    seedUser("u2", "b@x.com");

    /* 容量 20：前 20 次放行（回填 20/1800 每秒，测试时长内可忽略） */
    for (let i = 0; i < 20; i++) {
      expect((await patch({ name: `n${i}` })).status).toBe(200);
    }
    vi.mocked(dbPut).mockClear();
    const res = await patch({ name: "should-block" });
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: "操作太频繁，稍后再试" });
    /* 429 之前就返回：没有 users/ 档案写入（否则限流形同虚设，每次被拒仍烧一次配额） */
    expect(vi.mocked(dbPut).mock.calls.some(([p]) => String(p).startsWith("users/"))).toBe(false);
    expect((store.get(KEY("b@x.com")) as { name: string }).name).not.toBe("should-block");
  });

  it("GET 刷穿容量后 429（容量 60），且不返回用户数据", async () => {
    as("u3", "c@x.com");
    seedUser("u3", "c@x.com");
    for (let i = 0; i < 60; i++) expect((await get()).status).toBe(200);
    const res = await get();
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: "操作太频繁，稍后再试" });
  });

  it("桶按 userId 隔离：刷爆 A 不影响 B", async () => {
    as("u4", "d@x.com");
    seedUser("u4", "d@x.com");
    for (let i = 0; i < 20; i++) await patch({ name: `n${i}` });
    expect((await patch({ name: "blocked" })).status).toBe(429);

    as("u5", "e@x.com");
    seedUser("u5", "e@x.com");
    expect((await patch({ name: "fine" })).status).toBe(200);
  });

  it("正常操作额度够用：改称呼 + 换头像 + 移除头像连做不误伤", async () => {
    as("u6", "f@x.com");
    seedUser("u6", "f@x.com");
    expect((await patch({ name: "alice" })).status).toBe(200);
    expect((await patch({ avatar: "data:image/png;base64,AAAA" })).status).toBe(200);
    expect((await patch({ avatar: null })).status).toBe(200);
    expect((await get()).status).toBe(200);
  });
});
