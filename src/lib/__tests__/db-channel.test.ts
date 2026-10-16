import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* db.ts 是服务端模块（import "server-only"），在 vitest 里需要豁免该护栏 */
vi.mock("server-only", () => ({}));

/* ============ 存储层双通道路由回归锁（HW-T-01/02/05） ============
 * db.ts 的通道常量在模块加载时固化（UPSTASH_URL 等），
 * 因此每个场景用 vi.resetModules + 动态 import 模拟不同 env 注入。 */

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
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function loadDb(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  return import("../server/db");
}

describe("dbChannel()：通道判定矩阵", () => {
  it("auto 缺省 + 无任何凭据 → github 兜底（与历史行为一致）", async () => {
    const db = await loadDb();
    expect(db.dbChannel()).toBe("github");
    expect(db.hasRemoteDb()).toBe(false);
  });

  it("auto + Upstash 凭据 → upstash 优先（隐式优先级最高）", async () => {
    const db = await loadDb({
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "t",
    });
    expect(db.dbChannel()).toBe("upstash");
    expect(db.hasRemoteDb()).toBe(true);
  });

  it("auto + 仅 D1 凭据 → d1 次优先", async () => {
    const db = await loadDb({
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_D1_DATABASE_ID: "b",
      CLOUDFLARE_D1_API_TOKEN: "c",
    });
    expect(db.dbChannel()).toBe("d1");
    expect(db.hasRemoteDb()).toBe(true);
  });

  it("auto + 同时配置 Upstash/D1 → upstash 优先（历史隐式顺序）", async () => {
    const db = await loadDb({
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "t",
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_D1_DATABASE_ID: "b",
      CLOUDFLARE_D1_API_TOKEN: "c",
    });
    expect(db.dbChannel()).toBe("upstash");
  });

  it("显式 huawei → huawei（凭据是否齐备由请求时 fail-fast 把关）", async () => {
    const db = await loadDb({ DB_CHANNEL: "huawei", DATABASE_URL: "postgres://u:p@127.0.0.1:5432/m", REDIS_URL: "redis://127.0.0.1:6379" });
    expect(db.dbChannel()).toBe("huawei");
  });

  it("非法 DB_CHANNEL 值 → 回落 auto（不 crash）", async () => {
    const db = await loadDb({ DB_CHANNEL: "oracle" });
    expect(db.dbChannel()).toBe("github");
  });

  it("大写 DB_CHANNEL 值 → 容忍大小写", async () => {
    const db = await loadDb({ DB_CHANNEL: "HUAWEI", DATABASE_URL: "postgres://u:p@127.0.0.1:5432/m", REDIS_URL: "redis://127.0.0.1:6379" });
    expect(db.dbChannel()).toBe("huawei");
  });
});

describe("显式锁定旧通道：凭据缺失 fail-fast（不静默换道）", () => {
  it("DB_CHANNEL=upstash 无凭据 → dbGet 抛明确错误", async () => {
    const db = await loadDb({ DB_CHANNEL: "upstash" });
    await expect(db.dbGet("users/x.json")).rejects.toThrow(/UPSTASH_REDIS_REST_\*/);
  });

  it("DB_CHANNEL=d1 无凭据 → dbGet 抛明确错误", async () => {
    const db = await loadDb({ DB_CHANNEL: "d1" });
    await expect(db.dbGet("users/x.json")).rejects.toThrow(/CLOUDFLARE_D1_\*/);
  });

  it("DB_CHANNEL=github 无凭据 → dbGet 抛明确错误", async () => {
    const db = await loadDb({ DB_CHANNEL: "github" });
    await expect(db.dbGet("users/x.json")).rejects.toThrow(/GITHUB_DB_\*/);
  });
});

describe("huawei 模式：前缀分流与凭据 fail-fast", () => {
  it("数据真源前缀（users/）无 DATABASE_URL → 抛明确错误", async () => {
    const db = await loadDb({ DB_CHANNEL: "huawei", REDIS_URL: "redis://127.0.0.1:6379" });
    await expect(db.dbGet("users/abc.json")).rejects.toThrow(/DATABASE_URL/);
  });

  it("跨进程状态前缀（rl/）无 REDIS_URL → 抛明确错误", async () => {
    const db = await loadDb({ DB_CHANNEL: "huawei", DATABASE_URL: "postgres://u:p@127.0.0.1:5432/m" });
    await expect(db.dbGet("rl/1.2.3.4")).rejects.toThrow(/REDIS_URL/);
  });

  it("四个跨进程前缀都路由 DCS、其余路由 RDS（凭据齐备时以 fail-fast 边界区分）", async () => {
    const db = await loadDb({ DB_CHANNEL: "huawei" });
    // 只配 DCS：数据真源前缀必须报 DATABASE_URL 缺失；状态前缀不能报 DATABASE_URL（说明路由到了 DCS 侧）
    for (const p of ["rl/x", "code/x", "quota/x", "loginfail/dev/x"]) {
      await expect(db.dbGet(p), `${p} 应路由 DCS`).rejects.toThrow(/REDIS_URL/);
    }
    for (const p of ["users/x.json", "data/x.json", "versions/x.json", "misc/x.json"]) {
      await expect(db.dbGet(p), `${p} 应路由 RDS`).rejects.toThrow(/DATABASE_URL/);
    }
  });

  it("huawei 模式 DCS 未配置时 hasRemoteDb=false（best-effort 降级进程内桶的前提）", async () => {
    const db = await loadDb({ DB_CHANNEL: "huawei", DATABASE_URL: "postgres://u:p@127.0.0.1:5432/m" });
    expect(db.hasRemoteDb()).toBe(false);
  });

  it("huawei 模式 DCS 配置后 hasRemoteDb=true", async () => {
    const db = await loadDb({ DB_CHANNEL: "huawei", REDIS_URL: "redis://127.0.0.1:6379" });
    expect(db.hasRemoteDb()).toBe(true);
  });
});

describe("加密透传语义（各通道共用，HW-T-02）", () => {
  it("encrypt → decrypt 往返等价（gzip + AES-256-GCM）", async () => {
    const db = await loadDb({ AUTH_SECRET: "test-secret" });
    const obj = { a: 1, nested: { list: [1, 2, 3] }, 中文: "值" };
    const sealed = db.encrypt(obj);
    expect(sealed.startsWith("GZ1.")).toBe(true);
    expect(sealed).not.toContain("中文"); // 密文不含明文
    expect(db.decrypt<typeof obj>(sealed)).toEqual(obj);
  });

  it("大对象（>380KB，D1 分块阈值量级）加密往返无损", async () => {
    const db = await loadDb({ AUTH_SECRET: "test-secret" });
    const big = { blob: "x".repeat(500_000) };
    expect(db.decrypt<{ blob: string }>(db.encrypt(big)).blob.length).toBe(500_000);
  });

  it("AUTH_SECRET 未配置 → encrypt 抛错（fail-fast，不落明文）", async () => {
    const db = await loadDb();
    expect(() => db.encrypt({ a: 1 })).toThrow(/AUTH_SECRET/);
  });
});