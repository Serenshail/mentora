import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：search 路由的 provider 顺序兜底链（Tavily→Brave→Bing→DDG）
 * 单次 fetch 各有 8s AbortSignal 超时，但整条链没有聚合 deadline——全上游同时挂起
 * （自托管出网被墙/DNS 黑洞时典型）最坏 8×4≈32s 串行（配双 API Key 时），突破设备认证
 * 注释里的「网关 15s 无数据熔断线」（device-auth.ts:17），用户拿到网关层 500 而非结构化
 * 502。同仓 fetch-page（TOTAL_TIMEOUT_MS=8s 全程 deadline）与 cron/expiry-reminder
 * （BUDGET_MS 分块预算）都有总预算纪律。
 * 修复：SEARCH_CHAIN_BUDGET_MS=14s 总闸，每个 provider 只拿 min(8s, 剩余)，耗尽即停。
 * 可控时钟偏移（与 expiry-reminder-budget.test.ts 同法）+ AbortSignal.timeout 原生实现
 * 缩到 100ms 实测（与 admin-feedback-state-timeout.test.ts 同法）。 */

const state = { skew: 0, baseNow: Date.now() };

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "198.51.100.7"),
}));

vi.mock("@/lib/server/auth", () => ({
  verifySession: vi.fn(async () => ({ userId: "u1", email: "u1@x.dev" })),
}));

import { POST } from "../../app/api/search/route";

const req = (query: string) =>
  ({
    headers: { get: () => null },
    json: async () => ({ query }),
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  state.skew = 0;
  vi.stubEnv("TAVILY_API_KEY", "tavily-key");
  vi.stubEnv("BRAVE_API_KEY", "brave-key");
  vi.spyOn(Date, "now").mockImplementation(() => state.baseNow + state.skew);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("search provider 链总预算", () => {
  it("首个 provider 挂起且预算已尽 → 剩余 provider 不再尝试，结构化 502（不撞网关熔断线）", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms?: number) => nativeTimeout(Math.min(ms ?? 0, 100)));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        (_url: RequestInfo | URL, init?: RequestInit) => {
          /* 第一个 provider 发起后即把时钟推过 14s 总预算 */
          state.skew = 20_000;
          return new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
            );
          });
        }
      );

    try {
      const t0 = performance.now();
      const res = await POST(req("rust ownership"));
      const elapsed = performance.now() - t0; // 用 performance.now：Date.now 已被可控偏移接管

      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("搜索上游不可用");
      /* 关键：预算耗尽后 brave/bing/duckduckgo 全部不再发起（旧实现 4×8s 串行） */
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      /* 首 provider 拿到 min(8s, 剩余预算)=8s 的预算（锁每 provider 的授予逻辑） */
      expect(timeoutSpy).toHaveBeenCalledWith(8_000);
      expect(elapsed).toBeLessThan(5_000); // signal 缩到 100ms：证明总闸立即生效
    } finally {
      timeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  }, 20_000);

  it("健康路径：首个 provider 命中即返回（总预算不误伤正常链路）", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ title: "Rust ownership explained", url: "https://example.dev/rust", content: "borrow checker" }] }),
        { status: 200 }
      )
    );
    try {
      const res = await POST(req("rust ownership"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { provider: string; results: { url: string }[] };
      expect(body.provider).toBe("tavily");
      expect(body.results).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
