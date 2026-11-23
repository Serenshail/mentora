import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* 改密路由的档案锁回归锁：
 * change-password 对 users/<hash>.json 是整档覆盖写（overwriteOnConflict，KV 通道
 * last-write-wins）。修复前它 dbGet→scrypt 验证→dbPut 全程无锁，而 grantDays/
 * setExpiry/extendMembership 对同一档案走 withUserLock（entitlement.ts）：并发改密
 * 与兑码时，后写者拿旧快照整档覆盖先写者——刚兑的 planExpiresAt/planHistory 被
 * 回滚（码已 used，叠加 releaseClaim 即资损），或刚改的密码被回滚（旧密码仍有效）。
 * 修复后改密整段读-改-写与兑换共用 withUserLock。
 * 锁五件事：
 *  1) 契约锁：改密必须真的去抢档案锁（dbPutIfAbsent(lock/sub/<hash>.json)）——
 *     修复前该调用次数为 0，此断言确定性失败；
 *  2) 锁被活跃持有 → 503 JSON 且绝不无锁裸跑写库（修复前会 200 并覆盖）；
 *  3) 并发改密 + 兑码：最终档案同时含新密码与兑换天数（互不整档覆盖）；
 *  4) 成功路径行为不变：sv+1、devices 清空、新密码可验、旧密码失效；
 *  5) 旧密码不对 → 401 且不写库。 */

/* store 必须声明在 vi.mock 之前：工厂闭包在 import 时才执行，若声明在后会 TDZ。
 * session.email 同理用 vi.hoisted 提升到工厂之前（verifySession 运行时才读它）。 */
let store = new Map<string, unknown>();
const { session } = vi.hoisted(() => ({ session: { email: "" } }));

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

/* auth 的 scrypt 部分按真实实现复刻（hashPassword/verifyPassword 要真验密码），
 * 会话部分必须 mock：真实 verifySession 会调 next/headers 的 cookies()，
 * 单测无请求上下文必然抛错；mintSession 同理只 set cookie，不写档案。 */
