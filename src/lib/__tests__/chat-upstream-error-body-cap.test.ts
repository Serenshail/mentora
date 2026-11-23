import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/* ============ /api/chat：上游非 2xx 错误体必须限量 + 限时读取 ============
 * 修复前 `await res.text()`：无体积上限、无空闲超时（而且 398 行已经 clearTimeout(timer)，
 * 这条路径连代头超时都没有）。BYOK custom 端点是用户自建服务器（resolveByok 只校验
 * 地址公网 HTTPS，不约束响应），恶意端点可返回超大错误体把函数内存打爆，或慢速滴流
 * 让本次调用无限期挂起，而 5s 心跳一直在替客户端保活。
 * linkcheck 的 readHead 对同一隐患已有结论（res.text() 构成带宽/内存放大器）并实现
 * 200KB 上限；本锁钉住 chat 侧同款纪律：超限即 cancel、超时即放弃，只取前缀进日志。 */

vi.mock("server-only", () => ({}));

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "198.51.100.11"),
}));
vi.mock("@/lib/server/auth", () => ({
  verifySession: vi.fn(async () => ({ userId: "u1", email: "u@example.com", name: "U" })),
}));
vi.mock("@/lib/server/device-auth", () => ({ verifyDeviceAuth: vi.fn(async () => null) }));
vi.mock("@/lib/server/db", () => ({
  withBudget: vi.fn(async (p: Promise<unknown>, fallback: unknown) => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  }),
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
    provider: "custom",
    apiKey: "sk-user",
    model: "my-model",
    baseUrl: "https://byok.example.com/v1",
  })),
}));
vi.mock("@/lib/server/personal", () => ({ agentPersonalContext: vi.fn(async () => "") }));
vi.mock("@/lib/server/config", () => ({ logEvent: vi.fn(() => {}) }));

import { POST } from "@/app/api/chat/route";

const encoder = new TextEncoder();
const produced: number[] = [];

/* 上游替身：非 2xx + 一个「无限」错误体。每产出一块记一笔，用于断言没被读干。 */
function upstreamErrorStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      produced.push(1);
      if (produced.length > 500) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode("E".repeat(4096)));
    },
  });
}

function makeReq(): NextRequest {
  const payload = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
  const headers = new Headers();
  headers.set("cookie", "mentora_session=1");
  return {
    headers,
    body: null,
    text: async () => payload,
  } as unknown as NextRequest;
}

async function drain(res: Response): Promise<string> {
  return await res.text();
}

beforeEach(() => {
  produced.length = 0;
  globalThis.fetch = (async () =>
    new Response(upstreamErrorStream(), {
      status: 502,
      headers: { "Content-Type": "text/html" },
    })) as unknown as typeof fetch;
});

describe("/api/chat 上游错误体读取预算", () => {
  it("超大错误体：读满预算即 cancel，不把整包读进内存", async () => {
    const res = await POST(makeReq());
    await drain(res);
    /* 每块 4KB、预算 4KB：读 1-2 块就停；上游可产 500 块（2MB）。
     * 旧实现会把 500 块全部读进内存。 */
    expect(produced.length).toBeLessThan(10);
  });

  it("错误体只取前缀进日志，用户可见错误不含上游原始报文", async () => {
    const res = await POST(makeReq());
    const text = await drain(res);
    expect(text).toContain("上游模型暂时不可用");
    // 日志前缀最多 300 字（fetchUpstream 里 slice(0, 300)），绝不会把 2MB 带进响应
    expect(text.length).toBeLessThan(5000);
  });
});
