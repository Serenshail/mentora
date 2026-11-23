import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归:/api/admin/feedback-state 的 GitHub issue PATCH 曾是最后一处无 AbortSignal.timeout 的
 * 出站 fetch——全站纪律是远端调用 5s 硬超时（db.ts:64 REMOTE_FETCH_TIMEOUT_MS=5_000，
 * overview 拉取 10s 同理）。裸 fetch 时 GitHub API 网络黑洞会挂到 undici headersTimeout
 * 300s：Vercel maxDuration=30 有平台强杀兜底，腾讯云自托管长驻 Node 没有 → 请求占连接槽、
 * 管理端长时间无响应。
 * 锁三件事：
 *  1) 路由确实传 AbortSignal.timeout(5_000)，且挂起时 signal 真触发（原生实现缩到 300ms
 *     实测）→ 返回 504「处理超时」，不是笼统「网络错误」；
 *  2) 上游正常 → 200 ok，存量成功路径不被新 signal 误伤；
 *  3) 上游连接失败（TypeError: fetch failed）→ 仍走 502「网络错误」分支，不误报为超时。 */

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("../server/admin-auth", () => ({
  authorizeAdmin: vi.fn(async () => ({ email: "admin@x.com", name: "admin" })),
}));

import { POST } from "../../app/api/admin/feedback-state/route";

const req = (body: unknown) =>
  ({
    headers: { get: () => null },
    json: async () => body,
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("admin feedback-state GitHub PATCH 超时兜底", () => {
  it("上游挂起 → AbortSignal.timeout(5_000) 真触发 TimeoutError，路由 504 且错误信息显式定性", async () => {
    /* AbortSignal.timeout 是 Node 原生实现，假定时器推不动；与 admin-overview-feedback-timeout
     * 同法：先捕获原生实现再包一层、上限缩到 300ms 实测「signal 会真的 abort」，同时用
     * toHaveBeenCalledWith 锁定生产常量 5_000（远小于 undici headersTimeout 300s）。 */
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms?: number) => nativeTimeout(Math.min(ms ?? 0, 300)));
    /* 挂起的真实 fetch 表现：请求永不完成，仅在 signal abort 时以 TimeoutError 拒绝 */
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
            );
          })
      );
    vi.stubEnv("GITHUB_TOKEN", "t-hang");
    vi.stubEnv("GITHUB_REPO", "x/y");

    try {
      const t0 = Date.now();
      const res = await POST(req({ number: 7, state: "closed" }));
      const elapsed = Date.now() - t0;

      expect(res.status).toBe(504);
      expect(timeoutSpy).toHaveBeenCalledWith(5_000);
      expect(elapsed).toBeLessThan(5_000); // 300ms 缩短定时器：证明是 signal 真触发，不是 mock 直接拒绝
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("超时");
      expect(body.error).not.toBe("网络错误");
    } finally {
      timeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  }, 20_000);

  it("上游正常返回 → 200 ok，成功路径不受新增 signal 影响", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ number: 7, state: "closed" }), { status: 200 }));
    vi.stubEnv("GITHUB_TOKEN", "t-ok");
    vi.stubEnv("GITHUB_REPO", "x/y");

    try {
      const res = await POST(req({ number: 7, state: "closed" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; state: string };
      expect(body).toEqual({ ok: true, state: "closed" });
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("上游拒绝连接（fetch failed）→ 仍 502「网络错误」，不误报为超时", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("fetch failed"));
    vi.stubEnv("GITHUB_TOKEN", "t-fail");
    vi.stubEnv("GITHUB_REPO", "x/y");

    try {
      const res = await POST(req({ number: 7, state: "open" }));
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("网络错误");
      expect(body.error).not.toContain("超时");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
