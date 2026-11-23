import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* referral.ts 档案锁回归锁。
 *
 * 历史缺陷：ensureRefCode（会员页/注册/登录懒生成邀请码）与 appendReferral
 * （rewardInviter 的 legacy/capped/rewarded 三条分支）对 users/<hash>.json 都是
 * 「dbGet 快照 → 整档 dbPut(overwriteOnConflict)」的无锁读-改-写；而 KV 通道
 * （db.ts upstash/d1/rds/dcs 分支）的 dbPut 完全忽略 sha，last-write-wins。
 * 与 grantDays/setExpiry（兑码、登录补 founder、后台改期）并发时，referral 侧
 * 的旧快照后落会把刚写回的 plan/planExpiresAt/planHistory 整档回滚——卡密已
 * used，用户白付钱。grantDays/setExpiry/change-password/PATCH profile 早已统一
 * 走 entitlement.ts 的 withUserLock，唯独 referral 这两处漏了。
 *
 * 修复：两处读-改-写都进 withUserLock，且 dbGet 在锁内重读（等锁期间锁外快照
 * 同样过期）；appendReferral 不再接收调用方的旧快照。
 *
 * 内存 KV 替身刻意不消费 sha（dbPut 盲写整档），复刻 KV 通道的真实覆盖语义；
 * 并用一次性延迟把「读快照」与「写回」之间的窗口拉开，让并发真的交错——
 * 修复前该窗口里另一请求写回的到期时间会被旧快照整档覆盖。 */

