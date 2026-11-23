import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：auto 模式下未配 Upstash/D1 即落 GitHub 通道；若
 * GITHUB_DB_REPO/TOKEN 也没配，ghApi 请求 repos//contents/... 恒 404，而 dbGet/dbList
 * 把一切 404 当"文件不存在"返回 null/[]——verifySession 把在线用户判成"账号已注销"、
 * 登录判"账号不存在"、register 的重复邮箱检测失效，读全是静默假象，写却大声抛错。
 * 修复：与显式 github 模式同纪律 fail-fast。本锁钉住未配置即抛，且已配置部署不误伤。 */

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
  vi.unstubAllGlobals();
});

async function loadDb(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  return import("../server/db");
}

describe("auto 兜底 GitHub：凭据缺失 fail-fast（不再静默 404→null）", () => {
  it("无任何凭据 → dbGet/dbList 抛明确错误，绝不把 404 当成文件不存在", async () => {
    const db = await loadDb();
    expect(db.dbChannel()).toBe("github"); // 通道选择的历史行为不变
    await expect(db.dbGet("users/x.json")).rejects.toThrow(/无可用数据通道/);
    await expect(db.dbList("users")).rejects.toThrow(/无可用数据通道/);
  });

  it("配置了 GitHub 凭据 → 正常走 github（不误伤已配置部署；404 仍按文件不存在）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response));
    const db = await loadDb({ GITHUB_DB_REPO: "owner/repo", GITHUB_DB_TOKEN: "t" });
    await expect(db.dbGet("users/x.json")).resolves.toBeNull();
  });
});
