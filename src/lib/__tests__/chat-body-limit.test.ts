import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/* chat 路由体积闸回归锁（修复：请求体先整读进内存再判 1MB，chunked 大包绕过一切前置闸）。
 * 修复后是双层闸：content-length 声明值超标 → 在鉴权/限流/读体之前直接 413；
 * chunked（无声明值）绕不过声明闸，由读取后的 raw.length 终闸兜底。
 * 这份锁钉住三件会真出事的事：
 *  1) 声明超标包在限流桶被查询之前就 413（超大请求不打疼 KV/内存）；
 *  2) chunked 超标包在整包缓冲完成后 413，绝不放行进 JSON 解析/上游调用；
 *  3) 正常体积的合法请求不被新闸误伤（仍走完原链路）。
 * Node fetch 无流式计量 API，req.text() 必然先缓冲整个请求体——
 * 本锁锁的是「缓冲之后、放行之前必拒」，不宣称能阻止缓冲本身。 */

vi.mock("server-only", () => ({}));

/* 内存限流桶替身：记录查询次数，用来断言「声明闸在限流之前」 */
const rlQueries: string[] = [];
vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async (key: string) => {
    rlQueries.push(key);
    return true;
  }),
  clientIp: vi.fn(() => "198.51.100.7"),
}));

vi.mock("@/lib/server/auth", () => ({ verifySession: vi.fn(async () => null) }));
vi.mock("@/lib/server/device-auth", () => ({
  verifyDeviceAuth: vi.fn(async () => null),
}));
vi.mock("@/lib/server/db", () => ({
  withBudget: vi.fn(async <T>(p: Promise<T>, fallback: T) => fallback ?? (await p)),
  dbEventSave: vi.fn(async () => {}),
}));
vi.mock("@/lib/server/entitlement", () => ({
  readEntitlement: vi.fn(async () => ({ status: "legacy", plan: null, expiresAt: null, daysLeft: null })),
}));
vi.mock("@/lib/server/usage", () => ({
  withinFreeBudget: vi.fn(async () => ({ ok: true, usedTokens: 0, limit: 200_000 })),
  addUsage: vi.fn(async () => ({})),
}));
vi.mock("@/lib/server/quota", () => ({
  checkAndCountServerKey: vi.fn(async () => ({ ok: true, used: 0, limit: 60 })),
}));
vi.mock("@/lib/server/deploy-env", () => ({ isDeployed: vi.fn(() => false) }));
vi.mock("@/lib/server/ai-config", () => ({
  resolveByok: vi.fn(async () => ({ error: "no", status: 401 })),
  serverConfig: vi.fn(() => ({
    provider: "demo",
    apiKey: "",
    model: "",
    baseUrl: "https://example.invalid/v1",
  })),
}));
vi.mock("@/lib/server/personal", () => ({ agentPersonalContext: vi.fn(async () => "") }));
vi.mock("@/lib/server/config", () => ({ logEvent: vi.fn(() => {}) }));

import { POST } from "@/app/api/chat/route";

/* 构造一个最小 NextRequest 形状（route 只用 headers.get / text()） */
function makeReq(opts: {
  text: () => Promise<string>;
  contentLength?: string;
  cookie?: string;
}): NextRequest {
  const headers = new Headers();
  if (opts.contentLength !== undefined) headers.set("content-length", opts.contentLength);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return {
    headers,
    text: opts.text,
  } as unknown as NextRequest;
}

const JSON_AT_1M = JSON.stringify({
  messages: [{ role: "user", content: "x".repeat(1_000_000) }],
});

beforeEach(() => {
  rlQueries.length = 0;
});

describe("chat 体积闸（content-length 预检 + chunked 终闸）", () => {
  it("声明 content-length 超标：在限流桶被查询之前就 413", async () => {
    const res = await POST(makeReq({ text: async () => "", contentLength: "1000001" }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "请求体过大" });
    expect(rlQueries).toEqual([]); // 没碰限流（证明闸在鉴权/限流之前）
  });

  it("声明值恰好等于上限 1_000_000：不触发预检，进入链路", async () => {
    // 小包喂进去；此处只关心没被声明闸拦下（status ≠ 413 即可）
    const res = await POST(
      makeReq({
        text: async () => '{"messages":[]}',
        contentLength: String(1_000_000),
        cookie: "mentora_session=1",
      })
    );
    expect(res.status).not.toBe(413);
    expect(rlQueries).toEqual(["chat:198.51.100.7"]); // 限流已查询，说明走过了预检
  });

  it("chunked 无声明值（绕过预检）：读取后终闸 413，绝不放行", async () => {
    // 模拟 Node fetch 的真实行为：text() 会把整个 1M+ 请求体缓冲完才返回
    const res = await POST(
      makeReq({
        text: async () => JSON_AT_1M, // 1_000_045 字符 > 上限
        contentLength: undefined, // chunked：没有 content-length 头
        cookie: "mentora_session=1",
      })
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "请求体过大" });
    expect(rlQueries).toEqual(["chat:198.51.100.7"]); // 先过限流，再被终闸拦下
  });

  it("正常小请求不被误伤：demo 模式走完返回 NDJSON 流", async () => {
    const res = await POST(
      makeReq({
        text: async () => '{"messages":[{"role":"user","content":"hi"}]}',
        contentLength: "46",
        cookie: "mentora_session=1",
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const text = await res.text();
    expect(text).toContain('{"t":"p"}');
    expect(text).toContain('{"t":"end"}');
  });
});
