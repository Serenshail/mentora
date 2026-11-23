import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* F15/F16 回归锁：reset-password 的档案锁 + 反枚举。
 *
 * 历史缺陷 1（F15，资损）：line 57 锁外读档案快照 → line 84 整档
 * dbPut(overwriteOnConflict) 写回，全程不取 withUserLock。KV 通道 last-write-wins，
 * 与并发兑换（grantDays 刚写回 plan/planExpiresAt/planHistory）交错时旧快照整档
 * 覆盖回滚——卡密已被 claimLicense 标 used（releaseClaim 只在 grantDays 抛错时
 * 触发），用户付费天数凭空消失；sv 回写还会让并发 change-password 刚签发的新
 * 会话失配。修复：整段读-改-写移进 withUserLock（与 change-password/profile/
 * grantDays/device 同一把 lock/sub/<hash>.json）。
 *
 * 历史缺陷 2（F16）：消费重置码「之前」对不存在档案回 404「账户不存在」，攻击者
 * 无需有效重置码即可按响应区分邮箱是否注册（限流按 IP 计，换源 IP 可放大）。
 * login 路由（57-62 行）早已统一口径。修复：档案不存在不再提前 404——照常消费
 * 重置码，最终回与「重置码不对」一致的 401。 */

let store = new Map<string, unknown>();
const { consumeResetCode } = vi.hoisted(() => ({ consumeResetCode: vi.fn() }));

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

vi.mock("../server/auth", () => ({
  hashPasswordAsync: async (pwd: string) => {
    const salt = crypto.randomBytes(16).toString("hex");
    return { salt, hash: crypto.scryptSync(pwd, salt, 64).toString("hex") };
  },
}));

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("../server/deploy-env", () => ({ deployEnv: () => "test" }));

vi.mock("../server/reset-code", () => ({ consumeResetCode }));

vi.mock("../server/body-limit", () => ({
  readJsonBody: vi.fn(async (req: { __body?: unknown }) => (req.__body ?? {}) as Record<string, unknown>),
}));

import { POST } from "../../app/api/auth/reset-password/route";
import { grantDays } from "../server/entitlement";
import { dbPutIfAbsent } from "../server/db";

const KEY = (email: string) =>
  `users/${crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24)}.json`;
const LOCK_KEY = (email: string) =>
  `lock/sub/${crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24)}.json`;
const DAY = 86_400_000;

function seedUser(email: string) {
  store.set(KEY(email), {
    userId: `u-${email}`,
    email,
    name: "tester",
    salt: "salt-old",
    hash: "hash-old",
    createdAt: new Date().toISOString(),
    sv: 0,
    devices: [{ hash: "stale" }],
    /* 带 planExpiresAt（非 legacy）：grantDays 才会产生 daysLeft，供并发断言 */
    planExpiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
    planHistory: [],
  });
}

const req = (body: Record<string, unknown>) =>
  ({ __body: body, headers: { get: () => null } }) as unknown as import("next/server").NextRequest;

const post = (email: string, code: string) => POST(req({ email, resetCode: code, newPassword: "newpass123" }));

beforeEach(() => {
  store = new Map();
  consumeResetCode.mockReset();
});

describe("reset-password 档案锁（F15）", () => {
  it("契约锁：重置必须抢 lock/sub/<hash>.json，收尾后释放", async () => {
    const email = "lock@x.com";
    seedUser(email);
    consumeResetCode.mockResolvedValue("ok");
    const res = await post(email, "CODE-1");
    expect(res.status).toBe(200);

    const lockCalls = vi.mocked(dbPutIfAbsent).mock.calls;
    expect(lockCalls.length).toBeGreaterThan(0);
    expect(lockCalls[0][0]).toBe(LOCK_KEY(email));
    expect(store.has(LOCK_KEY(email))).toBe(false);
  });

  it("并发重置 + 兑码：新 salt/hash/sv 与兑换天数互不整档覆盖", async () => {
    const email = "race@x.com";
    seedUser(email);
    consumeResetCode.mockResolvedValue("ok");

    const [res, ent] = await Promise.all([
      post(email, "CODE-1"),
      grantDays({ email, userId: `u-${email}`, days: 30, plan: "year", licenseId: "lic-race" }),
    ]);
    expect(res.status).toBe(200);
    expect(ent.daysLeft).toBeGreaterThan(29);

    const final = store.get(KEY(email)) as {
      salt: string; hash: string; sv: number; devices: unknown[];
      planHistory: { licenseId: string }[];
    };
    expect(final.salt).not.toBe("salt-old"); // 新密码落档
    expect(final.hash).not.toBe("hash-old");
    expect(final.sv).toBe(1); // 会话吊销未被回滚
    expect(final.devices).toEqual([]); // 设备吊销未被复活
    expect(final.planHistory.some((h) => h.licenseId === "lic-race")).toBe(true); // 付费兑换未被回滚
  });

  it("锁被活跃持有者占用 → 503 且档案纹丝不动（绝不无锁裸跑）", async () => {
    const email = "busy@x.com";
    seedUser(email);
    consumeResetCode.mockResolvedValue("ok");
    store.set(LOCK_KEY(email), { at: Date.now() });

    const before = structuredClone(store.get(KEY(email)));
    const res = await post(email, "CODE-1");
    expect(res.status).toBe(503);
    expect(store.get(KEY(email))).toEqual(before);
  });
});

describe("reset-password 反枚举（F16）", () => {
  it("不存在的档案：仍然消费重置码，最终回「重置码不对」401，绝不提前 404「账户不存在」", async () => {
    consumeResetCode.mockResolvedValue("mismatch");
    const res = await post("ghost@x.com", "WRONG-CODE");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("重置码不对"); // 与存在账号的 mismatch 文案一致
    expect(consumeResetCode).toHaveBeenCalledOnce(); // 先消费码再判档案

    /* 存在账号 + 错码：同一响应（无信息差） */
    seedUser("real@x.com");
    const res2 = await post("real@x.com", "WRONG-CODE");
    expect(res2.status).toBe(401);
    expect(((await res2.json()) as { error?: string }).error).toBe("重置码不对");
  });

  it("不存在的档案 + 有效码（管理员误发）：同样 401「重置码不对」，不写成任何档案", async () => {
    consumeResetCode.mockResolvedValue("ok");
    const res = await post("ghost2@x.com", "CODE-OK");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBe("重置码不对");
    expect(store.has(KEY("ghost2@x.com"))).toBe(false); // 不会凭空建档
  });
});
