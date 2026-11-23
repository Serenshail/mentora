import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* withUserLock 回归锁（entitlement.ts）：并发兑换靠它串行化读-改-写。
 * 历史缺陷：3 次抢锁失败后 held=false 仍无条件裸跑 fn()，与「持锁方已超时
 * 才接管」的注释不符——同账号双端并发兑换时双方各自读旧 planExpiresAt 加时，
 * 后写覆盖先写，一方天数静默丢失（资损）。锁三连失败必须抛错而非裸跑。
 * 顺带锁住接管纪律：只有读到锁且时间戳证明已超时（或读到损坏残留）才允许
 * 删锁接管；PutIfAbsent=false 而 dbGet 读失败（prev=null）时绝不能删活锁。
 * 覆盖 grantDays / setExpiry / extendMembership 三个真实入口。 */

const store = new Map<string, unknown>();

/* 内存 KV 替身（口径同 membership.test.ts），三个原语均记调用次数供断言 */
const calls = { putIfAbsent: 0, put: 0, del: 0 };

vi.mock("../server/db", () => ({
  emailHash: (email: string) => Buffer.from(email.toLowerCase()).toString("hex").slice(0, 24),
  dbGet: vi.fn(async (path: string) => (store.has(path) ? structuredClone(store.get(path)) : null)),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    store.set(path, structuredClone(value));
    return { sha: "mem" };
  }),
  dbPutIfAbsent: vi.fn(async (path: string, value: unknown) => {
    calls.putIfAbsent++;
    if (store.has(path)) return false;
    store.set(path, structuredClone(value));
    return true;
  }),
  dbDelete: vi.fn(async (path: string) => {
    calls.del++;
    store.delete(path);
  }),
  dbList: vi.fn(async () => []),
}));

import { extendMembership, grantDays, setExpiry } from "../server/entitlement";

const DAY = 86_400_000;
const userPath = (email: string) => `users/${Buffer.from(email).toString("hex").slice(0, 24)}.json`;
const lockPath = (email: string) => `lock/sub/${Buffer.from(email).toString("hex").slice(0, 24)}.json`;

function seedUser(email: string, daysLeft: number) {
  store.set(userPath(email), {
    userId: "u",
    email,
    name: "n",
    salt: "",
    hash: "",
    createdAt: "",
    plan: "month",
    planExpiresAt: new Date(Date.now() + daysLeft * DAY).toISOString(),
    planHistory: [],
  });
}

beforeEach(() => {
  store.clear();
  calls.putIfAbsent = 0;
  calls.put = 0;
  calls.del = 0;
});

/** 占住某账号的锁（不释放）：模拟另一请求正在持锁处理中 */
function holdLock(email: string) {
  store.set(lockPath(email), { at: Date.now() });
}

