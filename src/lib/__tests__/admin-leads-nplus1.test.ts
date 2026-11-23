import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 后台线索列表 GET 的性能回归锁（修复前：逐条 await dbGet 串行 N+1 且无条数上限）。
 * trial-request 是公开入口（每 IP 限流、换 IP 无界），leads 长期可垒到数千上万条——
 * 串行读时一次 GET = N 次远端加密读，接口实质不可用。修复口径与 admin/users 同款：
 *  1) 分块并发读（块内并行 CHUNK=8、块间串行）——锁 maxInFlight>1 且 ≤8；
 *  2) 单次最多读 MAX_LEADS=1000 条（文件名前缀是写入侧日期，字典序=时间序，截最旧的），
 *     total 回传全量条数让后台看得到截断；
 *  3) 单条读失败照旧跳过，不阻断整页。 */

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
      if (failPaths.has(path)) throw new Error("单条读失败");
      const v = store.get(path);
      return v == null ? null : JSON.parse(v);
    } finally {
      inFlight--;
    }
  }),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    store.set(path, JSON.stringify(value));
    return { sha: "mem" };
  }),
  dbList: vi.fn(async (dir: string) =>
    [...store.keys()]
      .filter((k) => k.startsWith(`${dir}/`) && !k.includes("#"))
      .sort()
      .map((name) => ({ name: name.slice(dir.length + 1), sha: "mem" }))
  ),
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

vi.mock("../server/license", () => ({
  createBatch: vi.fn(async () => ({ codes: ["TRIAL-CODE"], batch: { id: "b1" } })),
}));

import { GET } from "../../app/api/admin/leads/route";

/* 与路由内部 MAX_LEADS 保持一致；若路由常量调整，此处同步改并更新用例数据量 */
const MAX_LEADS = 1000;

const req = {
  headers: { get: () => null },
} as unknown as import("next/server").NextRequest;

const leadId = (i: number) => `20261101-${i.toString(16).padStart(8, "0")}`;
const leadPath = (i: number) => `leads/${leadId(i)}.json`;

function seedLeads(n: number) {
  /* 文件名字典序 = i 序 = createdAt 序（同日、按秒递增），name 降序截断即截最旧 */
  for (let i = 0; i < n; i++) {
    store.set(
      leadPath(i),
      JSON.stringify({
        id: leadId(i),
        email: `lead${i}@x.com`,
        contact: `c${i}`,
        note: "",
        createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
        status: "new",
      })
    );
  }
}

beforeEach(() => {
  store.clear();
  failPaths.clear();
  inFlight = 0;
  maxInFlight = 0;
});

describe("admin leads GET 性能回归锁", () => {
  it("批量返回：30 条全量返回且按 createdAt 降序，分块并发生效（maxInFlight=8 而非串行 1）", async () => {
    seedLeads(30);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { leads: { id: string; createdAt: string }[]; total: number };
    expect(body.total).toBe(30);
    expect(body.leads).toHaveLength(30);
    /* 最新在前 */
    expect(body.leads[0].id).toBe(leadId(29));
    expect(body.leads[29].id).toBe(leadId(0));
    const times = body.leads.map((l) => l.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    /* 修复前串行 N+1 时 maxInFlight 恒为 1；分块 CHUNK=8 且块间不重叠 */
    expect(maxInFlight).toBe(8);
  });

  it("单条读失败不阻断整页：30 条坏 1 条 → 返回 29 条、total 仍为 30", async () => {
    seedLeads(30);
    failPaths.add(leadPath(7));
    const res = await GET(req);
    const body = (await res.json()) as { leads: unknown[]; total: number };
    expect(body.leads).toHaveLength(29);
    expect(body.total).toBe(30);
  });

  it("无界量截断：1030 条只读最新 1000 条（截最旧的），total 如实回传 1030", async () => {
    seedLeads(MAX_LEADS + 30);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { leads: { id: string }[]; total: number };
    expect(body.total).toBe(MAX_LEADS + 30);
    expect(body.leads).toHaveLength(MAX_LEADS);
    /* 截断保新弃旧：最旧的 30 条（id 0-29）不出现在结果里，最新的在 */
    expect(body.leads.some((l) => l.id === leadId(0))).toBe(false);
    expect(body.leads.some((l) => l.id === leadId(MAX_LEADS + 29))).toBe(true);
    /* 即使截断，读取也保持分块并发上限，不退化为无界并发 */
    expect(maxInFlight).toBeLessThanOrEqual(8);
  }, 30_000);

  it("空库：leads 为空数组、total=0，不抛错", async () => {
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { leads: unknown[]; total: number };
    expect(body.leads).toEqual([]);
    expect(body.total).toBe(0);
    expect(maxInFlight).toBe(0);
  });
});
