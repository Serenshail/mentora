import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* ============ 登录热路径必须用异步 scrypt ============
 * auth.ts 的 verifyPassword 用 crypto.scryptSync（N=16384，单次几十毫秒），放在
 * /api/auth/login 的请求路径上会独占事件循环。限流 10 次/分/IP 挡不住分布式撞库：
 * 数百 IP 并发打登录时 scrypt 串行排队，自托管单进程上全站请求一起卡顿。
 * 修复：新增 verifyPasswordAsync（同参数、同校验逻辑），login 与 device 登录改用它；
 * 不存在邮箱的时序对齐假校验（dummyScryptVerify）也一并改成异步。
 * 本锁钉两件事：
 *  1) 异步版与同步版对同一 salt/hash 判定一致（不能为了异步而改变安全语义）；
 *  2) login 路由实际调用的是异步版（接线回归，防止以后又被改回 sync）。 */

const h = vi.hoisted(() => ({
  asyncCalls: [] as { password: string; salt: string; hash: string }[],
  syncCalls: [] as { password: string }[],
}));

vi.mock("@/lib/server/auth", async () => {
  const crypto = await import("node:crypto");
  return {
    verifyPassword: (password: string, salt: string, hash: string) => {
      h.syncCalls.push({ password });
      const test = crypto.scryptSync(password, salt, 64);
      const saved = Buffer.from(hash, "hex");
      return test.length === saved.length && crypto.timingSafeEqual(test, saved);
    },
    verifyPasswordAsync: async (password: string, salt: string, hash: string) => {
      h.asyncCalls.push({ password, salt, hash });
      const key = await new Promise<Buffer>((resolve, reject) =>
        crypto.scrypt(password, salt, 64, (err, k) => (err ? reject(err) : resolve(k)))
      );
      const saved = Buffer.from(hash, "hex");
      return key.length === saved.length && crypto.timingSafeEqual(key, saved);
    },
    mintSession: vi.fn(async () => {}),
  };
});

const userStore = new Map<string, unknown>();
vi.mock("@/lib/server/db", () => ({
  dbGet: vi.fn(async (path: string) => userStore.get(path) ?? null),
  emailHash: vi.fn((s: string) => `h_${s}`),
}));
vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "198.51.100.13"),
}));
vi.mock("@/lib/server/login-guard", () => ({
  dummyScryptVerify: vi.fn(async () => false),
  getFailState: vi.fn(async () => null),
  bumpFail: vi.fn(async () => {}),
  clearFail: vi.fn(async () => {}),
}));
vi.mock("@/lib/server/entitlement", () => ({
  computeEntitlement: vi.fn(() => ({ status: "active" })),
  setExpiry: vi.fn(async () => ({})),
}));
vi.mock("@/lib/server/referral", () => ({ ensureRefCode: vi.fn(async () => ({})) }));
vi.mock("@/lib/admin-emails", () => ({ isAdminEmail: vi.fn(() => false) }));

import crypto from "node:crypto";
import { verifyPassword, verifyPasswordAsync } from "../server/auth";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import type { NextRequest } from "next/server";

const SALT = "abc123";
const PASSWORD = "correct horse battery staple";
const HASH = crypto.scryptSync(PASSWORD, SALT, 64).toString("hex");

/* readJsonBody 优先走可迭代 body（流式限量闸），没有 body 时退回 json() */
const req = (body: Record<string, unknown>): NextRequest =>
  ({
    headers: new Headers(),
    body: (async function* () {
      yield new TextEncoder().encode(JSON.stringify(body));
    })(),
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as unknown as NextRequest;

beforeEach(() => {
  h.asyncCalls.length = 0;
  h.syncCalls.length = 0;
  userStore.clear();
});

describe("verifyPasswordAsync 与同步版语义一致", () => {
  it("正确密码：两版都判 true", async () => {
    expect(verifyPassword(PASSWORD, SALT, HASH)).toBe(true);
    await expect(verifyPasswordAsync(PASSWORD, SALT, HASH)).resolves.toBe(true);
  });

  it("错误密码：两版都判 false", async () => {
    expect(verifyPassword("wrong", SALT, HASH)).toBe(false);
    await expect(verifyPasswordAsync("wrong", SALT, HASH)).resolves.toBe(false);
  });

  it("畸形 hash（长度不符/非 hex）：异步版不抛，判 false", async () => {
    await expect(verifyPasswordAsync(PASSWORD, SALT, "zz")).resolves.toBe(false);
  });
});

describe("/api/auth/login 接线：走异步 scrypt", () => {
  it("已注册邮箱的登录请求调用 verifyPasswordAsync，不再走同步版", async () => {
    userStore.set(`users/h_${"a@b.c"}.json`, {
      userId: "u1",
      email: "a@b.c",
      name: "A",
      salt: SALT,
      hash: HASH,
    });
    const res = await loginPOST(req({ email: "a@b.c", password: PASSWORD }));
    expect(res.status).toBe(200);
    expect(h.asyncCalls).toHaveLength(1);
    expect(h.syncCalls).toHaveLength(0);
  });

  it("密码错误：仍走异步版（不因失败分支退回同步）", async () => {
    userStore.set(`users/h_${"a@b.c"}.json`, {
      userId: "u1",
      email: "a@b.c",
      name: "A",
      salt: SALT,
      hash: HASH,
    });
    const res = await loginPOST(req({ email: "a@b.c", password: "nope" }));
    expect(res.status).toBe(401);
    expect(h.asyncCalls).toHaveLength(1);
    expect(h.syncCalls).toHaveLength(0);
  });
});