describe("withUserLock：抢不到锁绝不裸跑", () => {
  it("grantDays：锁被活持锁方占住 3 轮 → 抛错，绝不无锁读写档案", async () => {
    const email = "busy@x.com";
    seedUser(email, 20);
    const before = (store.get(userPath(email)) as { planExpiresAt: string }).planExpiresAt;
    holdLock(email); // at = Date.now()，非 stale

    await expect(
      grantDays({ email, userId: "u", days: 30, plan: "month", licenseId: "L1" })
    ).rejects.toThrow("会员档案锁占用中");

    // 档案一个字节都没被碰：裸跑缺陷下这里会读到旧值并加 30 天
    const after = (store.get(userPath(email)) as { planExpiresAt: string }).planExpiresAt;
    expect(after).toBe(before);
    expect((store.get(userPath(email)) as { planHistory?: unknown[] }).planHistory).toHaveLength(0);
    // 恰好 3 次尝试后放弃，且从未释放过别人的活锁
    expect(calls.putIfAbsent).toBe(3);
    expect(calls.del).toBe(0);
  });

  it("setExpiry / extendMembership 同纪律：抢不到锁 → 抛错不写", async () => {
    const a = "busy2@x.com";
    seedUser(a, 20);
    holdLock(a);
    await expect(setExpiry(a, new Date(Date.now() + 99 * DAY).toISOString())).rejects.toThrow();
    expect((store.get(userPath(a)) as { planExpiresAt: string }).planExpiresAt).toBe(
      (store.get(userPath(a)) as { planExpiresAt: string }).planExpiresAt
    );
    expect((store.get(userPath(a)) as { planHistory?: unknown[] }).planHistory).toHaveLength(0);

    const b = "busy3@x.com";
    seedUser(b, 20);
    holdLock(b);
    const before = (store.get(userPath(b)) as { planExpiresAt: string }).planExpiresAt;
    await expect(extendMembership(b, 30)).rejects.toThrow();
    expect((store.get(userPath(b)) as { planExpiresAt: string }).planExpiresAt).toBe(before);
    expect(calls.del).toBe(0); // 两个账号都没动过别人的锁
  });

  it("锁空闲时照常拿到锁执行并释放（不误伤正常路径）", async () => {
    const email = "free@x.com";
    seedUser(email, 10);
    const ent = await grantDays({ email, userId: "u", days: 30, plan: "month", licenseId: "L2" });
    expect(ent.status).toBe("active");
    expect((store.get(userPath(email)) as { planHistory?: { licenseId: string; days: number }[] }).planHistory).toEqual([
      { licenseId: "L2", days: 30, at: expect.any(String) },
    ]);
    // 执行完锁必须释放
    expect(store.has(lockPath(email))).toBe(false);
    expect(calls.del).toBe(1);
  });

  it("竞争在重试预算内结束（持锁方 ~400ms 后释放）→ 稍后拿到锁正常串行执行", async () => {
    const email = "serial@x.com";
    seedUser(email, 10);
    holdLock(email);
    // 实际抢锁时点 ≈ 0/250/750ms（第三次 sleep 后循环即退出）：400ms 释放
    // 必被 750ms 那轮等到。这是「持锁方只是慢不是死」的正常串行化路径，
    // 修复不得把它误伤成永远抛错。
    const timer = setTimeout(() => store.delete(lockPath(email)), 400);
    const ent = await grantDays({ email, userId: "u", days: 30, plan: "month", licenseId: "L5" });
    clearTimeout(timer);
    expect(ent.status).toBe("active");
    const rec = store.get(userPath(email)) as { planHistory: { licenseId: string }[] };
    expect(rec.planHistory).toEqual([{ licenseId: "L5", days: 30, at: expect.any(String) }]);
    expect(store.has(lockPath(email))).toBe(false);
  });

  it("竞争超过重试预算（持锁方 2s 后才释放）→ 抛错，绝不无锁裸跑（回归主缺陷）", async () => {
    const email = "slow@x.com";
    seedUser(email, 10);
    const before = (store.get(userPath(email)) as { planExpiresAt: string }).planExpiresAt;
    holdLock(email);
    const timer = setTimeout(() => store.delete(lockPath(email)), 2000);
    // 3 轮抢锁（~0/250/750ms）全部落空且持锁方未走完：修复前这里裸跑 fn()，
    // 读到旧 planExpiresAt 各自加时、后写覆盖先写；修复后必须抛错交调用方兜底。
    await expect(
      grantDays({ email, userId: "u", days: 30, plan: "month", licenseId: "L6" })
    ).rejects.toThrow("会员档案锁占用中");
    clearTimeout(timer);
    // 抛错前档案分毫未动（裸跑缺陷下这里已 +30 天）
    expect((store.get(userPath(email)) as { planExpiresAt: string }).planExpiresAt).toBe(before);
    expect((store.get(userPath(email)) as { planHistory?: unknown[] }).planHistory).toHaveLength(0);
    // 全程没删过别人的锁
    expect(calls.del).toBe(0);
  });

  it("接管纪律：PutIfAbsent=false 但 dbGet 读失败（prev=null）→ 不删活锁，不接管", async () => {
    const email = "ghost@x.com";
    seedUser(email, 20);
    holdLock(email);
    // 让锁读持续失败：prev=null 在旧实现里等价于「无 at → stale → 删锁」，
    // 会把别人的活锁删掉再裸跑；修复后必须按「锁仍被占」处理并抛错。
    const dbGet = await import("../server/db");
    vi.mocked(dbGet.dbGet).mockImplementation(async (path: string): Promise<{ _sha?: string } | null> => {
      if (String(path).startsWith("lock/")) throw new Error("kv down");
      return store.has(path) ? (structuredClone(store.get(path)) as { _sha?: string }) : null;
    });

    await expect(
      grantDays({ email, userId: "u", days: 30, plan: "month", licenseId: "L3" })
    ).rejects.toThrow("会员档案锁占用中");

    // 活锁原封不动，档案未被无锁改写
    expect(store.has(lockPath(email))).toBe(true);
    expect(
      (store.get(userPath(email)) as { planExpiresAt: string }).planExpiresAt
    ).toBe((store.get(userPath(email)) as { planExpiresAt: string }).planExpiresAt);
    expect(calls.del).toBe(0);
    vi.mocked(dbGet.dbGet).mockRestore();
  });

  it("接管纪律：锁确实是 stale（超过 30s）→ 允许删锁接管后正常执行", async () => {
    const email = "stale@x.com";
    seedUser(email, 20);
    store.set(lockPath(email), { at: Date.now() - 31_000 }); // 崩溃遗留
    const ent = await grantDays({ email, userId: "u", days: 5, plan: "month", licenseId: "L4" });
    expect(ent.status).toBe("active");
    expect(store.has(lockPath(email))).toBe(false);
  });
});
