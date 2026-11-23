import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* PATCH /api/auth/profile 档案锁回归锁。
 *
 * 历史缺陷：PATCH 对 users/<hash>.json 是「锁外 dbGet → 整档 dbPut
 * (overwriteOnConflict)」的无锁读-改-写；KV 通道（db.ts upstash/d1/rds/dcs）
 * 的 dbPut 根本不消费 sha，last-write-wins。与 grantDays/setExpiry（兑码、
 * 登录补 founder 福利）、change-password/reset-password 并发时，后写者拿旧
 * 快照整档覆盖：刚兑的 plan/planExpiresAt/planHistory 永久丢失（卡密已 used），
 * 甚至刚重置的 salt/hash/sv 被写回、会话吊销被回滚。
 *
 * 修复：整段读-改-写移进 entitlement.ts 导出的 withUserLock，且 dbGet 在锁内
 * 重读（等锁期间锁外快照同样过期）。锁五件事：
 *  1) 契约锁：PATCH 真的去抢同一把 lock/sub/<hash>.json（修复前 0 次）；
 *  2) 并发 PATCH + grantDays：最终档案同时含新称呼与兑换天数（互不整档覆盖）；
 *  3) 并发 PATCH + 模拟 reset-password（锁内 sv+1/换 hash）：新 sv/hash 不被回滚；
 *  4) 锁被活跃持有 → 503 JSON 且绝不无锁裸跑写库（别人的活锁不被删）；
 *  5) 成功路径行为不变：改名/头像/null 移除头像、413/400 校验、会话 sv 透传。
 *
 * 内存 KV 替身刻意不消费 sha（dbPut 盲写整档），复刻 KV 通道的真实覆盖语义。 */

let store = new Map<string, unknown>();
const { session } = vi.hoisted(() => ({ session: { email: "" } }));

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

/* verifySession/mintSession 必须 mock（真实实现依赖 next/headers 的 cookies()）。 */
vi.mock("../server/auth", () => ({
  verifySession: vi.fn(async () => ({ userId: "u", email: session.email, name: "tester", sv: 0 })),
  mintSession: vi.fn(async () => undefined),
}));

/* body-limit 用真实实现替身的轻量版：带 content-length 的假 req 走不到流分支，
 * 这里直接返回传入的 body，同时保留「过大 => null」的 413 语义供校验覆盖。 */
vi.mock("../server/body-limit", () => ({
  readJsonBody: vi.fn(async (req: { __body?: unknown; __tooBig?: boolean }) =>
    req.__tooBig ? null : ((req.__body ?? {}) as Record<string, unknown>)
  ),
}));

import { PATCH } from "../../app/api/auth/profile/route";
import { grantDays, withUserLock } from "../server/entitlement";
import { dbPutIfAbsent } from "../server/db";
import { mintSession, verifySession } from "../server/auth";

const KEY = (email: string) =>
  `users/${crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24)}.json`;
const LOCK_KEY = (email: string) =>
  `lock/sub/${crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24)}.json`;
const DAY = 86_400_000;

function seedUser(email: string) {
  store.set(KEY(email), {
    userId: `u-${email}`,
    email,
    name: "oldname",
    salt: "salt-old",
    hash: "hash-old",
    createdAt: new Date().toISOString(),
    sv: 0,
    plan: "month",
    planExpiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
    planHistory: [{ licenseId: "seed", days: 30, at: new Date().toISOString() }],
  });
}

const req = (body: Record<string, unknown>, tooBig = false) =>
  ({
    __body: body,
    __tooBig: tooBig,
    json: async () => body,
    headers: { get: () => null },
  }) as unknown as import("next/server").NextRequest;

const patch = (email: string, body: Record<string, unknown>, tooBig = false) => {
  session.email = email;
  return PATCH(req(body, tooBig));
};

beforeEach(() => {
  store = new Map();
  session.email = "";
  vi.mocked(dbPutIfAbsent).mockClear();
  vi.mocked(mintSession).mockClear();
  vi.mocked(verifySession).mockImplementation(async () => ({
    userId: "u", email: session.email, name: "tester", sv: 0,
  }));
});

