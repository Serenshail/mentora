import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁：套餐查找不得走原型链。
 *  - planOf 此前是 `id in PLANS`：planOf("constructor") 返回 Function、
 *    planOf("__proto__") 返回 Object.prototype，再被 `as PlanId` 断言成 PlanInfo，
 *    调用方取 .days/.price 得到 undefined。
 *  - 同一个 `in` 模式还抄在 membership/page.tsx、admin/members、admin/licenses
 *    三处，ent.plan / body.plan 都来自用户/外部后台输入。
 * 锁四件事：
 *  1) planOf 对 PLANS 的每个真实 key 返回对应 PlanInfo，非 key 一律 null；
 *  2) 原型链键（constructor/toString/__proto__/hasOwnProperty/valueOf）全部 null；
 *  3) admin/licenses 收到 plan="constructor"/"__proto__" → 400 且不落库；
 *  4) admin/members 收到 plan="constructor" → 不改写用户档案里的 plan；
 *  5) createBatch 纵深防御：即便路由层漏校验，原型链键也抛「套餐不存在」。
 * 不 mock server/license：走真 createBatch 才能验证第 3、5 条（旧实现会真的
 * 写出 batch 记录，store.size 因此不为 0）。 */

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

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("../server/admin-auth", () => ({
  authorizeAdmin: vi.fn(async () => ({ ok: true, email: "admin@x.com", name: "admin" })),
  /* mock 补全（F7 配套）：route 已改用 detailed 版，返回同一 ok 对象 */
  authorizeAdminDetailed: vi.fn(async () => ({ ok: true, email: "admin@x.com", name: "admin" })),
}));

vi.mock("../server/reset-code", () => ({
  issueResetCode: vi.fn(async () => ({ code: "AAAA-BBBB", expiresAt: Date.now() + 86_400_000 })),
}));

import { PLANS, PLAN_ORDER, planOf } from "../pricing";
import { createBatch } from "../server/license";
import { POST as licensesPOST } from "../../app/api/admin/licenses/route";
import { POST as membersPOST } from "../../app/api/admin/members/route";

const req = (body: Record<string, unknown>) =>
  ({
    json: async () => body,
    headers: { get: () => null },
  }) as unknown as import("next/server").NextRequest;

const userPath = (email: string) => `users/${Buffer.from(email).toString("hex").slice(0, 24)}.json`;
const DAY = 86_400_000;

beforeEach(() => store.clear());

describe("planOf 只认自有键", () => {
  it("PLANS 的每个真实 key 都返回对应 PlanInfo", () => {
    for (const id of PLAN_ORDER) {
      expect(planOf(id)).toEqual(PLANS[id]);
    }
    // 真实 key 集合与 PLAN_ORDER 一致（防止新增套餐漏登记）
    expect(Object.keys(PLANS).sort()).toEqual([...PLAN_ORDER].sort());
  });

  it("原型链属性名一律返回 null（in 会命中的那批）", () => {
    for (const evil of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
      expect(planOf(evil)).toBeNull();
    }
  });

  it("空值/未知值返回 null", () => {
    for (const v of [undefined, null, "", "MONTH", "month ", "trial "]) {
      expect(planOf(v as string | null | undefined)).toBeNull();
    }
  });
});

describe("admin/licenses：外部 plan 不得穿原型链", () => {
  it("plan=constructor → 400，且没有写出任何批次记录", async () => {
    const res = await licensesPOST(req({ plan: "constructor" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "套餐不存在" });
    expect(store.size).toBe(0);
  });

  it("plan=__proto__ → 400，且没有写出任何批次记录", async () => {
    const res = await licensesPOST(req({ plan: "__proto__" }));
    expect(res.status).toBe(400);
    expect(store.size).toBe(0);
  });

  it("缺省 plan 仍按 month 生成（成功路径不被误伤）", async () => {
    const res = await licensesPOST(req({ count: 1 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; batch: { plan: string } };
    expect(body.batch.plan).toBe("month");
    expect(store.size).toBeGreaterThan(0);
  });
});

describe("admin/members：外部 plan 不得写进用户档案", () => {
  it("extend 带 plan=constructor → 档案 plan 保持原值", async () => {
    const email = "u@example.com";
    store.set(userPath(email), {
      userId: "u-1",
      email,
      name: "u",
      createdAt: new Date().toISOString(),
      plan: "month",
      planExpiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
      planHistory: [],
    });

    const res = await membersPOST(req({ action: "extend", email, days: 30, plan: "constructor" }));
    expect(res.status).toBe(200);

    const rec = store.get(userPath(email)) as { plan?: string };
    expect(rec.plan).toBe("month");
  });
});

describe("createBatch 纵深防御", () => {
  it("原型链键直接抛「套餐不存在」，不会算出 NaN 天", async () => {
    await expect(
      createBatch({ count: 1, plan: "constructor" as never, createdBy: "test" })
    ).rejects.toThrow("套餐不存在");
    expect(store.size).toBe(0);
  });
});
