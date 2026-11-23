import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：feedback POST 对 GitHub Issues API 的 fetch 曾无任何
 * AbortSignal.timeout——db.ts:67 REMOTE_FETCH_TIMEOUT_MS=5000 覆盖了 db 层全部远端调用，
 * admin/feedback-state/route.ts 更以成文注释规定「全站远端调用统一 5s 硬超时」；
 * 本路由是同类远端调用却漏配：GitHub API 网络黑洞时请求挂到 undici headersTimeout
 * 默认 300s（Vercel maxDuration=30 有兜底，腾讯云自托管长驻 Node 没有），期间占住连接槽、
 * 用户侧长时间无响应；公开端点属性使故障期每个提交都挂满。
 * 锁三件事（与 admin-feedback-state-timeout.test.ts 同法）：
 *  1) 确实传 AbortSignal.timeout(5_000)，且挂起时 signal 真触发（原生实现缩到 300ms 实测）
 *     → 504「超时」显式定性，不是笼统「网络错误」；
 *  2) 上游正常 → 200 ok，存量成功路径不被新 signal 误伤；
 *  3) 上游连接失败（TypeError: fetch failed）→ 仍走 502「网络错误」分支，不误报为超时。 */

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/server/db", () => ({
  dbFeedbackSave: vi.fn(async () => undefined),
}));

import { POST } from "../../app/api/feedback/route";

const req = () =>
  ({
    headers: { get: () => null },
    json: async () => ({ content: "搜索页在手机上不能滚动", type: "问题", contact: "" }),
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  vi.stubEnv("GITHUB_TOKEN", "t");
  vi.stubEnv("GITHUB_REPO", "x/y");
});

describe("feedback GitHub fetch 5s 硬超时", () => {
  it("上游挂起 → AbortSignal.timeout(5_000) 真触发 TimeoutError，路由 504 显式定性", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms?: number) => nativeTimeout(Math.min(ms ?? 0, 300)));
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

    try {
      const t0 = Date.now();
      const res = await POST(req());
      const elapsed = Date.now() - t0;

      expect(res.status).toBe(504);
      expect(timeoutSpy).toHaveBeenCalledWith(5_000);
      expect(elapsed).toBeLessThan(5_000); // 300ms 缩短定时器：证明是 signal 真触发
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("超时");
      expect(body.error).not.toContain("网络错误");
    } finally {
      timeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  }, 20_000);

  it("上游正常 → 200 ok，成功路径不受新增 signal 影响", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ number: 7, html_url: "https://github.com/x/y/issues/7" }), { status: 201 })
      );

    try {
      const res = await POST(req());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; number: number; url: string };
      expect(body).toEqual({ ok: true, number: 7, url: "https://github.com/x/y/issues/7" });
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("上游拒绝连接（fetch failed）→ 仍 502「网络错误」，不误报为超时", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));

    try {
      const res = await POST(req());
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("网络错误");
      expect(body.error).not.toContain("超时");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
