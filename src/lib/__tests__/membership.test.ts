import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 会员/卡密核心逻辑：用内存 KV 替身跑，不碰任何远端库。
 * 重点覆盖三件会真出事的事：
 *  1) 同一张码并发兑换只能有一个赢家；
 *  2) 续费在原到期日上累加（不是从今天重置）；
 *  3) 到期判定：到期停 AI、老用户永远不误锁。 */

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
  dbList: vi.fn(async (dir: string) =>
    [...store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .map((k) => ({ name: k.slice(dir.length + 1), sha: "mem" }))
  ),
}));

import { claimLicense, createBatch, revokeLicense, normalizeCode } from "../server/license";
import { computeEntitlement, grantDays } from "../server/entitlement";
import { ensureRefCode, findReferrer, rewardInviter } from "../server/referral";
import { REFERRAL } from "../pricing";

const DAY = 86_400_000;
const userPath = (email: string) => `users/${Buffer.from(email).toString("hex").slice(0, 24)}.json`;

/** 造一个已有 10 天有效期的普通用户 */
function seedUser(email: string, extra: Record<string, unknown> = {}) {
  store.set(userPath(email), {
    userId: `u-${email}`,
    email,
    name: email.split("@")[0],
    salt: "",
    hash: "",
    createdAt: new Date().toISOString(),
    plan: "month",
    planExpiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
    planHistory: [],
    ...extra,
  });
}

beforeEach(() => store.clear());

describe("激活码", () => {
  it("码格式可读且归一化后一致", async () => {
    const { codes } = await createBatch({ count: 3, plan: "month", createdBy: "t" });
    for (const c of codes) {
      expect(c).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
      expect(normalizeCode(c.toLowerCase())).toBe(normalizeCode(c));
    }
  });

  it("同一张码并发兑换只有一个成功", async () => {
    const { codes } = await createBatch({ count: 1, plan: "month", createdBy: "t" });
    const results = await Promise.all(
      ["a@x.com", "b@x.com", "c@x.com"].map((email) =>
        claimLicense(codes[0], { email, userId: email })
      )
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "CLAIMED")).toHaveLength(2);
  });

  it("作废后不能再兑换", async () => {
    const { codes } = await createBatch({ count: 1, plan: "trial", createdBy: "t" });
    await revokeLicense(codes[0]);
    const r = await claimLicense(codes[0], { email: "a@x.com", userId: "u1" });
    expect(r).toMatchObject({ ok: false, reason: "REVOKED" });
  });
});

describe("会员到期", () => {
  it("没有到期时间 = 老用户长期有效（绝不误锁）", () => {
    expect(computeEntitlement({}).status).toBe("legacy");
  });

  it("按剩余天数区分有效 / 即将到期 / 已到期", () => {
    const future = (d: number) => new Date(Date.now() + d * DAY).toISOString();
    expect(computeEntitlement({ planExpiresAt: future(30) }).status).toBe("active");
    expect(computeEntitlement({ planExpiresAt: future(3) }).status).toBe("expiring");
    expect(computeEntitlement({ planExpiresAt: future(-1) }).status).toBe("expired");
  });

  it("过期不足一天也算已到期（ceil 边界不能漏开付费墙）", () => {
    const fourHoursAgo = new Date(Date.now() - 4 * 3600_000).toISOString();
    const ent = computeEntitlement({ planExpiresAt: fourHoursAgo });
    expect(ent.status).toBe("expired");
    expect(ent.daysLeft).toBe(-1);
  });

  it("续费在原到期日上累加，而不是从今天重置", async () => {
    const email = "renew@x.com";
    const end = new Date(Date.now() + 20 * DAY).toISOString();
    store.set(userPath(email), { userId: "u", email, name: "n", salt: "", hash: "", createdAt: "", planExpiresAt: end });

    const ent = await grantDays({ email, userId: "u", days: 30, plan: "month", licenseId: "x" });
    const before = Date.parse(end);
    const after = Date.parse(ent.expiresAt!);
    expect(Math.round((after - before) / DAY)).toBe(30);
  });
});

describe("拉新奖励", () => {
  it("朋友注册后邀请人加一个月", async () => {
    const inviter = "boss@x.com";
    seedUser(inviter);
    const code = await ensureRefCode(inviter, `u-${inviter}`);
    expect(await findReferrer(code)).toMatchObject({ email: inviter });

    const before = Date.parse((store.get(userPath(inviter)) as { planExpiresAt: string }).planExpiresAt);
    const r = await rewardInviter({ refCode: code, inviteeEmail: "friend@x.com", inviteeUserId: "u2" });
    expect(r.rewarded).toBe(true);

    const after = Date.parse((store.get(userPath(inviter)) as { planExpiresAt: string }).planExpiresAt);
    expect(Math.round((after - before) / DAY)).toBe(REFERRAL.rewardDays);
  });

  it("同一个被邀请邮箱只结算一次（幂等）", async () => {
    const inviter = "boss2@x.com";
    seedUser(inviter);
    const code = await ensureRefCode(inviter, `u-${inviter}`);
    const first = await rewardInviter({ refCode: code, inviteeEmail: "friend2@x.com", inviteeUserId: "u3" });
    const second = await rewardInviter({ refCode: code, inviteeEmail: "friend2@x.com", inviteeUserId: "u3" });
    expect(first.rewarded).toBe(true);
    expect(second).toMatchObject({ rewarded: false, reason: "duplicate" });
  });

  it("不能邀请自己", async () => {
    const inviter = "self@x.com";
    seedUser(inviter);
    const code = await ensureRefCode(inviter, `u-${inviter}`);
    const r = await rewardInviter({ refCode: code, inviteeEmail: inviter, inviteeUserId: `u-${inviter}` });
    expect(r).toMatchObject({ rewarded: false, reason: "self" });
  });

  it("老用户（无到期时间）不领奖励", async () => {
    const legacy = "old@x.com";
    store.set(userPath(legacy), {
      userId: `u-${legacy}`, email: legacy, name: "old", salt: "", hash: "", createdAt: new Date().toISOString(),
    });
    const code = await ensureRefCode(legacy, `u-${legacy}`);
    const r = await rewardInviter({ refCode: code, inviteeEmail: "newbie@x.com", inviteeUserId: "u9" });
    expect(r).toMatchObject({ rewarded: false, reason: "legacy" });
  });

  it("邀请码不存在时不发奖励也不报错", async () => {
    const r = await rewardInviter({ refCode: "ZZZZZZZZ", inviteeEmail: "a@x.com", inviteeUserId: "u4" });
    expect(r).toMatchObject({ rewarded: false, reason: "no-inviter" });
  });
});
