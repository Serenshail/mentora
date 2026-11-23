import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/* /api/chat 请求体流式限量回归锁（修复：req.text() 先整包缓冲再判 1MB）。
 *
 * 旧实现的真实风险：chunked（无 content-length）请求体不受任何声明闸约束，
 * req.text() 会把任意体积先灌进内存，`raw.length > 1_000_000` 只是在堆被占满
 * 之后补开的一张罚单——注释宣称的「防打爆内存」对分块包并不成立。
 *
 * 修复后 /api/chat 走 readTextBodyWithLimit()（与 auth 端点同一纪律）：
 *  1) 声明闸：content-length 超标 → 不读一字节、不查限流桶就 413；
 *  2) 流式终闸：按块累计字节数，一超限立即返回 null，for-await 提前退出会
 *     cancel 底层流——后续块永不再进内存（这是本锁真正要钉住的行为）；
 *  3) 正常体积的分块请求不被误伤，仍走完原链路。
 *
 * 与 chat-body-limit.test.ts 的区别：那份锁的替身只提供 text()，因此只能
 * 证明「缓冲之后必拒」；本锁提供可迭代 body，直接断言「不缓冲整包」。 */

vi.mock("server-only", () => ({}));

const rlQueries: string[] = [];
vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async (key: string) => {
    rlQueries.push(key);
    return true;
  }),
  clientIp: vi.fn(() => "198.51.100.7"),
}));

vi.mock("@/lib/server/auth", () => ({ verifySession: vi.fn(async () => null) }));
vi.mock("@/lib/server/device-auth", () => ({ verifyDeviceAuth: vi.fn(async () => null) }));
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
import { readTextBodyWithLimit } from "@/lib/server/body-limit";

const LIMIT = 1_000_000;
const encoder = new TextEncoder();

/* chunked 流替身：每产出一块记一笔，用于断言「超限即断流，未耗尽整个流」 */
function chunkedStream(chunks: Uint8Array[], pulled: number[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const c of chunks) {
      pulled.push(c.byteLength);
      yield c;
    }
  })();
}

function makeReq(opts: {
  body?: AsyncIterable<Uint8Array> | null;
  text?: () => Promise<string>;
  contentLength?: string;
  cookie?: string;
}): NextRequest {
  const headers = new Headers();
  if (opts.contentLength !== undefined) headers.set("content-length", opts.contentLength);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return {
    headers,
    body: opts.body ?? null,
    text:
      opts.text ??
      (async () => {
        throw new Error("不该走 req.text()：流式路径必须优先");
      }),
  } as unknown as NextRequest;
}

/* 把任意文本切成 n 块（模拟真实分块传输） */
function split(text: string, n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const step = Math.ceil(text.length / n);
  for (let i = 0; i < text.length; i += step) out.push(encoder.encode(text.slice(i, i + step)));
  return out;
}

beforeEach(() => {
  rlQueries.length = 0;
});

describe("readTextBodyWithLimit（/api/chat 体积闸的实现）", () => {
  it("chunked 超标包：超限块处断流，绝不耗尽整个流（OOM 回归锁）", async () => {
    /* 2MB 分 20 块（每块 ~100KB）：第 11 块累计越过 1MB */
    const chunks = split("x".repeat(2 * 1024 * 1024), 20);
    const pulled: number[] = [];
    const got = await readTextBodyWithLimit(makeReq({ body: chunkedStream(chunks, pulled) }), LIMIT);
    expect(got).toBeNull();
    expect(pulled.length).toBeGreaterThan(0);
    expect(pulled.length).toBeLessThan(chunks.length); // 关键：后面的块永不再产出
  });

  it("声明 content-length 超标：一字节都不读就返回 null", async () => {
    const pulled: number[] = [];
    const got = await readTextBodyWithLimit(
      makeReq({ body: chunkedStream(split("{}", 1), pulled), contentLength: String(LIMIT + 1) }),
      LIMIT
    );
    expect(got).toBeNull();
    expect(pulled).toEqual([]);
  });

  it("正常小载荷跨多块：完整拼接、原样返回", async () => {
    const json = '{"messages":[{"role":"user","content":"你好，帮我看看闭包"}]}';
    const chunks = split(json, 5);
    const pulled: number[] = [];
    const got = await readTextBodyWithLimit(makeReq({ body: chunkedStream(chunks, pulled) }), LIMIT);
    expect(got).toBe(json);
    expect(pulled.length).toBe(chunks.length);
  });

  it("无可迭代 body（测试替身/老环境）退回 text()，仍按字节口径判上限", async () => {
    const small = await readTextBodyWithLimit(makeReq({ text: async () => "{}" }), LIMIT);
    expect(small).toBe("{}");
    const big = await readTextBodyWithLimit(
      makeReq({ text: async () => "x".repeat(LIMIT + 1) }),
      LIMIT
    );
    expect(big).toBeNull();
  });
});

describe("/api/chat 接线", () => {
  it("chunked 超标包：413 且未把整包读进内存", async () => {
    const chunks = split("x".repeat(2 * 1024 * 1024), 20);
    const pulled: number[] = [];
    const res = await POST(makeReq({ body: chunkedStream(chunks, pulled), cookie: "mentora_session=1" }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "请求体过大" });
    expect(pulled.length).toBeLessThan(chunks.length);
    expect(rlQueries).toEqual(["chat:198.51.100.7"]); // 先过限流，再被流式闸拦下
  });

  it("声明超标：在限流桶被查询之前就 413", async () => {
    const pulled: number[] = [];
    const res = await POST(
      makeReq({
        body: chunkedStream(split("{}", 1), pulled),
        contentLength: String(LIMIT + 1),
        cookie: "mentora_session=1",
      })
    );
    expect(res.status).toBe(413);
    expect(rlQueries).toEqual([]);
    expect(pulled).toEqual([]);
  });

  it("正常分块小请求不被误伤：走完 demo 链路返回 NDJSON", async () => {
    const json = '{"messages":[{"role":"user","content":"hi"}]}';
    const chunks = split(json, 4);
    const pulled: number[] = [];
    const res = await POST(
      makeReq({
        body: chunkedStream(chunks, pulled),
        contentLength: String(encoder.encode(json).byteLength),
        cookie: "mentora_session=1",
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const text = await res.text();
    expect(text).toContain('{"t":"p"}');
    expect(text).toContain('{"t":"end"}');
    expect(pulled.length).toBe(chunks.length); // 全量读完，没被闸误伤
  });
});
