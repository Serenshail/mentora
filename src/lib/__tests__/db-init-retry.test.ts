import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* db.ts 是服务端模块（import "server-only"），在 vitest 里需要豁免该护栏 */
vi.mock("server-only", () => ({}));

/* ============ 冷启动建表失败不得永久缓存（d1Init / rdsInit） ============
 * 回归锁：d1Init/rdsInit 曾用 `ready ??= (...)()` 把首个 Promise 永久缓存，
 * 冷启动首触一次瞬时失败会把 rejected Promise 钉死在整个 isolate，
 * 此后每次读写都撞同一个错误直到进程回收。正确纪律与 ensureAuxTable 一致：
 * 失败清空缓存、下次调用重试；成功才复用。 */

const pgQuery = vi.hoisted(() => vi.fn());
vi.mock("pg", () => {
  class Pool {
    on() { /* rdsPool 会注册 'error' 监听 */ }
    query(sql: string, params?: unknown[]) {
      return pgQuery(sql, params);
    }
  }
  return { Pool, default: { Pool } };
});

const ENV_KEYS = [
  "AUTH_SECRET", "DB_CHANNEL",
  "DATABASE_URL", "REDIS_URL",
  "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_D1_API_TOKEN",
  "GITHUB_DB_REPO", "GITHUB_DB_TOKEN",
] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  pgQuery.mockReset();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

async function loadDb(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  return import("../server/db");
}

const D1_ENV = {
  CLOUDFLARE_ACCOUNT_ID: "acc",
  CLOUDFLARE_D1_DATABASE_ID: "db",
  CLOUDFLARE_D1_API_TOKEN: "tok",
};

/* D1 HTTP 响应桩：400 是确定性失败（withRetry 不重试），让首触快速抛错 */
function d1Response(ok: boolean, results: unknown[] = []) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => (ok
      ? { success: true, result: [{ results }] }
      : { success: false, errors: [{ message: "boom" }] }),
    text: async () => "",
  } as unknown as Response;
}

describe("d1Init：建表失败后不缓存 rejected Promise", () => {
  it("首触建表失败 → 本次抛错；下次调用重试建表并成功", async () => {
    const db = await loadDb(D1_ENV);
    const fetchMock = vi.fn();
    let ddlAttempts = 0;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { sql: string };
      if (body.sql.startsWith("CREATE TABLE")) {
        ddlAttempts += 1;
        return ddlAttempts === 1 ? d1Response(false) : d1Response(true);
      }
      return d1Response(true, []); // SELECT 无行
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(db.dbGet("users/x.json")).rejects.toThrow(/D1 请求失败/);
    expect(ddlAttempts).toBe(1);

    // 关键：缓存已清空，第二次调用会重新建表而不是复用 rejected Promise
    await expect(db.dbGet("users/x.json")).resolves.toBeNull();
    expect(ddlAttempts).toBe(2);
  });

  it("建表成功后缓存复用（每个 isolate 只跑一次 DDL）", async () => {
    const db = await loadDb(D1_ENV);
    let ddlAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { sql: string };
      if (body.sql.startsWith("CREATE TABLE")) ddlAttempts += 1;
      return d1Response(true, []);
    }));

    await db.dbGet("users/a.json");
    await db.dbGet("users/b.json");
    expect(ddlAttempts).toBe(1);
  });
});

describe("rdsInit：建表失败后不缓存 rejected Promise", () => {
  const RDS_ENV = { DB_CHANNEL: "huawei", DATABASE_URL: "postgres://u:p@127.0.0.1:5432/m" };

  it("首触建表失败 → 本次抛错；下次调用重试建表并成功", async () => {
    const db = await loadDb(RDS_ENV);
    let ddlAttempts = 0;
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("CREATE TABLE")) {
        ddlAttempts += 1;
        if (ddlAttempts === 1) throw new Error("connection reset");
      }
      return { rows: [] };
    });

    // 建表走 rdsInit 内的裸 pool.query，错误原样抛出（不经过 rdsQuery 的包装）
    await expect(db.dbGet("users/x.json")).rejects.toThrow(/connection reset/);
    expect(ddlAttempts).toBe(1);

    await expect(db.dbGet("users/x.json")).resolves.toBeNull();
    expect(ddlAttempts).toBe(2);
  });

  it("建表成功后缓存复用（每进程只跑一次 DDL）", async () => {
    const db = await loadDb(RDS_ENV);
    let ddlAttempts = 0;
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("CREATE TABLE")) ddlAttempts += 1;
      return { rows: [] };
    });

    await db.dbGet("users/a.json");
    await db.dbGet("users/b.json");
    expect(ddlAttempts).toBe(1);
  });
});
