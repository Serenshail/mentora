import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* ============ 后台会员列表：存储故障要结构化失败，损坏档案要有计数 ============
 * 两处缺陷（src/app/api/admin/members/route.ts）：
 *  1) GET 顶层 dbList("users") 未包 try/catch——存储通道故障时抛裸 500（非 JSON），
 *     走 x-admin-password 的外部后台拿不到结构化失败信息。与 admin/overview:119-121、
 *     admin/users、admin/leads 同口径落 503。
 *  2) 单档案 dbGet 失败被静默跳过且不回计数——损坏会员从列表消失，管理员会把它
 *     误判成「账号不存在」（续期/改期/吊销都以这份列表为准）。overview 的
 *     skippedUsers、admin/users POST 的 skipped 都已按「计数必须回给 UI」修过。
 * 本锁钉住：故障 → 503 JSON；坏档案 → 仍返回其余会员且 skipped 如实计数。 */

const store = new Map<string, string>();
const failPaths = new Set<string>();
let failList = false;

vi.mock("../server/db", () => ({
  dbGet: vi.fn(async (path: string) => {
    if (failPaths.has(path)) throw new Error("decrypt failed");
    const v = store.get(path);
    return v == null ? null : JSON.parse(v);
  }),
  dbList: vi.fn(async (dir: string) => {
    if (failList) throw new Error("kv down");
    return [...store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .sort()
      .map((name) => ({ name: name.slice(dir.length + 1), sha: "mem" }));
  }),
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

const req = { headers: { get: () => null } } as unknown as import("next/server").NextRequest;

const DAY = 86_400_000;
const userPath = (i: number) => `users/u${i}.json`;

function seedUser(i: number) {
  store.set(
    userPath(i),
    JSON.stringify({
      userId: `u${i}`,
      email: `user${i}@x.com`,
      name: `user${i}`,
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
      plan: "month",
      planExpiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
      planHistory: [],
    })
  );
}

beforeEach(() => {
  store.clear();
  failPaths.clear();
  failList = false;
});

describe("admin members GET 故障与失败可见性", () => {
  it("dbList 抛错：返回 503 JSON（不是无 JSON 错误体的裸 500）", async () => {
    failList = true;
    const res = await GET(req);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "会员数据暂时不可用，稍后再试" });
  });

  it("单档案读取失败：其余会员照常返回，skipped 如实计数", async () => {
    for (let i = 0; i < 5; i++) seedUser(i);
    failPaths.add(userPath(2));
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: { email: string }[];
      summary: { total: number };
      skipped: number;
    };
    expect(body.members).toHaveLength(4);
    expect(body.summary.total).toBe(4);
    expect(body.skipped).toBe(1); // 旧实现没有任何失败信号
    expect(body.members.some((m) => m.email === "user2@x.com")).toBe(false);
  });

  it("全部正常：skipped 为 0", async () => {
    for (let i = 0; i < 3; i++) seedUser(i);
    const res = await GET(req);
    const body = (await res.json()) as { skipped: number; summary: { total: number } };
    expect(body.skipped).toBe(0);
    expect(body.summary.total).toBe(3);
  });
});
