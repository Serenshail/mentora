import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* F13 回归锁：设备签发/吊销（POST/DELETE /api/auth/device）的档案锁。
 *
 * 历史缺陷：POST 在锁外 dbGet → verifyPasswordAsync（scrypt，数十至数百 ms）→
 * 整档 dbPut(overwriteOnConflict)；DELETE 同样是无锁整档覆盖写。KV 通道
 * （upstash/d1/rds/dcs）的 dbPut 不消费 sha、last-write-wins——与并发改密/
 * 兑码（grantDays）/管理员续期交错时，设备路由的旧快照会把对方刚写入的
 * salt/hash/sv/plan 整档覆盖回去：改密回滚（旧密码重新生效）、已清空的
 * devices 复活（已吊销令牌死灰复燃）、刚兑的天数消失。
 *
 * 修复：两段读-改-写都移进 entitlement.ts 的 withUserLock（与 profile/
 * change-password/grantDays/reset-password 同一把 lock/sub/<hash>.json）。
 * 内存 KV 替身刻意不消费 sha（dbPut 盲写整档），复刻 KV 通道的真实覆盖语义。 */

let store = new Map<string, unknown>();

vi.mock("../server/db", () => ({
  emailHash: (email: string) =>
    crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24),
  dbGet: vi.fn(async (path: string) => (store.has(path) ? structuredClone(store.get(path)) : null)),
  /* KV 通道语义：不看 sha，整档盲写（last-write-wins） */
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
  /* 与真实实现同参数同语义：异步签名、真验 scrypt（tests 用同格式种子） */
  verifyPasswordAsync: async (pwd: string, salt: string, hash: string) => {
    const key = crypto.scryptSync(pwd, salt, 64);
    const saved = Buffer.from(hash, "hex");
    return key.length === saved.length && crypto.timingSafeEqual(key, saved);
  },
}));

vi.mock("../server/login-guard", () => ({
  dummyScryptVerify: vi.fn(async () => undefined),
  getFailState: vi.fn(async () => null),
  bumpFail: vi.fn(async () => undefined),
  clearFail: vi.fn(async () => undefined),
}));

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("../server/body-limit", () => ({
  readJsonBody: vi.fn(async (req: { __body?: unknown }) => (req.__body ?? {}) as Record<string, unknown>),
}));

import { POST, DELETE } from "../../app/api/auth/device/route";
import { grantDays } from "../server/entitlement";
import { dbPutIfAbsent } from "../server/db";
import { issueDeviceToken, hashDeviceToken, type DeviceRecord } from "../server/device-auth";

const KEY = (email: string) =>
  `users/${crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24)}.json`;
const LOCK_KEY = (email: string) =>
  `lock/sub/${crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24)}.json`;
const DAY = 86_400_000;

function seedUser(email: string, password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  store.set(KEY(email), {
    userId: `u-${email}`,
    email,
    name: "tester",
    salt,
    hash: crypto.scryptSync(password, salt, 64).toString("hex"),
    createdAt: new Date().toISOString(),
    sv: 0,
    devices: [],
    /* 带 planExpiresAt（非 legacy）：grantDays 才会产生 daysLeft，供并发断言 */
    planExpiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
    planHistory: [],
  });
}

const deviceReq = (body: Record<string, unknown>) =>
  ({ __body: body, headers: { get: () => null } }) as unknown as import("next/server").NextRequest;

const deleteReq = (token: string, all = false) =>
  ({
    headers: { get: (n: string) => (n === "x-device-token" ? token : null) },
    nextUrl: { searchParams: { has: () => all } },
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  store = new Map();
});