let store = new Map<string, unknown>();
const { dbPutIfAbsentMock, delayState } = vi.hoisted(() => ({
  dbPutIfAbsentMock: vi.fn(),
  delayState: { nextUsersReadMs: 0, nextRefIndexWriteMs: 0 },
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

vi.mock("../server/db", () => ({
  emailHash: (email: string) =>
    crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24),
  dbGet: vi.fn(async (path: string) => {
    /* 先取快照、再一次性延迟返回「用户档案」：复刻一次网络往返把旧快照
     * 拖到并发写入之后才落盘（这正是 last-write-wins 的覆盖窗口）。
     * 若先 sleep 再读，读到的是新值，测不出旧快照覆盖。 */
    const snapshot = store.has(path) ? structuredClone(store.get(path)) : null;
    if (path.startsWith("users/") && delayState.nextUsersReadMs > 0) {
      const ms = delayState.nextUsersReadMs;
      delayState.nextUsersReadMs = 0;
      await sleep(ms);
    }
    return snapshot;
  }),
  /* KV 通道语义：不看 sha，整档盲写（last-write-wins） */
  dbPut: vi.fn(async (path: string, value: unknown) => {
    store.set(path, structuredClone(value));
    return { sha: "mem" };
  }),
  dbPutIfAbsent: dbPutIfAbsentMock,
  dbDelete: vi.fn(async (path: string) => {
    store.delete(path);
  }),
  dbList: vi.fn(async () => []),
}));

import { ensureRefCode, rewardInviter } from "../server/referral";
import { grantDays, setExpiry } from "../server/entitlement";

const DAY = 86_400_000;
const hash = (email: string) =>
  crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24);
const KEY = (email: string) => `users/${hash(email)}.json`;
const LOCK_KEY = (email: string) => `lock/sub/${hash(email)}.json`;

interface StoredUser {
  userId?: string;
  email?: string;
  refCode?: string;
  plan?: string;
  planExpiresAt?: string;
  planHistory?: { licenseId: string; days: number; at: string }[];
  referrals?: { email: string; at: string; rewarded: boolean }[];
}

function seedUser(email: string, extra: Record<string, unknown> = {}) {
  store.set(KEY(email), {
    userId: `u-${email}`,
    email,
    name: email.split("@")[0],
    salt: "salt-old",
    hash: "hash-old",
    createdAt: new Date().toISOString(),
    sv: 0,
    plan: "month",
    planExpiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
    planHistory: [],
    ...extra,
  });
}

beforeEach(() => {
  store = new Map();
  delayState.nextUsersReadMs = 0;
  delayState.nextRefIndexWriteMs = 0;
  dbPutIfAbsentMock.mockReset();
  dbPutIfAbsentMock.mockImplementation(async (path: string, value: unknown) => {
    /* 一次性延迟邀请码索引占位（ensureRefCode 在「读快照」与「整档写回」之间）：
     * 复刻索引键一次网络往返，把旧快照的落盘推迟到并发兑换之后。 */
    if (path.startsWith("ref/") && delayState.nextRefIndexWriteMs > 0) {
      const ms = delayState.nextRefIndexWriteMs;
      delayState.nextRefIndexWriteMs = 0;
      await sleep(ms);
    }
    if (store.has(path)) return false;
    store.set(path, structuredClone(value));
    return true;
  });
});

afterEach(() => {
  delete process.env.REFERRAL_MONTHLY_CAP;
});

describe("referral 档案读-改-写必须持 withUserLock", () => {
  it("契约锁：ensureRefCode 抢同一把 lock/sub/<hash> 且收尾释放（修复前 0 次取锁）", async () => {
    const email = "contract@x.com";
    seedUser(email);

    const code = await ensureRefCode(email, `u-${email}`);
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);

    const lockCalls = dbPutIfAbsentMock.mock.calls.filter((c) => String(c[0]) === LOCK_KEY(email));
    expect(lockCalls.length).toBeGreaterThan(0);
    expect(store.has(LOCK_KEY(email))).toBe(false); // 收尾释放，不留活锁
    expect((store.get(KEY(email)) as StoredUser).refCode).toBe(code);
  });

  it("并发懒生成邀请码 + 兑码：兑换的到期时间/历史不被旧快照回滚", async () => {
    const email = "race@x.com";
    seedUser(email);
    const before = Date.parse((store.get(KEY(email)) as StoredUser).planExpiresAt!);
    /* 索引占位延迟 20ms：修复前 ensureRefCode 会在无锁状态下用旧快照后落 */
    delayState.nextRefIndexWriteMs = 50;

    const [code] = await Promise.all([
      ensureRefCode(email, `u-${email}`),
      grantDays({ email, userId: `u-${email}`, days: 30, plan: "year", licenseId: "lic-ref-race" }),
    ]);

    const final = store.get(KEY(email)) as StoredUser;
    expect(final.refCode).toBe(code);                                            // 邀请码落地
    expect(Date.parse(final.planExpiresAt!)).toBeGreaterThan(before + 29 * DAY);  // 天数未被回滚
    expect(final.planHistory?.some((h) => h.licenseId === "lic-ref-race")).toBe(true);
    expect(final.plan).toBe("year");
  });

  it("并发 appendReferral（capped 分支）+ 兑码：记录与续费天数同时保留", async () => {
    const email = "append@x.com";
    process.env.REFERRAL_MONTHLY_CAP = "1";
    seedUser(email, {
      refCode: "APPEND01",
      referrals: [{ email: "old@x.com", at: new Date().toISOString(), rewarded: true }],
    });
    store.set("ref/APPEND01.json", { code: "APPEND01", email, userId: `u-${email}`, createdAt: new Date().toISOString() });
    const before = Date.parse((store.get(KEY(email)) as StoredUser).planExpiresAt!);
    /* 延迟 rewardInviter 读到的档案快照 20ms：兑换会在该窗口内写完 */
    delayState.nextUsersReadMs = 50;

    const [r] = await Promise.all([
      rewardInviter({ refCode: "APPEND01", inviteeEmail: "newbie@x.com", inviteeUserId: "u-new" }),
      grantDays({ email, userId: `u-${email}`, days: 30, plan: "year", licenseId: "lic-append-race" }),
    ]);
    expect(r).toMatchObject({ rewarded: false, reason: "capped" });

    const final = store.get(KEY(email)) as StoredUser;
    /* 修复前 appendReferral 用调用方旧快照整档写回：要么新记录被回滚，要么天数被回滚 */
    expect(final.referrals?.some((x) => x.email === "newbie@x.com")).toBe(true);
    expect(Date.parse(final.planExpiresAt!)).toBeGreaterThan(before + 29 * DAY);
    expect(final.planHistory?.some((h) => h.licenseId === "lic-append-race")).toBe(true);
  });

  it("并发 appendReferral（legacy 分支）+ setExpiry：后台设期不被旧快照抹掉", async () => {
    const email = "legacy@x.com";
    /* 老用户档案：无 planExpiresAt → rewardInviter 走 legacy 分支只记不奖 */
    store.set(KEY(email), {
      userId: `u-${email}`, email, name: "old", salt: "s", hash: "h",
      createdAt: new Date().toISOString(), sv: 0, refCode: "LEGACY01",
    });
    store.set("ref/LEGACY01.json", { code: "LEGACY01", email, userId: `u-${email}`, createdAt: new Date().toISOString() });
    const until = new Date(Date.now() + 90 * DAY).toISOString();
    delayState.nextUsersReadMs = 50;

    const [r] = await Promise.all([
      rewardInviter({ refCode: "LEGACY01", inviteeEmail: "friend@x.com", inviteeUserId: "u-f" }),
      setExpiry(email, until, "year"),
    ]);
    expect(r).toMatchObject({ rewarded: false, reason: "legacy" });

    const final = store.get(KEY(email)) as StoredUser;
    expect(final.planExpiresAt).toBe(until);                                      // 后台设期生效
    expect(final.referrals?.some((x) => x.email === "friend@x.com")).toBe(true);  // 邀请记录也在
  });

  it("账号不存在时抛错且锁必须释放（异常路径不留活锁挡住后续兑换）", async () => {
    const email = "ghost@x.com";
    await expect(ensureRefCode(email, "u-ghost")).rejects.toThrow("账号不存在");
    expect(store.has(LOCK_KEY(email))).toBe(false);
  });
});
