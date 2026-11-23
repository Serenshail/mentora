import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 后台会员列表 GET 的性能回归锁（修复前：for 循环里逐条 await dbGet 串行 N+1）。
 * 每个用户一次远端加密读（D1/RDS 往返 + AES 解密），N 涨到数百时一次 GET 直接顶满
 * maxDuration=60，会员管理页先于其他后台页不可用。修复口径与 admin/overview、
 * admin/users、admin/leads 完全一致：分块并发读（块内并行 CHUNK=8、块间串行）。
 * 同时锁住数据面没有被并发改写打乱：
 *  1) 邀请码 → 邮箱 的索引仍覆盖全量用户（跨块解析 invitedBy 有效）；
 *  2) 单条解密失败只跳过该条，不阻断整页；
 *  3) summary 统计与排序口径不变。 */

const store = new Map<string, string>();
const failPaths = new Set<string>();
let inFlight = 0;
let maxInFlight = 0;

vi.mock("../server/db", () => ({
  dbGet: vi.fn(async (path: string) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      /* 模拟远端加密读延迟：块内并发才会在时间上重叠，串行实现 maxInFlight 恒为 1 */
      await new Promise((r) => setTimeout(r, 3));
      if (failPaths.has(path)) throw new Error("单条解密失败");
      const v = store.get(path);
      return v == null ? null : JSON.parse(v);
    } finally {
      inFlight--;
    }
  }),
  dbList: vi.fn(async (dir: string) =>
    [...store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .sort()
      .map((name) => ({ name: name.slice(dir.length + 1), sha: "mem" }))
  ),
  emailHash: (email: string) => email,
}));

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("../server/admin-auth", () => ({
  authorizeAdmin: vi.fn(async () => ({ ok: true, email: "admin@x.com", name: "admin" })),
  /* mock 补全（F7 配套）：route 已改用 detailed 版取四类失败原因，返回同一 ok 对象 */
  authorizeAdminDetailed: vi.fn(async () => ({ ok: true, email: "admin@x.com", name: "admin" })),
}));

import { GET } from "../../app/api/admin/members/route";

const req = {
  headers: { get: () => null },
} as unknown as import("next/server").NextRequest;

const DAY = 86_400_000;
const userPath = (i: number) => `users/u${i}.json`;

function seedUser(
  i: number,
  extra: { refCode?: string; invitedBy?: string; planExpiresAt?: string | null; referrals?: unknown[] } = {}
) {
  store.set(
    userPath(i),
    JSON.stringify({
      userId: `u${i}`,
      email: `user${i}@x.com`,
      name: `user${i}`,
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
      plan: "month",
      planExpiresAt: extra.planExpiresAt === null ? undefined : extra.planExpiresAt ?? new Date(Date.now() + 30 * DAY).toISOString(),
      planHistory: [],
      ...(extra.refCode ? { refCode: extra.refCode } : {}),
      ...(extra.invitedBy ? { invitedBy: extra.invitedBy } : {}),
      ...(extra.referrals ? { referrals: extra.referrals } : {}),
    })
  );
}

beforeEach(() => {
  store.clear();
  failPaths.clear();
  inFlight = 0;
  maxInFlight = 0;
});

describe("admin members GET 性能回归锁", () => {
  it("分块并发读：30 个用户 maxInFlight=8（修复前串行恒为 1），全量返回且按 createdAt 降序", async () => {
    for (let i = 0; i < 30; i++) seedUser(i);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: { email: string; createdAt: string; status: string }[];
      summary: { total: number; active: number };
    };
    expect(body.members).toHaveLength(30);
    expect(body.summary.total).toBe(30);
    expect(body.summary.active).toBe(30);
    expect(body.members[0].email).toBe("user29@x.com");
    expect(body.members[29].email).toBe("user0@x.com");
    const times = body.members.map((m) => m.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(maxInFlight).toBe(8);
  });

  it("跨块邀请码索引不丢：第 1 条邀请第 40 条，invitedByEmail 仍解析成邀请人邮箱", async () => {
    seedUser(0, { refCode: "refabc" });
    for (let i = 1; i < 40; i++) seedUser(i);
    seedUser(40, { invitedBy: "REFABC" });
    const res = await GET(req);
    const body = (await res.json()) as {
      members: { email: string; refCode: string | null; invitedByCode: string | null; invitedByEmail: string | null }[];
    };
    const invited = body.members.find((m) => m.email === "user40@x.com");
    expect(invited?.invitedByCode).toBe("REFABC");
    expect(invited?.invitedByEmail).toBe("user0@x.com");
    /* 邀请人的 refCode 归一化为大写键（原实现行为） */
    expect(body.members.find((m) => m.email === "user0@x.com")?.refCode).toBe("refabc");
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it("单条解密失败只跳过该条：30 个用户坏 1 个 → 返回 29 条，summary.total=29", async () => {
    for (let i = 0; i < 30; i++) seedUser(i);
    failPaths.add(userPath(7));
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: { email: string }[]; summary: { total: number } };
    expect(body.members).toHaveLength(29);
    expect(body.members.some((m) => m.email === "user7@x.com")).toBe(false);
    expect(body.summary.total).toBe(29);
  });

  it("空库：members 为空、summary 全 0，且不发生任何读（maxInFlight=0）", async () => {
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: unknown[]; summary: Record<string, number> };
    expect(body.members).toEqual([]);
    expect(body.summary).toEqual({ total: 0, active: 0, expiring: 0, expired: 0, legacy: 0 });
    expect(maxInFlight).toBe(0);
  });
});