describe("POST /api/auth/device 档案锁", () => {
  it("契约锁：签发必须抢同一把 lock/sub/<hash>.json，收尾后释放（修复前完全不取锁）", async () => {
    const email = "contract@x.com";
    seedUser(email, "pw123456");
    const res = await POST(deviceReq({ email, password: "pw123456" }));
    expect(res.status).toBe(200);

    const lockCalls = vi.mocked(dbPutIfAbsent).mock.calls;
    expect(lockCalls.length).toBeGreaterThan(0);
    expect(lockCalls[0][0]).toBe(LOCK_KEY(email));
    expect(store.has(LOCK_KEY(email))).toBe(false); // 锁不残留
  });

  it("并发签发 + 兑码：devices 登记与 plan/planHistory 互不整档覆盖", async () => {
    const email = "race@x.com";
    seedUser(email, "pw123456");

    const [res, ent] = await Promise.all([
      POST(deviceReq({ email, password: "pw123456" })),
      grantDays({ email, userId: `u-${email}`, days: 30, plan: "year", licenseId: "lic-race" }),
    ]);
    expect(res.status).toBe(200);
    expect(ent.daysLeft).toBeGreaterThan(29);

    const final = store.get(KEY(email)) as {
      devices: { hash: string }[];
      planHistory: { licenseId: string }[];
      salt: string;
    };
    /* 签发没被兑换的旧快照回滚：devices 里有新令牌 */
    expect(final.devices.length).toBe(1);
    /* 兑换也没被签发的旧快照回滚：planHistory 有 lic-race */
    expect(final.planHistory.some((h) => h.licenseId === "lic-race")).toBe(true);
    expect(final.salt).toBeTruthy();
  });

  it("锁被活跃持有者占用 → 503 且档案纹丝不动（绝不无锁裸跑）", async () => {
    const email = "busy@x.com";
    seedUser(email, "pw123456");
    store.set(LOCK_KEY(email), { at: Date.now() }); // 30s stale 窗口内的活锁

    const before = structuredClone(store.get(KEY(email)));
    const res = await POST(deviceReq({ email, password: "pw123456" }));
    expect(res.status).toBe(503);
    expect(store.get(KEY(email))).toEqual(before);
    expect(store.has(LOCK_KEY(email))).toBe(true); // 别人的活锁不被误删
  });
});

describe("DELETE /api/auth/device 档案锁", () => {
  it("契约锁：吊销必须抢同一把档案锁；吊销后 devices 为空且不回滚兑换", async () => {
    const email = "revoke@x.com";
    seedUser(email, "pw123456");
    const key = KEY(email).replace("users/", "").replace(".json", "");
    const rec = store.get(KEY(email)) as { devices: DeviceRecord[] };
    const { token } = issueDeviceToken(key, rec, "Obsidian 插件");
    rec.devices = [{ id: "d-seed", name: "seed", hash: hashDeviceToken(token), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() }];
    store.set(KEY(email), rec);

    /* 真实并发：吊销（锁内整档覆盖写）+ 兑码（同一把锁）串行，互不覆盖 */
    const [res] = await Promise.all([
      DELETE(deleteReq(token)),
      grantDays({ email, userId: `u-${email}`, days: 30, plan: "year", licenseId: "lic-revoke" }),
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; remaining: number };
    expect(body.ok).toBe(true);
    expect(body.remaining).toBe(0); // 吊销生效

    const final = store.get(KEY(email)) as {
      devices: DeviceRecord[];
      planHistory: { licenseId: string }[];
    };
    expect(final.devices).toEqual([]); // 已吊销令牌没有被「复活」
    expect(final.planHistory.some((h) => h.licenseId === "lic-revoke")).toBe(true); // 兑换没被回滚
    expect(store.has(LOCK_KEY(email))).toBe(false); // 锁释放
  });

  it("锁被活跃持有者占用 → 503 且 devices 不被无锁覆盖写", async () => {
    const email = "revoke-busy@x.com";
    seedUser(email, "pw123456");
    const key = KEY(email).replace("users/", "").replace(".json", "");
    const rec = store.get(KEY(email)) as { devices: DeviceRecord[] };
    const { token } = issueDeviceToken(key, rec, "Obsidian 插件");
    rec.devices = [{ id: "d-seed", name: "seed", hash: hashDeviceToken(token), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() }];
    store.set(KEY(email), rec);
    store.set(LOCK_KEY(email), { at: Date.now() });

    const before = structuredClone(store.get(KEY(email)));
    const res = await DELETE(deleteReq(token));
    expect(res.status).toBe(503);
    expect(store.get(KEY(email))).toEqual(before);
  });
});
