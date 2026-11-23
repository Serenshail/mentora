import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import type { NextRequest } from "next/server";

vi.mock("@/lib/server/device-auth", () => ({
  verifyAnyAuth: async () => ({ userId: "ict-fin-test" }),
}));
vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: async () => true,
  clientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/server/config", () => ({ logEvent: () => {} }));

const TEST_URL = process.env.TEST_RDS_URL;
const suite = TEST_URL ? describe : describe.skip;

let GET: typeof import("@/app/api/sync/route").GET;
let POST: typeof import("@/app/api/sync/route").POST;
let db: typeof import("@/lib/server/db");
let admin: pg.Client;

const UID = "ict-fin-test";
const SNAP = `data/${UID}.json`;
const VER = `versions/${UID}`;

function postReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new Request("http://localhost/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function getReq(headers: Record<string, string> = {}): NextRequest {
  return new Request("http://localhost/api/sync", { method: "GET", headers }) as unknown as NextRequest;
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await POST(postReq(body, headers));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(headers: Record<string, string> = {}) {
  const res = await GET(getReq(headers));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function archives(): Promise<number> {
  const r = await admin.query("SELECT COUNT(*)::int AS n FROM kv WHERE k LIKE $1", [`${VER}/%`]);
  return r.rows[0].n;
}

async function snapshotDigest(): Promise<string | null> {
  const r = await admin.query("SELECT md5(v) AS h FROM kv WHERE k = $1", [SNAP]);
  return r.rows[0]?.h ?? null;
}

async function reset() {
  await admin.query("DELETE FROM kv WHERE k = $1 OR k LIKE $2", [SNAP, `${SNAP}#p%`]);
  await admin.query("DELETE FROM kv WHERE k LIKE $1", [`${VER}/%`]);
}

suite("T-ICT-015~018 同步接口收口（local-equivalent）", () => {
  beforeAll(async () => {
    process.env.DB_CHANNEL = "huawei";
    process.env.DATABASE_URL = TEST_URL!;
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || "ict-fin-secret-only-local";
    ({ GET, POST } = await import("@/app/api/sync/route"));
    db = await import("@/lib/server/db");
    admin = new pg.Client({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  });

  beforeEach(async () => {
    await reset();
    await admin.query("DROP TRIGGER IF EXISTS ict_block_archive ON kv");
    await admin.query("DROP FUNCTION IF EXISTS ict_block_archive()");
  });

  afterAll(async () => {
    if (admin) {
      await admin.query("DROP TRIGGER IF EXISTS ict_block_archive ON kv");
      await admin.query("DROP FUNCTION IF EXISTS ict_block_archive()");
      await reset();
      await admin.end();
    }
  });

  it("历史分块：GET 可完整读回，POST 同内容幂等、不同内容自愈为单行", async () => {
    const pl = {
      updatedAt: "2026-11-20T10:00:00.000Z",
      userId: UID,
      data: {
        goals: ["chunked"],
        knowledge: [],
        books: [],
        sessions: [],
        customPersonas: [],
        agentSessions: [],
        settings: { apiKey: "" },
      },
    };
    const cipher = db.encrypt(pl);
    const mid = Math.floor(cipher.length / 2);
    await admin.query("INSERT INTO kv(k,v) VALUES ($1,$2),($3,$4)", [SNAP, JSON.stringify({ __chunks__: 2 }), `${SNAP}#p0`, cipher.slice(0, mid)]);
    await admin.query("INSERT INTO kv(k,v) VALUES ($1,$2)", [`${SNAP}#p1`, cipher.slice(mid)]);

    const read = await get();
    expect(read.status).toBe(200);
    expect((read.body.data as { goals?: string[] }).goals).toEqual(["chunked"]);
    expect(read.body.version).toBe("2026-11-20T10:00:00.000Z");

    const idem = await post({ data: { goals: ["chunked"] }, baseVersion: read.body.version, uploadId: "up-fin-0001" });
    expect(idem.status).toBe(200);
    expect(idem.body.version).toBe("2026-11-20T10:00:00.000Z");

    const advance = await post({ data: { goals: ["healed"] }, baseVersion: read.body.version, uploadId: "up-fin-0002" });
    expect(advance.status).toBe(200);
    const rows = await admin.query("SELECT k FROM kv WHERE k = $1 OR k LIKE $2", [SNAP, `${SNAP}#p%`]);
    expect(rows.rowCount).toBe(1);
  });

  it("缺块：GET 与 POST 均返回 503 SNAPSHOT_INCOMPLETE", async () => {
    const cipher = db.encrypt({ updatedAt: "2026-11-20T10:10:00.000Z", data: { goals: ["x"] } });
    await admin.query("INSERT INTO kv(k,v) VALUES ($1,$2),($3,$4)", [SNAP, JSON.stringify({ __chunks__: 3 }), `${SNAP}#p0`, cipher.slice(0, 10)]);
    await admin.query("INSERT INTO kv(k,v) VALUES ($1,$2)", [`${SNAP}#p2`, cipher.slice(10)]);

    const read = await get();
    expect(read.status).toBe(503);
    expect(read.body.code).toBe("SNAPSHOT_INCOMPLETE");

    const write = await post({ data: { goals: ["y"] }, baseVersion: "2026-11-20T10:10:00.000Z" });
    expect(write.status).toBe(503);
    expect(write.body.code).toBe("SNAPSHOT_INCOMPLETE");
    const rows = await admin.query("SELECT COUNT(*)::int AS n FROM kv WHERE k = $1 OR k LIKE $2", [SNAP, `${SNAP}#p%`]);
    expect(rows.rows[0].n).toBe(3);
  });

  it("账户不匹配：GET/POST 均 403 且无读写副作用", async () => {
    const before = await snapshotDigest();
    const g = await get({ "x-mentora-user-id": "another-account" });
    expect(g.status).toBe(403);
    expect(g.body.code).toBe("ACCOUNT_MISMATCH");

    const p = await post({ data: { goals: ["should-not-write"] } }, { "x-mentora-user-id": "another-account" });
    expect(p.status).toBe(403);
    expect(p.body.code).toBe("ACCOUNT_MISMATCH");
    expect(await snapshotDigest()).toBe(before);
  });

  it("归档回显：推进返回 archived，幂等与冲突不新增归档", async () => {
    const first = await post({ data: { goals: ["v1"] }, baseVersion: null, uploadId: "up-fin-0010" });
    expect(first.status).toBe(200);
    expect(first.body.archive).toBeUndefined();
    const v1 = first.body.version as string;

    const second = await post({ data: { goals: ["v2"] }, baseVersion: v1, uploadId: "up-fin-0011" });
    expect(second.status).toBe(200);
    expect(second.body.archive).toBe("archived");
    const v2 = second.body.version as string;
    const n1 = await archives();
    expect(n1).toBe(1);

    const idem = await post({ data: { goals: ["v2"] }, baseVersion: v1, uploadId: "up-fin-0012" });
    expect(idem.status).toBe(200);
    expect(idem.body.archive).toBeUndefined();
    expect(await archives()).toBe(1);

    const conflict = await post({ data: { goals: ["v3"] }, baseVersion: v1, uploadId: "up-fin-0013" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.currentVersion).toBe(v2);
    expect(await archives()).toBe(1);
  });

  it("归档失败：主写入仍成功，响应 archive=failed", async () => {
    const first = await post({ data: { goals: ["base"] }, baseVersion: null, uploadId: "up-fin-0020" });
    const v1 = first.body.version as string;

    await admin.query(
      "CREATE OR REPLACE FUNCTION ict_block_archive() RETURNS trigger AS $$ BEGIN IF NEW.k LIKE 'versions/ict-fin-test/%' THEN RAISE EXCEPTION 'ict-archive-blocked'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql"
    );
    await admin.query("CREATE TRIGGER ict_block_archive BEFORE INSERT ON kv FOR EACH ROW EXECUTE FUNCTION ict_block_archive()");

    const res = await post({ data: { goals: ["after-fail"] }, baseVersion: v1, uploadId: "up-fin-0021" });
    expect(res.status).toBe(200);
    expect(res.body.archive).toBe("failed");

    const row = await admin.query("SELECT v FROM kv WHERE k = $1", [SNAP]);
    const saved = db.decrypt<{ data: { goals: string[] } }>(row.rows[0].v);
    expect(saved.data.goals).toEqual(["after-fail"]);

    await admin.query("DROP TRIGGER ict_block_archive ON kv");
  });
});

if (!TEST_URL) {
  describe("T-ICT-015~018 SKIP: TEST_RDS_URL 未提供", () => {
    it("显式跳过（不计入 PASS）", () => {
      expect(TEST_URL).toBeUndefined();
    });
  });
}