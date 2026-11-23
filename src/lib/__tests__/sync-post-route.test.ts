import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import type { NextRequest } from "next/server";

vi.mock("@/lib/server/device-auth", () => ({
  verifyAnyAuth: async () => ({ userId: "ict-post-test" }),
}));
vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: async () => true,
  clientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/server/config", () => ({
  logEvent: () => {},
}));

const TEST_URL = process.env.TEST_RDS_URL;
const suite = TEST_URL ? describe : describe.skip;

let POST: typeof import("@/app/api/sync/route").POST;
let admin: pg.Client;

const UID = "ict-post-test";
const SNAP = `data/${UID}.json`;
const VER = `versions/${UID}`;

function req(body: unknown): NextRequest {
  return new Request("http://localhost/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function post(body: unknown) {
  const res = await POST(req(body));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function countArchives(): Promise<number> {
  const r = await admin.query("SELECT COUNT(*)::int AS n FROM kv WHERE k LIKE $1", [`${VER}/%`]);
  return r.rows[0].n;
}

suite("T-ICT-015~019 POST /api/sync（local-equivalent）", () => {
  beforeAll(async () => {
    process.env.DB_CHANNEL = "huawei";
    process.env.DATABASE_URL = TEST_URL!;
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || "ict-post-secret-only-local";
    ({ POST } = await import("@/app/api/sync/route"));
    admin = new pg.Client({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    await admin.query("DELETE FROM kv WHERE k = $1 OR k LIKE $2", [SNAP, `${SNAP}#p%`]);
    await admin.query("DELETE FROM kv WHERE k LIKE $1", [`${VER}/%`]);
  });

  afterAll(async () => {
    if (admin) {
      await admin.query("DELETE FROM kv WHERE k = $1 OR k LIKE $2", [SNAP, `${SNAP}#p%`]);
      await admin.query("DELETE FROM kv WHERE k LIKE $1", [`${VER}/%`]);
      await admin.end();
    }
  });

  it("首次创建 → 推进一次 → 旧基线原样重发返回当前版本且不新增归档", async () => {
    const first = await post({ data: { goals: ["A"] }, baseVersion: null, uploadId: "up-000001" });
    expect(first.status).toBe(200);
    const v1 = first.body.version as string;
    expect(await countArchives()).toBe(0);
    expect(first.body.updatedAt).toBe(v1);

    const second = await post({ data: { goals: ["B"] }, baseVersion: v1, uploadId: "up-000002" });
    expect(second.status).toBe(200);
    const v2 = second.body.version as string;
    expect(v2 > v1).toBe(true);
    expect(await countArchives()).toBe(1);

    // 模拟「第一次成功但响应丢失」：客户端水位仍是 v1，原样重发同一业务数据
    const retry = await post({ data: { goals: ["B"] }, baseVersion: v1, uploadId: "up-000003" });
    expect(retry.status).toBe(200);
    expect(retry.body.version).toBe(v2);
    expect(retry.body.updatedAt).toBe(v2);
    expect(await countArchives()).toBe(1);
  });

  it("旧基线提交不同内容 → 409 且归档不变", async () => {
    const before = await countArchives();
    const stale = await post({ data: { goals: ["C"] }, baseVersion: "2026-01-01T00:00:00.000Z", uploadId: "up-000004" });
    expect(stale.status).toBe(409);
    expect(stale.body.conflict).toBe(true);
    expect(typeof stale.body.currentVersion).toBe("string");
    expect(await countArchives()).toBe(before);
  });

  it("未提供 baseVersion 的旧客户端：条件写仍挡住并发", async () => {
    // 用 session 级 advisory lock 把两个事务都挡在临界区外，
    // 保证它们读到同一个提交前状态（否则先后到达会自然串行，测不出竞争）。
    await admin.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [SNAP]);
    let a: { status: number; body: Record<string, unknown> };
    let b: { status: number; body: Record<string, unknown> };
    try {
      const pa = post({ data: { goals: ["legacy-a"] }, uploadId: "up-000005" });
      const pb = post({ data: { goals: ["legacy-b"] }, uploadId: "up-000006" });
      await new Promise((r) => setTimeout(r, 150));
      await admin.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [SNAP]);
      [a, b] = await Promise.all([pa, pb]);
    } finally {
      await admin.query("SELECT pg_advisory_unlock_all()");
    }
    const statuses = [a!.status, b!.status].sort();
    expect(statuses).toEqual([200, 409]);
    const conflict = a!.status === 409 ? a! : b!;
    expect(conflict.body.conflict).toBe(true);
  });

  it("同内容不同 uploadId：服务端分别加密仍判幂等", async () => {
    const current = await post({ data: { goals: ["idem"] }, uploadId: "up-000007" });
    expect(current.status).toBe(200);
    const v = current.body.version as string;
    const archives = await countArchives();

    const again = await post({ data: { goals: ["idem"] }, baseVersion: v, uploadId: "up-000008" });
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(v);
    expect(await countArchives()).toBe(archives);
  });

  it("HTTP 层 20 轮并发：每轮仅一个成功", async () => {
    for (let i = 0; i < 20; i++) {
      await admin.query("DELETE FROM kv WHERE k = $1 OR k LIKE $2", [SNAP, `${SNAP}#p%`]);
      const baseRes = await post({ data: { goals: [`round-${i}`] }, baseVersion: null, uploadId: `up-base-${i}` });
      expect(baseRes.status).toBe(200);
      const base = baseRes.body.version as string;

      await admin.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [SNAP]);
      try {
        const pa = post({ data: { goals: [`round-${i}-a`] }, baseVersion: base, uploadId: `up-a-${i}` });
        const pb = post({ data: { goals: [`round-${i}-b`] }, baseVersion: base, uploadId: `up-b-${i}` });
        await new Promise((r) => setTimeout(r, 30));
        await admin.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [SNAP]);
        const [a, b] = await Promise.all([pa, pb]);
        const statuses = [a.status, b.status].sort();
        expect(statuses, `round ${i}`).toEqual([200, 409]);
      } finally {
        await admin.query("SELECT pg_advisory_unlock_all()");
      }
    }
  });
});

if (!TEST_URL) {
  describe("T-ICT-015~019 SKIP: TEST_RDS_URL 未提供", () => {
    it("显式跳过（不计入 PASS）", () => {
      expect(TEST_URL).toBeUndefined();
    });
  });
}