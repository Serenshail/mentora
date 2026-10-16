import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* db.ts 是服务端模块（import "server-only"），在 vitest 里需要豁免该护栏 */
vi.mock("server-only", () => ({}));

/* ============ T-043 events 漏斗/chat-usage 聚合回归锁（HW-V-02） ============ */

const ENV_KEYS = [
  "AUTH_SECRET", "DB_CHANNEL",
  "DATABASE_URL", "REDIS_URL",
  "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_D1_API_TOKEN",
] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
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

describe("aggregateChatUsage()：chat-usage props 聚合", () => {
  it("按 provider 分桶汇总 calls/tokens，byok 计数正确", async () => {
    const db = await loadDb();
    const r = db.aggregateChatUsage([
      JSON.stringify({ provider: "maas", prompt_tokens: 100, completion_tokens: 50 }),
      JSON.stringify({ provider: "maas", prompt_tokens: 10, completion_tokens: 5, byok: 1 }),
      JSON.stringify({ provider: "deepseek", prompt_tokens: 7, completion_tokens: 3 }),
    ]);
    expect(r.totalCalls).toBe(3);
    expect(r.promptTokens).toBe(117);
    expect(r.completionTokens).toBe(58);
    expect(r.byProvider.maas).toEqual({ calls: 2, promptTokens: 110, completionTokens: 55, byok: 1 });
    expect(r.byProvider.deepseek.calls).toBe(1);
  });

  it("脏数据容错：坏 JSON 跳过、缺 provider 归 unknown、缺 token 记 0", async () => {
    const db = await loadDb();
    const r = db.aggregateChatUsage([
      "not-json",
      JSON.stringify({ provider: "" }),
      JSON.stringify({ prompt_tokens: "x", completion_tokens: null }),
    ]);
    expect(r.totalCalls).toBe(2);
    expect(r.byProvider.unknown.calls).toBe(2);
    expect(r.byProvider.unknown.promptTokens).toBe(0);
    expect(r.promptTokens).toBe(0);
  });

  it("空窗口 → 全零汇总", async () => {
    const db = await loadDb();
    const r = db.aggregateChatUsage([]);
    expect(r).toEqual({
      window: 0, totalCalls: 0, promptTokens: 0, completionTokens: 0, byProvider: {},
    });
  });
});

describe("dbEventStats()：远端库不可用时如实返回 null", () => {
  it("无任何事件库凭据 → null（端点据此报 503，不伪造漏斗数据）", async () => {
    const db = await loadDb();
    expect(await db.dbEventStats()).toBeNull();
  });
});