vi.mock("../server/auth", () => ({
  hashPassword: (pwd: string) => {
    const salt = crypto.randomBytes(16).toString("hex");
    return { salt, hash: crypto.scryptSync(pwd, salt, 64).toString("hex") };
  },
  verifyPassword: (pwd: string, salt: string, hash: string) => {
    const a = crypto.scryptSync(pwd, salt, 64);
    const b = Buffer.from(hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },
  /* mock 补全（F12 配套）：route 的验密/哈希已改用异步版，行为与上方同步版逐字一致 */
  hashPasswordAsync: async (pwd: string) => {
    const salt = crypto.randomBytes(16).toString("hex");
    return { salt, hash: crypto.scryptSync(pwd, salt, 64).toString("hex") };
  },
  verifyPasswordAsync: async (pwd: string, salt: string, hash: string) => {
    const a = crypto.scryptSync(pwd, salt, 64);
    const b = Buffer.from(hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },
  verifySession: vi.fn(async () => ({ userId: "u", email: session.email, name: "tester", sv: 0 })),
  mintSession: vi.fn(async () => undefined),
}));

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

import { POST } from "../../app/api/auth/change-password/route";
import { grantDays } from "../server/entitlement";
import { hashPassword, verifyPassword } from "../server/auth";
import { dbPutIfAbsent } from "../server/db";

const KEY = (email: string) =>
  `users/${crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24)}.json`;
const LOCK_KEY = (email: string) =>
  `lock/sub/${crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24)}.json`;
const DAY = 86_400_000;

function seedUser(email: string) {
  const { salt, hash } = hashPassword("oldpassword");
  store.set(KEY(email), {
    userId: `u-${email}`,
    email,
    name: email.split("@")[0],
    salt,
    hash,
    createdAt: new Date().toISOString(),
    plan: "month",
    planExpiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
    planHistory: [{ licenseId: "seed", days: 30, at: new Date().toISOString() }],
    devices: [{ id: "d1", label: "old phone" }],
  });
}

const req = (body: Record<string, unknown>) =>
  ({
    json: async () => body,
    headers: { get: () => null },
  }) as unknown as import("next/server").NextRequest;

const changePassword = (email: string) => {
  session.email = email;
  return POST(req({ oldPassword: "oldpassword", newPassword: "newpassword" }));
};

beforeEach(() => {
  store = new Map();
  session.email = "";
  vi.mocked(dbPutIfAbsent).mockClear();
});

describe("change-password 档案锁", () => {
  it("契约锁：改密必须抢同一把 users/<hash> 档案锁（修复前完全不取锁）", async () => {
    const email = "contract@x.com";
    seedUser(email);
    const res = await changePassword(email);
    expect(res.status).toBe(200);

    const lockCalls = vi.mocked(dbPutIfAbsent).mock.calls;
    expect(lockCalls.length).toBeGreaterThan(0);
    expect(lockCalls[0][0]).toBe(LOCK_KEY(email));
    /* 锁在成功收尾后释放，不留活锁挡住后续兑换 */
    expect(store.has(LOCK_KEY(email))).toBe(false);
  });

  it("锁被另一活跃持有者占用 → 503 且不产生任何档案写入（绝不无锁裸跑）", async () => {
    const email = "busy@x.com";
    seedUser(email);
    store.set(LOCK_KEY(email), { at: Date.now() }); // 30s stale 窗口内的活锁

    const before = structuredClone(store.get(KEY(email)));
    const res = await changePassword(email);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "保存失败，稍后再试" });

    /* 档案纹丝不动：旧密码仍有效、planHistory 未被整档覆盖 */
    expect(store.get(KEY(email))).toEqual(before);
    /* 别人的活锁不能被误当 stale 删掉 */
    expect(store.has(LOCK_KEY(email))).toBe(true);
  });

  it("并发改密 + 兑码：最终档案同时保留新密码与兑换天数", async () => {
    const email = "race@x.com";
    seedUser(email);
    const before = Date.parse((store.get(KEY(email)) as { planExpiresAt: string }).planExpiresAt);

    /* 真实并发：两者共用 withUserLock → 串行；修复前改密无锁、可用旧快照
     * 整档覆盖 grantDays 刚写回的 planExpiresAt/planHistory。 */
    const [res, ent] = await Promise.all([
      changePassword(email),
      grantDays({ email, userId: `u-${email}`, days: 30, plan: "year", licenseId: "lic-race" }),
    ]);
    expect(res.status).toBe(200);
    expect(ent.daysLeft).toBeGreaterThan(30);

    const final = store.get(KEY(email)) as {
      planExpiresAt: string;
      planHistory: { licenseId: string }[];
      salt: string;
      hash: string;
      sv: number;
    };
    /* 兑换没被改密的旧快照整档回滚 */
    expect(Date.parse(final.planExpiresAt)).toBeGreaterThan(before + 29 * DAY);
    expect(final.planHistory.some((h) => h.licenseId === "lic-race")).toBe(true);
    /* 改密也没被兑换整档回滚 */
    expect(verifyPassword("newpassword", final.salt, final.hash)).toBe(true);
    expect(final.sv).toBe(1);
  });

  it("成功路径行为不变：sv+1、devices 清空、旧密码失效", async () => {
    const email = "plain@x.com";
    seedUser(email);
    const res = await changePassword(email);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, revokedOtherDevices: true });

    const rec = store.get(KEY(email)) as {
      sv: number;
      devices: unknown[];
      salt: string;
      hash: string;
      planHistory: { licenseId: string }[];
    };
    expect(rec.sv).toBe(1);
    expect(rec.devices).toEqual([]);
    expect(verifyPassword("newpassword", rec.salt, rec.hash)).toBe(true);
    expect(verifyPassword("oldpassword", rec.salt, rec.hash)).toBe(false);
    /* 非密码字段原样保留 */
    expect(rec.planHistory).toHaveLength(1);
  });

  it("旧密码不对 → 401 且不写库", async () => {
    const email = "wrong@x.com";
    seedUser(email);
    session.email = email;
    const res = await POST(req({ oldPassword: "not-my-password", newPassword: "newpassword" }));
    expect(res.status).toBe(401);
    const rec = store.get(KEY(email)) as { sv?: number };
    expect(rec.sv ?? 0).toBe(0);
  });
});
