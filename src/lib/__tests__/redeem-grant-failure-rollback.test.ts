import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* 回归锁：/api/subscription/redeem 的「写时长失败 → 把码还回去」补偿必须真的生效。
 * 修复前 claimLicense 在返回 ok 之前就已把码写成 used（license.ts:227），而旧版
 * releaseClaim 只在 status==="unused" 时才删占用标记（license.ts:246-248）——
 * redeem 路由 catch 里的 releaseClaim 是恒空操作：grantDays 抛错后码仍是 used、
 * 占用标记还在、天数没加上，用户重试同一张码只会拿到 409「这张激活码已经被使用过了」，
 * 付费码被烧掉且产品内无自助恢复（后台只有 revoke，没有复位 unused）。
 * 本文件从路由入口钉住三件事：
 *  A) grantDays 抛错 → 503，且码回到 unused、占用标记清空、同邮箱可立刻重试成功；
 *  B) 入账成功时码保持 used（补偿绝不能误退，否则一码兑两次）；
 *  C) 已兑过的码再兑仍是 409，错误文案就是用户看到的「已经被使用过」。 */

const store = new Map<string, unknown>();

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
}));

/* 会话必须 mock：真实 verifySession 走 next/headers cookies()，单测无请求上下文必抛 */
vi.mock("../server/auth", () => ({
  verifySession: vi.fn(async () => ({ userId: "u-a@x.com", email: "a@x.com", name: "tester", sv: 0 })),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(() => false),
  mintSession: vi.fn(async () => undefined),
}));

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

import { POST } from "../../app/api/subscription/redeem/route";
import { claimLicense, createBatch, getLicense, normalizeCode } from "../server/license";

const codeHash = (raw: string) => crypto.createHash("sha256").update(normalizeCode(raw)).digest("hex");
const licensePath = (code: string) => `licenses/${codeHash(code)}.json`;
const claimPath = (code: string) => `claim/${codeHash(code)}.json`;
const userPath = (email: string) =>
  `users/${crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24)}.json`;
const DAY = 86_400_000;

const req = (body: Record<string, unknown>) =>
  ({
    json: async () => body,
    headers: { get: () => null },
  }) as unknown as import("next/server").NextRequest;

/** 有账号、有效期还剩 10 天的普通会员（grantDays 需要读到档案才不抛「账号不存在」） */
function seedUser(email: string, extra: Record<string, unknown> = {}) {
  store.set(userPath(email), {
    userId: `u-${email}`,
    email,
    name: "tester",
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

describe("redeem 写时长失败的补偿（付费码不被烧）", () => {
  it("grantDays 抛错 → 503，码回到 unused、占用标记清空、同码可立刻重试", async () => {
    const { codes } = await createBatch({ count: 1, plan: "month", createdBy: "t" });
    const code = codes[0];
    /* 不 seed 用户档案：grantDays 读到 null 会抛「账号不存在」，等价于写时长失败。
     * 此时 claimLicense 已成功（码已被标 used + 占用标记已写）。 */
    expect(store.has(userPath("a@x.com"))).toBe(false);

    const res = await POST(req({ code }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "续费写入失败，请稍后再试" });

    /* 补偿必须真的把码还原（修复前这里仍是 used，且标记还在） */
    const rec = await getLicense(code);
    expect(rec?.status).toBe("unused");
    expect(rec?.usedBy).toBeNull();
    expect(store.has(claimPath(code))).toBe(false);

    /* 关键回归断言：用户拿同一张码重试能成功（修复前返回 USED → 路由 409） */
    const retry = await claimLicense(code, { email: "a@x.com", userId: "u-a@x.com" });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.license.status).toBe("used");
  });

  it("重试路径端到端可用：补建账号后同一张码能真正加上时长", async () => {
    const { codes } = await createBatch({ count: 1, plan: "month", createdBy: "t" });
    const code = codes[0];

    const failed = await POST(req({ code }));
    expect(failed.status).toBe(503);

    seedUser("a@x.com");
    const before = Date.parse((store.get(userPath("a@x.com")) as { planExpiresAt: string }).planExpiresAt);

    const ok = await POST(req({ code }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; days: number };
    expect(body.ok).toBe(true);
    expect(body.days).toBe(30);

    const after = Date.parse((store.get(userPath("a@x.com")) as { planExpiresAt: string }).planExpiresAt);
    expect(Math.round((after - before) / DAY)).toBe(30);
    /* 入账后码保持 used，不能因为补偿逻辑被误退 */
    expect((await getLicense(code))?.status).toBe("used");
    expect((await getLicense(code))?.usedBy?.email).toBe("a@x.com");
  });

  it("入账成功的码再兑一次仍 409，绝不重复加时（补偿不能误退）", async () => {
    const { codes } = await createBatch({ count: 1, plan: "month", createdBy: "t" });
    const code = codes[0];
    seedUser("a@x.com");

    const first = await POST(req({ code }));
    expect(first.status).toBe(200);
    const afterFirst = Date.parse((store.get(userPath("a@x.com")) as { planExpiresAt: string }).planExpiresAt);

    const second = await POST(req({ code }));
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({ error: "这张激活码已经被使用过了" });

    /* 天数没有被第二次请求改动 */
    const afterSecond = Date.parse((store.get(userPath("a@x.com")) as { planExpiresAt: string }).planExpiresAt);
    expect(afterSecond).toBe(afterFirst);
    expect((await getLicense(code))?.status).toBe("used");
  });

  it("补偿不误退别人的码：占用标记归属对不上时保持 used", async () => {
    const { codes } = await createBatch({ count: 1, plan: "month", createdBy: "t" });
    const code = codes[0];
    /* 码先被正常 claim（已 used），随后占用标记被第三方覆盖 */
    const claimed = await claimLicense(code, { email: "a@x.com", userId: "u-a@x.com" });
    expect(claimed.ok).toBe(true);
    store.set(claimPath(code), { emailHash: "someone-else", email: "b@x.com" });

    const res = await POST(req({ code }));
    expect(res.status).toBe(409); // 已有占用且归属不符 → 直接拒，不进入 grantDays

    /* 无论如何这张码不能被这次失败请求还原成 unused（否则可被第三方兑走） */
    expect((await getLicense(code))?.status).toBe("used");
    expect(store.has(licensePath(code))).toBe(true);
  });
});
