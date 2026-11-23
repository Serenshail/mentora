import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* ============ 邀请月度上限必须与授予原子化（并发注册潮不得击穿 cap）============
 * 历史缺陷：rewardInviter 锁外读 inviterRec → 基于内存计数判 `recent >= cap`
 * → 再各自 grantDays/appendReferral（各自取锁）。N 个被邀请人并发用同一邀请码注册时
 * 全部读到同一份 referrals、全部通过检查，各 +30 天——上限被并发窗口整体击穿（资损）。
 * 修复：cap 判定与授予收进同一把 withUserLock 临界区（grantDaysLocked 不重复取锁，
 * 避免嵌套死锁）。
 *
 * 内存 KV 替身刻意不消费 sha（dbPut 盲写整档），复刻 KV 通道的真实覆盖语义。 */

let store = new Map<string, unknown>();
const { putIfAbsent } = vi.hoisted(() => ({ putIfAbsent: vi.fn() }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

vi.mock("../server/db", () => ({
  emailHash: (email: string) =>
    crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24),
  dbGet: vi.fn(async (path: string) => (store.has(path) ? structuredClone(store.get(path)) : null)),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    store.set(path, structuredClone(value));
    return { sha: "mem" };
  }),
  dbPutIfAbsent: putIfAbsent,
  dbDelete: vi.fn(async (path: string) => {
    store.delete(path);
  }),
  dbList: vi.fn(async () => []),
}));

import { rewardInviter } from "../server/referral";

const DAY = 86_400_000;
const hash = (email: string) =>
  crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24);
const KEY = (email: string) => `users/${hash(email)}.json`;

interface StoredUser {
  planExpiresAt?: string;
  planHistory?: { licenseId: string; days: number; at: string }[];
  referrals?: { email: string; at: string; rewarded: boolean }[];
}

beforeEach(() => {
  store = new Map();
  putIfAbsent.mockReset();
  putIfAbsent.mockImplementation(async (path: string, value: unknown) => {
    /* 锁键与幂等键共用同一语义：不存在才写。锁在临界区结束时被释放。 */
    if (store.has(path)) return false;
    store.set(path, structuredClone(value));
    return true;
  });
});

afterEach(() => {
  delete process.env.REFERRAL_MONTHLY_CAP;
});

function seedInviter(email: string, code: string) {
  store.set(KEY(email), {
    userId: `u-${email}`,
    email,
    refCode: code,
    salt: "s",
    hash: "h",
    createdAt: new Date().toISOString(),
    sv: 0,
    plan: "month",
    planExpiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
    planHistory: [],
  });
  store.set(`ref/${code}.json`, { code, email, userId: `u-${email}`, createdAt: new Date().toISOString() });
}

describe("rewardInviter：月度上限在并发下不被击穿", () => {
  it("3 个不同被邀请人并发、cap=1 → 只有 1 次结算", async () => {
    const inviter = "cap@x.com";
    seedInviter(inviter, "CAPCODE1");
    process.env.REFERRAL_MONTHLY_CAP = "1";
    const before = Date.parse((store.get(KEY(inviter)) as StoredUser).planExpiresAt!);

    const results = await Promise.all(
      ["a@x.com", "b@x.com", "c@x.com"].map((e) =>
        rewardInviter({ refCode: "CAPCODE1", inviteeEmail: e, inviteeUserId: `u-${e}` })
      )
    );

    expect(results.filter((r) => r.rewarded).length).toBe(1);
    expect(results.filter((r) => r.reason === "ok").length).toBe(1);
    expect(results.filter((r) => r.reason === "capped").length).toBe(2);

    const final = store.get(KEY(inviter)) as StoredUser;
    // 只加了一次月费（+30 天），不是并发那么多次
    expect(Math.round((Date.parse(final.planExpiresAt!) - before) / DAY)).toBe(30);
    expect((final.referrals ?? []).filter((r) => r.rewarded).length).toBe(1);
    expect((final.planHistory ?? []).filter((h) => h.licenseId.startsWith("ref:")).length).toBe(1);
  });

  it("cap=2：4 个并发也恰好只结算 2 次", async () => {
    const inviter = "cap2@x.com";
    seedInviter(inviter, "CAPCODE2");
    process.env.REFERRAL_MONTHLY_CAP = "2";
    const before = Date.parse((store.get(KEY(inviter)) as StoredUser).planExpiresAt!);

    const results = await Promise.all(
      ["e1@x.com", "e2@x.com", "e3@x.com", "e4@x.com"].map((e) =>
        rewardInviter({ refCode: "CAPCODE2", inviteeEmail: e, inviteeUserId: `u-${e}` })
      )
    );

    expect(results.filter((r) => r.rewarded).length).toBe(2);
    const final = store.get(KEY(inviter)) as StoredUser;
    expect(Math.round((Date.parse(final.planExpiresAt!) - before) / DAY)).toBe(60);
  });

  it("并发期间授予的到期时间不被 appendReferral 的整档写回抹掉", async () => {
    const inviter = "cap3@x.com";
    seedInviter(inviter, "CAPCODE3");
    process.env.REFERRAL_MONTHLY_CAP = "10";
    const before = Date.parse((store.get(KEY(inviter)) as StoredUser).planExpiresAt!);

    const results = await Promise.all(
      ["f1@x.com", "f2@x.com"].map(async (e) => {
        await sleep(5); // 让两次调用真的交错
        return rewardInviter({ refCode: "CAPCODE3", inviteeEmail: e, inviteeUserId: `u-${e}` });
      })
    );

    expect(results.every((r) => r.rewarded)).toBe(true);
    const final = store.get(KEY(inviter)) as StoredUser;
    expect(Math.round((Date.parse(final.planExpiresAt!) - before) / DAY)).toBe(60);
    expect((final.referrals ?? []).filter((r) => r.rewarded).length).toBe(2);
  });
});
