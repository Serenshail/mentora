import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：匿名可调的 POST /api/linkcheck 曾用裸 req.json() 读请求体——
 * 本文件仅做每 IP 20/min 限流，req.json() 一次性整包缓冲。项目自身纪律（body-limit.ts
 * 头注释）明确：自托管（Caddy 默认不限 body）下「攻击者用限流额度内的请求发 GB 级 JSON，
 * JSON.parse 的内存尖峰足以 OOM 杀掉单进程 Node」；auth 全系、chat、sync 都已接入
 * readJsonBody/readTextBodyWithLimit 双层闸，body-limit 助手的使用清单里漏了 linkcheck。
 * 修复：接入 readJsonBody，超标回 413；空/正常载荷路径行为不变。 */

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "fixture"),
}));

vi.mock("@/lib/server/url-guard", () => ({
  assertSafePublicUrl: vi.fn(async () => ({ ok: true })),
}));

import { POST } from "../../app/api/linkcheck/route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("linkcheck POST 请求体体积闸", () => {
  it("声明体积超 512KB → 413，不发起任何检测请求", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const req = {
      headers: new Headers({ "content-length": String(600_000) }),
      json: async () => ({ urls: ["https://example.org/a"] }),
    } as unknown as import("next/server").NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("过大");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("正常小载荷不受闸影响：空 urls 照常返回 200 + 空结果", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const req = {
      json: async () => ({ urls: [] }),
    } as unknown as import("next/server").NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("无 content-length 的 chunked 包由流式终闸兜底（替身流超限即断，绝不整包缓冲）", async () => {
    /* 构造一个 600KB 的异步可迭代 body：单块 1KB × 600 */
    const chunk = new Uint8Array(1024);
    async function* gen() {
      for (let i = 0; i < 600; i++) yield chunk;
    }
    const req = {
      json: async () => ({ urls: [] }),
      body: gen(),
    } as unknown as import("next/server").NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(413);
  });
});
