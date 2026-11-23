import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁：/api/referral 响应不得把被邀请者的完整邮箱 PII 原样返回给邀请人。
 * referralSummary 的 list 只允许出掩码邮箱（a***@gmail.com），
 * 且脱敏只发生在出口——库存 referrals 记录仍保留原始邮箱（审计口径不变）。
 * 锁四件事：
 *  1) GET /api/referral 返回的 list.email 是掩码，整个响应体里搜不到完整邮箱；
 *  2) 摘要数字（invited / rewardedCount / rewardedDays / refCode）不受脱敏影响；
 *  3) 库存记录未被改写，仍是原始邮箱（只遮出口，不动存储）；
 *  4) 畸形邮箱（无 local / 无 domain）走兜底 "***"，不抛异常。 */

const store = new Map<string, unknown>();

vi.mock("../server/db", () => ({
  emailHash: (email: string) => Buffer.from(email.toLowerCase()).toString("hex").slice(0, 24),
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
}));

vi.mock("../server/auth", () => ({
  verifySession: vi.fn(async () => ({ email: "inviter@x.com", userId: "u-inviter" })),
}));

import { GET } from "../../app/api/referral/route";
import { referralSummary } from "../server/referral";

const DAY = 86_400_000;
const userPath = (email: string) => `users/${Buffer.from(email.toLowerCase()).toString("hex").slice(0, 24)}.json`;

function seedInviter(referrals: { email: string; at: string; rewarded: boolean }[]) {
  store.set(userPath("inviter@x.com"), {
    userId: "u-inviter",
    email: "inviter@x.com",
    name: "inviter",
    salt: "",
    hash: "",
    createdAt: new Date().toISOString(),
    plan: "month",
    planExpiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
    planHistory: [],
    refCode: "TESTCODE1",
    referrals,
  });
}

beforeEach(() => store.clear());

describe("referral 邮箱脱敏", () => {
  it("GET /api/referral：list.email 全部掩码，响应体搜不到任何完整被邀请邮箱", async () => {
    seedInviter([
      { email: "alice@gmail.com", at: new Date(Date.now() - DAY).toISOString(), rewarded: true },
      { email: "bob2026@outlook.com", at: new Date(Date.now() - 2 * DAY).toISOString(), rewarded: false },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    const raw = JSON.stringify(body);

    expect(raw).not.toContain("alice@gmail.com");
    expect(raw).not.toContain("bob2026@outlook.com");
    expect(body.list.map((r: { email: string }) => r.email)).toEqual([
      "b***@outlook.com",
      "a***@gmail.com",
    ]);
  });

  it("摘要数字不受脱敏影响：invited/rewardedCount/rewardedDays/refCode 照常", async () => {
    seedInviter([
      { email: "alice@gmail.com", at: new Date().toISOString(), rewarded: true },
      { email: "bob@x.com", at: new Date().toISOString(), rewarded: false },
    ]);

    const res = await GET();
    const body = await res.json();
    expect(body.refCode).toBe("TESTCODE1");
    expect(body.invited).toBe(2);
    expect(body.rewardedCount).toBe(1);
    expect(body.rewardedDays).toBe(body.rewardedCount * body.rewardDays);
  });

  it("脱敏只在出口：库存 referrals 记录仍是原始邮箱（审计口径不变）", async () => {
    seedInviter([{ email: "alice@gmail.com", at: new Date().toISOString(), rewarded: true }]);

    await referralSummary("inviter@x.com", "u-inviter");
    const stored = store.get(userPath("inviter@x.com")) as { referrals: { email: string }[] };
    expect(stored.referrals[0].email).toBe("alice@gmail.com");
  });

  it("畸形邮箱兜底为三颗星，不抛异常；summary 直调与路由出口一致", async () => {
    seedInviter([
      { email: "@nodomain", at: new Date().toISOString(), rewarded: false },
      { email: "nolocal@", at: new Date().toISOString(), rewarded: false },
    ]);

    const summary = await referralSummary("inviter@x.com", "u-inviter");
    expect(summary.list.map((r) => r.email)).toEqual(["***", "***"]);

    const res = await GET();
    const body = await res.json();
    expect(body.list.map((r: { email: string }) => r.email)).toEqual(["***", "***"]);
  });
});
