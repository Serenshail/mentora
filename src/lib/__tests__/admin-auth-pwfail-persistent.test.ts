import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* ============ 回归锁：后台密码失败桶必须是持久桶（FIX 2026-11-10）============
 * admin-auth.ts 的失败桶此前用进程内 rateLimit：Vercel 多实例下每实例独立计数，
 * 攻击者轮换源 IP / 命中不同实例即可线性放大 x-admin-password 猜测速率。7 个 admin
 * 路由里 6 个有路由级 rateLimitPersistent 兜底，唯独 reading-metrics 只有这一层
 * （proxy.ts 的 admin 全局桶也是进程内）→ 该路由的爆破防线跨实例失效。
 * 本锁钉死三件事：
 *  1) 密码失败路径调用 rateLimitPersistent（不是进程内 rateLimit）；
 *  2) 限流命中即返回 bad-password，不再进入会话校验；
 *  3) 密码正确时完全不走限流桶（正常管理员零影响）。 */

const mocks = vi.hoisted(() => ({
  rateLimitPersistent: vi.fn(async () => true),
  rateLimit: vi.fn(() => true),
  clientIp: vi.fn(() => "203.0.113.7"),
  verifySession: vi.fn(async () => null),
}));

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: mocks.rateLimitPersistent,
  rateLimit: mocks.rateLimit,
  clientIp: mocks.clientIp,
}));

vi.mock("../server/auth", () => ({
  verifySession: mocks.verifySession,
}));

import { authorizeAdminDetailed } from "../server/admin-auth";

/** 只实现 headers.get：admin-auth 只读 x-admin-password */
function reqWithPassword(pw: string | null) {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "x-admin-password" ? pw : null) },
  } as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.rateLimitPersistent.mockResolvedValue(true);
  mocks.rateLimit.mockReturnValue(true);
  mocks.verifySession.mockResolvedValue(null);
  vi.stubEnv("ADMIN_PASSWORD", "correct-horse");
});

describe("admin 密码失败桶走持久限流", () => {
  it("错误密码 → 调用 rateLimitPersistent，且键含 IP 与 pwfail 前缀", async () => {
    const r = await authorizeAdminDetailed(reqWithPassword("wrong"));
    expect(r).toEqual({ ok: false, reason: "bad-password" });
    expect(mocks.rateLimitPersistent).toHaveBeenCalledTimes(1);
    const [key, opts] = mocks.rateLimitPersistent.mock.calls[0] as unknown as [
      string,
      { capacity: number; refillPerSec: number },
    ];
    expect(key).toBe("admin-pwfail/203.0.113.7");
    expect(opts).toEqual({ capacity: 15, refillPerSec: 0.25 });
    // 进程内桶不得再承担这条防线
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("持久桶超限 → 直接 bad-password，不再查会话", async () => {
    mocks.rateLimitPersistent.mockResolvedValue(false);
    const r = await authorizeAdminDetailed(reqWithPassword("wrong"));
    expect(r).toEqual({ ok: false, reason: "bad-password" });
    expect(mocks.verifySession).not.toHaveBeenCalled();
  });

  it("密码正确 → 成功放行且完全不走限流桶（正常管理员零影响）", async () => {
    const r = await authorizeAdminDetailed(reqWithPassword("correct-horse"));
    expect(r).toEqual({ ok: true, email: "admin-password", name: "后台密码" });
    expect(mocks.rateLimitPersistent).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("未带密码头 → 不进失败桶（无密码可爆破）", async () => {
    mocks.verifySession.mockResolvedValue(null);
    const r = await authorizeAdminDetailed(reqWithPassword(null));
    expect(r).toEqual({ ok: false, reason: "no-session" });
    expect(mocks.rateLimitPersistent).not.toHaveBeenCalled();
  });
});
