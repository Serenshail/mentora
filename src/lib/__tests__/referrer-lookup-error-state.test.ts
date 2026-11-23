import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* ============ findReferrer：存储故障必须抛出，不能吞成 null ============
 * 历史缺陷：findReferrer 捕获所有 dbGet 异常并 return null；注册路由把 null 当
 * 「没填/无效」——用户档案不落 invitedBy、奖励静默永久丢失（rewardInviter 全仓只剩
 * 注册这一个调用点、invitedBy 无任何后续补结算路径）。修复：故障抛出（错误态），
 * 「码不存在」才返回 null（空态）；rewardInviter 把故障单独映射为 reason "error"。 */

let failRefRead = false;
let refIndex: unknown = null;

vi.mock("../server/db", () => ({
  emailHash: (email: string) =>
    crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24),
  dbGet: vi.fn(async (path: string) => {
    if (path.startsWith("ref/")) {
      if (failRefRead) throw new Error("KV 5xx");
      return refIndex;
    }
    return null;
  }),
  dbPut: vi.fn(async () => ({ sha: "mem" })),
  dbPutIfAbsent: vi.fn(async () => true),
  dbDelete: vi.fn(async () => {}),
  dbList: vi.fn(async () => []),
}));

import { findReferrer, rewardInviter } from "../server/referral";

beforeEach(() => {
  failRefRead = false;
  refIndex = null;
});

describe("findReferrer：错误态 vs 空态", () => {
  it("存储故障 → 抛出（不返回 null）", async () => {
    failRefRead = true;
    await expect(findReferrer("CODE1234")).rejects.toThrow();
  });

  it("码不存在（dbGet 返回 null）→ null", async () => {
    refIndex = null;
    expect(await findReferrer("CODE1234")).toBeNull();
  });

  it("码太短直接 null（不触存储）", async () => {
    failRefRead = true;
    expect(await findReferrer("AB")).toBeNull();
  });

  it("找得到 → 返回索引", async () => {
    refIndex = { code: "CODE1234", email: "boss@x.com", userId: "u1", createdAt: "x" };
    expect(await findReferrer("CODE1234")).toMatchObject({ email: "boss@x.com" });
  });
});

describe("rewardInviter：存储故障与「没邀请人」不可混同", () => {
  it("查邀请人时存储故障 → reason error", async () => {
    failRefRead = true;
    const r = await rewardInviter({ refCode: "CODE1234", inviteeEmail: "a@x.com", inviteeUserId: "u2" });
    expect(r).toMatchObject({ rewarded: false, reason: "error" });
  });

  it("码不存在 → reason no-inviter", async () => {
    refIndex = null;
    const r = await rewardInviter({ refCode: "NOPE1234", inviteeEmail: "a@x.com", inviteeUserId: "u2" });
    expect(r).toMatchObject({ rewarded: false, reason: "no-inviter" });
  });
});
