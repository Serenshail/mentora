import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* login-guard.bumpFail 的并发回归锁：
 * 旧实现是「dbGet → n+1 → dbPut」非原子读-改-写。C 个并发失败请求都读到 n=k、
 * 都写回 k+1，实际 C 次尝试只记 1 次——每 IP 令牌桶 burst=10 足以把 10 次猜测
 * 并发打出，FAIL_MAX=8「8 次即锁」被稀释成数十次（多 IP 攻击者连每 IP 桶都绕开）。
 * 修复用 dbPutIfAbsent 做短互斥（纪律同 entitlement.withUserLock）。
 * 这里给内存 KV 每次读写加一点延迟，让交错真实发生；并发 8 次必须累计到 8 并锁定。
 * 另锁两条纪律：锁必须释放（否则后续计数永远降级为无锁）、崩溃遗留的旧锁可接管。 */

const store = new Map<string, unknown>();
/** 每次 KV 往返的模拟延迟：足够让 8 个请求在第一个 dbPut 之前全部读完旧值 */
const KV_DELAY_MS = 3;
const tick = () => new Promise((r) => setTimeout(r, KV_DELAY_MS));

const kvPath = (email: string) =>
  `loginfail/${process.env.DEPLOY_ENV || process.env.VERCEL_ENV || "dev"}/${crypto
    .createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, 24)}.json`;

/** 与 login-guard 的 failLockPath 同形（挂在 loginfail/ 前缀下复用 DCS 的 30min TTL） */
const lockPathOf = (email: string) => kvPath(email).replace(/\/[^/]+\.json$/, `/lock/${kvPath(email).split("/").pop()}`);

vi.mock("../server/db", () => ({
  emailHash: (email: string) =>
    crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24),
  dbGet: vi.fn(async (path: string) => {
    await tick();
    return store.has(path) ? structuredClone(store.get(path)) : null;
  }),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    await tick();
    store.set(path, structuredClone(value));
    return { sha: "mem" };
  }),
  /* 原子占位：检查与写入之间不 await，等价于 Redis SET NX / D1 INSERT ... DO NOTHING */
  dbPutIfAbsent: vi.fn(async (path: string, value: unknown) => {
    await tick();
    if (store.has(path)) return false;
    store.set(path, structuredClone(value));
    return true;
  }),
  dbDelete: vi.fn(async (path: string) => {
    await tick();
    store.delete(path);
  }),
  dbList: vi.fn(async () => []),
}));

vi.mock("../server/auth", () => ({
  verifyPassword: () => false,
  verifySession: async () => null,
}));

import { bumpFail, clearFail, getFailState, FAIL_MAX } from "../server/login-guard";

const lockKeys = () => [...store.keys()].filter((k) => k.includes("/lock/"));

beforeEach(() => {
  store.clear();
});

describe("bumpFail 并发计数（非原子读-改-写回归）", () => {
  it("8 个并发失败必须记满 8 并锁定，不得退化成 1", async () => {
    const email = "race@x.dev";
    await Promise.all(Array.from({ length: FAIL_MAX }, () => bumpFail(email)));
    const st = await getFailState(email);
    expect(st?.n).toBe(FAIL_MAX); // 旧实现这里会是 1
    expect(st?.until ?? 0).toBeGreaterThan(Date.now());
  });

  it("并发结束后不残留计数锁：后续计数照常累加", async () => {
    const email = "release@x.dev";
    await Promise.all(Array.from({ length: 4 }, () => bumpFail(email)));
    expect(lockKeys()).toHaveLength(0); // 持锁方必须在 finally 释放
    await bumpFail(email);
    expect((await getFailState(email))?.n).toBe(5);
  });

  it("崩溃遗留的旧锁（超 stale）可被接管，不阻塞计数", async () => {
    const email = "stale@x.dev";
    store.set(lockPathOf(email), { at: Date.now() - 60_000 }); // 远超 FAIL_LOCK_STALE_MS
    await bumpFail(email);
    expect((await getFailState(email))?.n).toBe(1);
  });

  it("clearFail 仍只清计数（登录成功后解锁）", async () => {
    const email = "clear@x.dev";
    await bumpFail(email);
    await clearFail(email);
    expect(await getFailState(email)).toBeNull();
  });
});
