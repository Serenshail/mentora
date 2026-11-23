import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const TEST_URL = process.env.TEST_RDS_URL;
const suite = TEST_URL ? describe : describe.skip;

type Store = typeof import("../server/snapshot-store");
type DbMod = typeof import("../server/db");

let store: Store;
let db: DbMod;
let admin: pg.Client;

const P = (s: string) => `data/ict-test-${s}.json`;

async function clean(...paths: string[]) {
  for (const p of paths) {
    await admin.query("DELETE FROM kv WHERE k = $1 OR k LIKE $2", [p, `${p}#p%`]);
  }
}

function payload(updatedAt: string, uploadId?: string, data: unknown = { goals: ["same"] }) {
  return { updatedAt, data, userId: "ict-test", ...(uploadId ? { uploadId } : {}) };
}

suite("T-ICT-006~011 RDS 快照事务（local-equivalent）", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL!;
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || "ict-test-secret-only-local";
    store = await import("../server/snapshot-store");
    db = await import("../server/db");
    admin = new pg.Client({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  });

  afterAll(async () => {
    if (admin) {
      await admin.query("DROP TRIGGER IF EXISTS ict_block_delete ON kv");
      await admin.query("DROP FUNCTION IF EXISTS ict_block_delete()");
      await admin.end();
    }
  });

  const commit = (
    path: string,
    pl: Record<string, unknown>,
    version: string,
    expect: import("../server/snapshot-types").Expectation,
    baseVersion?: string | null
  ) => store.commitSnapshot({ path, payload: pl, content: db.encrypt(pl), version, expect, baseVersion });

  it("首次创建成功，重复 absent 返回 exists 冲突", async () => {
    const path = P("create");
    await clean(path);
    const v1 = "2026-11-20T00:00:00.000Z";
    const out = await commit(path, payload(v1, "up-1", { goals: ["a"] }), v1, { mode: "absent" });
    expect(out.kind).toBe("created");
    expect(out.version).toBe(v1);

    const err = await commit(path, payload("2026-11-20T00:00:01.000Z", "up-2", { goals: ["b"] }), "2026-11-20T00:00:01.000Z", { mode: "absent" }).catch((e) => e);
    expect(err.name).toBe("ConcurrentWriteError");
    expect(err.details.reason).toBe("exists");
    expect(err.details.currentVersion).toBe(v1);
    await clean(path);
  });

  it("同版本双路并发：成功 1、冲突 1，409 携带当前版本", async () => {
    const path = P("concurrent");
    await clean(path);
    const base = "2026-11-20T01:00:00.000Z";
    await commit(path, payload(base, "up-base", { goals: ["base"] }), base, { mode: "absent" });
    const token = (await store.readSnapshot(path))!.token;

    const mk = (tag: string, ts: string) =>
      commit(path, payload(ts, `up-${tag}`, { goals: [tag] }), ts, { mode: "match", token }, base);

    const results = await Promise.allSettled([mk("a", "2026-11-20T01:00:01.000Z"), mk("b", "2026-11-20T01:00:02.000Z")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason.name).toBe("ConcurrentWriteError");
    expect(bad[0].reason.details.currentVersion).toBe((ok[0] as PromiseFulfilledResult<{ version: string }>).value.version);
    await clean(path);
  });

  it("规范化幂等：业务数据相同、updatedAt 与 uploadId 不同 → idempotent 且不推进", async () => {
    const path = P("idem-canonical");
    await clean(path);
    const v1 = "2026-11-20T02:00:00.000Z";
    const same = { goals: ["same"], knowledge: [], settings: { theme: "dark" } };
    await commit(path, payload(v1, "up-first", same), v1, { mode: "absent" });
    const before = (await store.readSnapshot(path))!;

    const out = await commit(path, payload("2026-11-20T02:00:09.000Z", "up-second", { settings: { theme: "dark" }, knowledge: [], goals: ["same"] }), "2026-11-20T02:00:09.000Z", { mode: "match", token: before.token }, "2026-11-20T01:00:00.000Z");
    expect(out.kind).toBe("idempotent");
    expect(out.version).toBe(v1);
    const after = (await store.readSnapshot(path))!;
    expect(after.token).toBe(before.token);
    expect(after.version).toBe(v1);
    await clean(path);
  });

  it("旧基线 + 不同业务内容：409 version-mismatch，云端不变", async () => {
    const path = P("stale");
    await clean(path);
    const v2 = "2026-11-20T03:00:00.000Z";
    await commit(path, payload(v2, "up-2", { goals: ["v2"] }), v2, { mode: "absent" });
    const before = (await store.readSnapshot(path))!;

    const err = await commit(path, payload("2026-11-20T03:10:00.000Z", "up-3", { goals: ["v3"] }), "2026-11-20T03:10:00.000Z", { mode: "match", token: before.token }, "2026-11-20T01:00:00.000Z").catch((e) => e);
    expect(err.name).toBe("ConcurrentWriteError");
    expect(err.details.reason).toBe("version-mismatch");
    expect(err.details.currentVersion).toBe(v2);
    const after = (await store.readSnapshot(path))!;
    expect(after.token).toBe(before.token);
    await clean(path);
  });

  it("未提供 baseVersion 的旧客户端：令牌条件写仍能挡住并发", async () => {
    const path = P("legacy");
    await clean(path);
    const v1 = "2026-11-20T03:30:00.000Z";
    await commit(path, payload(v1, "up-0", { goals: ["base"] }), v1, { mode: "absent" });
    const token = (await store.readSnapshot(path))!.token;

    const mk = (tag: string, ts: string) => commit(path, payload(ts, `up-${tag}`, { goals: [tag] }), ts, { mode: "match", token });
    const results = await Promise.allSettled([mk("x", "2026-11-20T03:31:00.000Z"), mk("y", "2026-11-20T03:32:00.000Z")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    await clean(path);
  });

  it("仅块行无主行：absent 判定 residual-block 且块行不被删除", async () => {
    const path = P("residual");
    await clean(path);
    await admin.query("INSERT INTO kv(k,v) VALUES ($1,$2),($3,$4)", [`${path}#p0`, "A", `${path}#p1`, "B"]);

    const err = await commit(path, payload("2026-11-20T04:00:00.000Z"), "2026-11-20T04:00:00.000Z", { mode: "absent" }).catch((e) => e);
    expect(err.name).toBe("ConcurrentWriteError");
    expect(err.details.reason).toBe("residual-block");
    const rows = await admin.query("SELECT k FROM kv WHERE k = $1 OR k LIKE $2 ORDER BY k", [path, `${path}#p%`]);
    expect(rows.rowCount).toBe(2);
    await clean(path);
  });

  it("分块缺块：SnapshotIncompleteError，主行与块行保持原状", async () => {
    const path = P("incomplete");
    await clean(path);
    await admin.query("INSERT INTO kv(k,v) VALUES ($1,$2),($3,$4)", [path, JSON.stringify({ __chunks__: 3 }), `${path}#p0`, "A"]);
    await admin.query("INSERT INTO kv(k,v) VALUES ($1,$2)", [`${path}#p2`, "C"]);

    const err = await commit(path, payload("2026-11-20T05:00:00.000Z"), "2026-11-20T05:00:00.000Z", { mode: "unconditional" }).catch((e) => e);
    expect(err.name).toBe("SnapshotIncompleteError");
    expect(err.missing).toEqual([1]);
    const rows = await admin.query("SELECT k FROM kv WHERE k = $1 OR k LIKE $2 ORDER BY k", [path, `${path}#p%`]);
    expect(rows.rowCount).toBe(3);
    await clean(path);
  });

  it("历史分块：读取兼容，一次成功写入自愈为单行", async () => {
    const path = P("chunk-heal");
    await clean(path);
    const old = db.encrypt(payload("2026-11-20T08:30:00.000Z", "up-old", { goals: ["old"] }));
    const mid = Math.floor(old.length / 2);
    await admin.query("INSERT INTO kv(k,v) VALUES ($1,$2),($3,$4)", [path, JSON.stringify({ __chunks__: 2 }), `${path}#p0`, old.slice(0, mid)]);
    await admin.query("INSERT INTO kv(k,v) VALUES ($1,$2)", [`${path}#p1`, old.slice(mid)]);

    const read = await store.readSnapshot(path);
    expect(read!.version).toBe("2026-11-20T08:30:00.000Z");
    expect(read!.uploadId).toBe("up-old");

    const out = await commit(path, payload("2026-11-20T08:40:00.000Z", "up-new", { goals: ["new"] }), "2026-11-20T08:40:00.000Z", { mode: "unconditional" });
    expect(out.kind).toBe("advanced");
    const rows = await admin.query("SELECT k FROM kv WHERE k = $1 OR k LIKE $2", [path, `${path}#p%`]);
    expect(rows.rowCount).toBe(1);
    const after = await store.readSnapshot(path);
    expect(after!.version).toBe("2026-11-20T08:40:00.000Z");
    await clean(path);
  });

  it("清理阶段失败：整体回滚，主行与块行逐字节不变", async () => {
    const path = P("fail-cleanup");
    await clean(path);
    const old = db.encrypt(payload("2026-11-20T06:00:00.000Z", "up-old"));
    const mid = Math.floor(old.length / 2);
    await admin.query("INSERT INTO kv(k,v) VALUES ($1,$2),($3,$4)", [path, JSON.stringify({ __chunks__: 2 }), `${path}#p0`, old.slice(0, mid)]);
    await admin.query("INSERT INTO kv(k,v) VALUES ($1,$2)", [`${path}#p1`, old.slice(mid)]);
    const before = await admin.query("SELECT k, md5(v) AS h FROM kv WHERE k = $1 OR k LIKE $2 ORDER BY k", [path, `${path}#p%`]);

    await admin.query(
      "CREATE OR REPLACE FUNCTION ict_block_delete() RETURNS trigger AS $$ BEGIN IF OLD.k LIKE 'data/ict-test-fail-cleanup%#p%' THEN RAISE EXCEPTION 'ict-injected'; END IF; RETURN OLD; END; $$ LANGUAGE plpgsql"
    );
    await admin.query("DROP TRIGGER IF EXISTS ict_block_delete ON kv");
    await admin.query("CREATE TRIGGER ict_block_delete BEFORE DELETE ON kv FOR EACH ROW EXECUTE FUNCTION ict_block_delete()");

    const err = await commit(path, payload("2026-11-20T06:10:00.000Z"), "2026-11-20T06:10:00.000Z", { mode: "unconditional" }).catch((e) => e);
    expect(err).toBeTruthy();

    await admin.query("DROP TRIGGER ict_block_delete ON kv");
    const after = await admin.query("SELECT k, md5(v) AS h FROM kv WHERE k = $1 OR k LIKE $2 ORDER BY k", [path, `${path}#p%`]);
    expect(after.rows).toEqual(before.rows);
    await clean(path);
  });

  it("连续 20 次写入后无 idle in transaction 连接残留", async () => {
    const path = P("leak");
    await clean(path);
    const ts = (i: number) => new Date(Date.UTC(2026, 10, 20, 7, 0, i)).toISOString();
    for (let i = 0; i < 20; i++) {
      await commit(path, payload(ts(i), `up-${i}`, { goals: [String(i)] }), ts(i), i === 0 ? { mode: "absent" } : { mode: "unconditional" });
    }
    const res = await admin.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE state = 'idle in transaction'");
    expect(res.rows[0].n).toBe(0);
    await clean(path);
  });

  it("事务层 20 轮并发：每轮仅一个成功", async () => {
    const path = P("round20");
    await clean(path);
    for (let round = 0; round < 20; round++) {
      const base = new Date(Date.UTC(2026, 10, 20, 8, 0, round)).toISOString();
      await admin.query("DELETE FROM kv WHERE k = $1 OR k LIKE $2", [path, `${path}#p%`]);
      await commit(path, payload(base, "up-base", { r: round, tag: "base" }), base, { mode: "absent" });
      const token = (await store.readSnapshot(path))!.token;
      const ts = (n: number) => new Date(Date.UTC(2026, 10, 20, 8, 10 + n, round)).toISOString();
      const results = await Promise.allSettled([
        commit(path, payload(ts(1), `up-a${round}`, { r: round, tag: "a" }), ts(1), { mode: "match", token }, base),
        commit(path, payload(ts(2), `up-b${round}`, { r: round, tag: "b" }), ts(2), { mode: "match", token }, base),
      ]);
      expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected"), `round ${round}`).toHaveLength(1);
    }
    await clean(path);
  });
});

if (!TEST_URL) {
  describe("T-ICT-006~011 SKIP: TEST_RDS_URL 未提供", () => {
    it("显式跳过（不计入 PASS）", () => {
      expect(TEST_URL).toBeUndefined();
    });
  });
}