describe("PATCH /api/auth/profile 档案锁", () => {
  it("契约锁：改资料必须抢同一把 users/<hash> 档案锁（修复前完全不取锁）", async () => {
    const email = "contract@x.com";
    seedUser(email);
    const res = await patch(email, { name: "newname" });
    expect(res.status).toBe(200);

    const lockCalls = vi.mocked(dbPutIfAbsent).mock.calls;
    expect(lockCalls.length).toBeGreaterThan(0);
    expect(lockCalls[0][0]).toBe(LOCK_KEY(email));
    /* 锁在收尾后释放，不留活锁挡住后续兑换 */
    expect(store.has(LOCK_KEY(email))).toBe(false);
  });

  it("并发改资料 + 兑码：最终档案同时保留新称呼与兑换天数（互不整档覆盖）", async () => {
    const email = "race@x.com";
    seedUser(email);
    const before = Date.parse((store.get(KEY(email)) as { planExpiresAt: string }).planExpiresAt);

    /* 真实并发：两者共用 withUserLock → 串行。修复前 PATCH 无锁、拿旧快照
     * 整档覆盖 grantDays 刚写回的 planExpiresAt/planHistory。 */
    const [res, ent] = await Promise.all([
      patch(email, { name: "renamed", avatar: "data:image/png;base64,AAAA" }),
      grantDays({ email, userId: `u-${email}`, days: 30, plan: "year", licenseId: "lic-race" }),
    ]);
    expect(res.status).toBe(200);
    expect(ent.daysLeft).toBeGreaterThan(30);

    const final = store.get(KEY(email)) as {
      name: string;
      avatar: string;
      planExpiresAt: string;
      planHistory: { licenseId: string }[];
    };
    /* 兑换没被改资料的旧快照整档回滚 */
    expect(Date.parse(final.planExpiresAt)).toBeGreaterThan(before + 29 * DAY);
    expect(final.planHistory.some((h) => h.licenseId === "lic-race")).toBe(true);
    /* 改资料也没被兑换整档回滚 */
    expect(final.name).toBe("renamed");
    expect(final.avatar).toBe("data:image/png;base64,AAAA");
  });

  it("并发改资料 + 锁内改密（reset-password 同款 RMW）：新 sv/hash 不被旧快照回滚", async () => {
    const email = "svrace@x.com";
    seedUser(email);

    /* 模拟 reset-password/change-password：与 PATCH 共用同一把档案锁，在锁内
     * 读改写 sv+1、换 salt/hash、清 devices。修复前 PATCH 无锁，可能后写旧
     * salt/hash/sv，把刚完成的密码重置与会话吊销一起回滚。 */
    const [res] = await Promise.all([
      patch(email, { name: "renamed" }),
      withUserLock(email, async () => {
        const rec = store.get(KEY(email)) as Record<string, unknown>;
        store.set(KEY(email), {
          ...rec, salt: "salt-new", hash: "hash-new", sv: 1, devices: [],
        });
        return true;
      }),
    ]);
    expect(res.status).toBe(200);

    const final = store.get(KEY(email)) as {
      name: string; salt: string; hash: string; sv: number; devices: unknown[];
    };
    expect(final.name).toBe("renamed");       // PATCH 生效
    expect(final.salt).toBe("salt-new");      // 密码重置未被旧快照回滚
    expect(final.hash).toBe("hash-new");
    expect(final.sv).toBe(1);                 // 会话吊销未被回滚
    expect(final.devices).toEqual([]);
  });

  it("锁被另一活跃持有者占用 → 503 且不产生任何档案写入（绝不无锁裸跑）", async () => {
    const email = "busy@x.com";
    seedUser(email);
    store.set(LOCK_KEY(email), { at: Date.now() }); // 30s stale 窗口内的活锁

    const before = structuredClone(store.get(KEY(email)));
    const res = await patch(email, { name: "should-not-land" });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "保存失败，稍后再试" });

    /* 档案纹丝不动：名字、planHistory 均未被整档覆盖 */
    expect(store.get(KEY(email))).toEqual(before);
    /* 别人的活锁不能被误当 stale 删掉 */
    expect(store.has(LOCK_KEY(email))).toBe(true);
    expect(vi.mocked(mintSession)).not.toHaveBeenCalled(); // 不重签会话
  });

  it("成功路径行为不变：改名重签会话且 sv 透传，非资料字段原样保留", async () => {
    const email = "plain@x.com";
    seedUser(email);
    const res = await patch(email, { name: "alice" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      user: { userId: `u-${email}`, email, name: "alice" },
    });

    const rec = store.get(KEY(email)) as Record<string, unknown>;
    expect(rec.name).toBe("alice");
    expect(rec.sv).toBe(0);                       // 改资料不递增 sv
    expect(rec.salt).toBe("salt-old");            // 密码字段不动
    expect(rec.planExpiresAt).toBeTruthy();       // 权益字段原样保留
    expect(vi.mocked(mintSession)).toHaveBeenCalledWith({
      userId: `u-${email}`, email, name: "alice", sv: 0,
    });
  });

  it("avatar:null 移除头像、413/400 校验仍生效且不写库", async () => {
    const email = "validate@x.com";
    seedUser(email);
    store.set(KEY(email), { ...(store.get(KEY(email)) as object), avatar: "data:image/png;base64,AAAA" });

    const before = structuredClone(store.get(KEY(email)));
    expect((await patch(email, { name: "x" }, true)).status).toBe(413);   // 体积闸
    expect((await patch(email, { name: "x".repeat(25) })).status).toBe(400); // 称呼过长
    expect((await patch(email, { name: null })).status).toBe(400);         // name:null
    expect((await patch(email, { avatar: "https://evil/x" })).status).toBe(400); // 非法头像
    expect(store.get(KEY(email))).toEqual(before); // 校验失败一律不落档

    const ok = await patch(email, { avatar: null });
    expect(ok.status).toBe(200);
    expect((store.get(KEY(email)) as { avatar?: string }).avatar).toBeUndefined();
  });
});
