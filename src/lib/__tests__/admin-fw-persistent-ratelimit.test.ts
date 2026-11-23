import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* ============ 回归锁：proxy 的 admin 专项限流必须是跨实例持久桶 ============
 * proxy.ts 曾用进程内 rateLimit 做 /api/admin 的 30 次/分/IP 专项限流，注释声称
 * "严打爆破"。但 rate-limit.ts:10-13 自己写明进程内桶在 Vercel 多实例下每实例
 * 独立计数、isolate 回收即清零——实际放行 ≈ 30×N 次/分/IP，admin 密码爆破防线
 * 强度只有注释声称的 1/N。本锁钉死：
 *  1) admin 路径调用 rateLimitPersistent（不是进程内 rateLimit），参数仍是 30/0.5；
 *  2) 键带独立 fw 命名空间——overview/stats 路由级桶用 `admin:<ip>` 且容量 10/分，
 *     共用键会让两个不同 capacity 的调用互改同一桶，把路由预算砍半；
 *  3) 持久桶拒绝 → 429，且不再落到全站桶；
 *  4) 非 admin 的 /api 路径仍走进程内全站粗筛桶（不在每个 API 请求上做 KV 读写）。 */

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(() => true),
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "203.0.113.7"),
  /* 透传预算包装：真实实现见 db.ts withBudget，这里只验证 proxy 给了硬预算与降级值。
   * 形参按真实签名 (p, fallback, ms) 声明为元组，否则 mock.calls 取不到后两个参数。 */
  withBudget: vi.fn(async (...args: [Promise<boolean>, boolean, number]) => args[0]),
}));

vi.mock("../server/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  rateLimitPersistent: mocks.rateLimitPersistent,
  clientIp: mocks.clientIp,
}));

vi.mock("../server/db", () => ({
  withBudget: mocks.withBudget,
}));

import { proxy } from "../../proxy";

/** proxy 只读 nextUrl.pathname/search、method、url、headers、cookies（后者仅非 API 路径） */
function makeReq(pathname: string) {
  return {
    nextUrl: { pathname, search: "" },
    method: "GET",
    url: `https://mentora.example${pathname}`,
    headers: new Headers({ "user-agent": "Mozilla/5.0" }),
    cookies: { get: () => undefined },
  } as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockReturnValue(true);
  mocks.rateLimitPersistent.mockResolvedValue(true);
  mocks.clientIp.mockReturnValue("203.0.113.7");
});

describe("proxy admin 专项限流走持久桶", () => {
  it("admin 路径 → rateLimitPersistent，键 admin:fw:<ip>，参数 30/0.5", async () => {
    await proxy(makeReq("/api/admin/overview"));

    expect(mocks.rateLimitPersistent).toHaveBeenCalledTimes(1);
    const [key, opts] = mocks.rateLimitPersistent.mock.calls[0] as unknown as [
      string,
      { capacity: number; refillPerSec: number },
    ];
    expect(key).toBe("admin:fw:203.0.113.7");
    expect(opts).toEqual({ capacity: 30, refillPerSec: 0.5 });
    /* KV 慢/故障时降级放行：预算 1200ms、fallback=true（与 chat 同口径） */
    expect(mocks.withBudget).toHaveBeenCalledTimes(1);
    expect(mocks.withBudget.mock.calls[0][1]).toBe(true);
    expect(mocks.withBudget.mock.calls[0][2]).toBe(1200);
    /* 进程内桶不得再承担 admin 专项防线 */
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.rateLimit).toHaveBeenCalledWith("api:203.0.113.7", { capacity: 120, refillPerSec: 2 });
  });

  it("持久桶超限 → 429，且不再落到全站桶", async () => {
    mocks.rateLimitPersistent.mockResolvedValue(false);
    const res = await proxy(makeReq("/api/admin/users"));
    expect(res.status).toBe(429);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("非 admin 的 /api 路径 → 不碰持久桶，仅进程内全站粗筛", async () => {
    const res = await proxy(makeReq("/api/tasks"));
    expect(mocks.rateLimitPersistent).not.toHaveBeenCalled();
    expect(mocks.withBudget).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledWith("api:203.0.113.7", { capacity: 120, refillPerSec: 2 });
    expect(res.status).toBe(200);
  });

  it("全站桶超限 → 429（原有行为不回归）", async () => {
    mocks.rateLimit.mockReturnValue(false);
    const res = await proxy(makeReq("/api/tasks"));
    expect(res.status).toBe(429);
  });
});
