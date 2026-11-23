import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/* fetch-page 响应体流量闸回归锁（修复：arrayBuffer() 先把整个响应体读进内存
 * 再 slice(0, MAX_BYTES)，声明的 200KB 硬上限形同虚设——AbortSignal.timeout
 * 只封读取时长、封不住流量，快速 CDN 的大文件能在 8s 窗口内灌入数百 MB
 * 打爆内存（自托管单进程 OOM / Vercel 函数超限被杀）。
 * 修复后是流式读取：reader.read() 逐块累计，达 MAX_BYTES 即停止读并 cancel
 * 底层连接，后续字节不进内存。
 * 这份锁钉住三件会真出事的事：
 *  1) 响应体远超上限时，上游被消费的量被钳在上限附近（旧实现的 arrayBuffer()
 *     会消费完整 2MB，本断言直接失败），且仍返回正常 200 正文；
 *  2) 达限后连接被 cancel（cancel 后生产者不再产出）；
 *  3) 正常小响应不被误伤：完整解码、标题/正文原样返回。
 * 计量口径：ReadableStream 的 pull 是「为满足 highWaterMark 调度」的，可能
 * 领先实际 read() 约 1-2 个 chunk，故测试 1 的钳制带 3 个 chunk 容差——
 * 这不影响判别力：旧实现计 2,000,000，远超任何容差。 */

vi.mock("server-only", () => ({}));

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "198.51.100.7"),
}));
vi.mock("@/lib/server/auth", () => ({ verifySession: vi.fn(async () => null) }));
vi.mock("@/lib/server/deploy-env", () => ({ isDeployed: vi.fn(() => false) }));
vi.mock("@/lib/server/url-guard", async (importOriginal) => {
  /* 形态检查用真实现（不放宽校验），仅替换 DNS 解析取证：
   * 测试用的 example.com 在守卫里按公网处理 */
  const mod = await importOriginal<typeof import("@/lib/server/url-guard")>();
  return {
    ...mod,
    assertSafePublicUrl: vi.fn(async () => ({ ok: true })),
  };
});

import { POST } from "@/app/api/fetch-page/route";

function makeReq(url: unknown): NextRequest {
  return {
    json: async () => ({ url }),
  } as unknown as NextRequest;
}

/* 大文件模拟：每次 pull 产出一块并记账「已产出总量」；
 * cancel 断流后 pull 不再被调用（测试 2 靠这一点断言连接确实被断）。 */
function bigBody(totalSize: number, chunkSize: number, produced: { n: number }) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalSize) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, totalSize - sent);
      controller.enqueue(new Uint8Array(size).fill(0x78)); // 'x'
      sent += size;
      produced.n = sent;
    },
  });
}

function makeRes(body: ReadableStream<Uint8Array>, contentType = "text/html"): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    body,
  } as unknown as Response;
}

/* 拦截全局 fetch，抓到 route 发出的真实上游请求 */
function stubFetch(makeBody: () => ReadableStream<Uint8Array>) {
  return vi.fn(async (): Promise<Response> => makeRes(makeBody()));
}

const origFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  globalThis.fetch = origFetch;
});

describe("fetch-page 响应体流量闸（流式读取，达限即断）", () => {
  it("响应体 2MB 远超 200KB 上限：消费量被钳在上限附近，绝不全量拉进内存", async () => {
    const produced = { n: 0 };
    vi.stubGlobal("fetch", stubFetch(() => bigBody(2_000_000, 16_384, produced)));
    const res = await POST(makeReq("https://example.com/big"));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { text?: string };
    expect(typeof j.text).toBe("string");
    expect(j.text!.length).toBeGreaterThan(0);
    /* 修复前：arrayBuffer() 把 2MB 全部拉进内存（produced.n 冲到 2,000,000）。
     * 修复后：累计 ≥ MAX_BYTES 即停止 read——上游最多被多拉 3 个在途 chunk。 */
    expect(produced.n).toBeLessThanOrEqual(200_000 + 3 * 16_384);
    expect(produced.n).toBeGreaterThan(0);
  });

  it("达限后 cancel 断开连接：正文是前 200KB 去标签的 8KB 截取", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cancelled) return;
        controller.enqueue(new Uint8Array(65_536).fill(0x78));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal("fetch", stubFetch(() => body));
    const res = await POST(makeReq("https://example.com/cancel"));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { text?: string };
    /* 200KB 'x' 无标签，去标签后即原文，被 extractText 截到 8000 字符 */
    expect(j.text).toBe("x".repeat(8000));
  });

  it("正常小响应不被误伤：完整解码 + 标题/正文原样返回", async () => {
    const page =
      "<html><head><title>测试页面</title></head><body><p>你好，世界。</p><script>evil()</script></body></html>";
    vi.stubGlobal(
      "fetch",
      stubFetch(() => {
        const bytes = new TextEncoder().encode(page);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      })
    );
    const res = await POST(makeReq("https://example.com/small"));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { title?: string; text?: string; url?: string };
    expect(j.title).toBe("测试页面");
    expect(j.text).toContain("你好，世界。");
    expect(j.text).not.toContain("evil()");
    expect(j.url).toBe("https://example.com/small");
  });
});
