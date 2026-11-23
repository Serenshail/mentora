import { afterEach, describe, expect, it, vi } from "vitest";

/* route.ts 链路上的 server-only 护栏在 vitest 里需要豁免（同 client-ip.test.ts） */
vi.mock("server-only", () => ({}));

/* searchBing 不读 env、不触 session/限流，只需要 stub 全局 fetch。
 * 回归锁：hosts 双通道（cn.bing.com → www.bing.com）互备——
 * 旧实现首个 host 非 2xx 直接 throw，www.bing.com 兜底分支不可达：
 * 数据中心 IP 被 cn.bing.com 反爬 403 时（route.ts:79 自述的现实威胁）
 * bing 与 DDG 两通道同时失效，无 Key 部署下联网搜索整体 502。 */

const OK_HTML = `<html><body><li class="b_algo"><h2><a href="https://example.com/a">标题A</a></h2><p>摘要A</p></li><li class="b_algo"><h2><a href="https://example.com/b">标题B</a></h2><p>摘要B</p></li></body></html>`;

function res(status: number, body = ""): Response {
  return new Response(body, { status });
}

function lastHostCalled(): string | undefined {
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  const last = calls[calls.length - 1]?.[0];
  return typeof last === "string" ? new URL(last).host : undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchBing 双 host 兜底", () => {
  it("cn.bing.com 403 时降级到 www.bing.com 并解析结果", async () => {
    const { searchBing } = await import("../server/search-bing");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const host = new URL(typeof input === "string" ? input : input.toString()).host;
        return host === "cn.bing.com" ? res(403) : res(200, OK_HTML);
      })
    );
    const out = await searchBing("test");
    expect(lastHostCalled()).toBe("www.bing.com");
    expect(out.map((r) => r.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(out[0]).toMatchObject({ title: "标题A", snippet: "摘要A" });
  });

  it("cn.bing.com 500 同样降级（任何非 2xx 都不直接抛）", async () => {
    const { searchBing } = await import("../server/search-bing");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const host = new URL(typeof input === "string" ? input : input.toString()).host;
        return host === "cn.bing.com" ? res(500) : res(200, OK_HTML);
      })
    );
    const out = await searchBing("test");
    expect(out.length).toBe(2);
  });

  it("两个 host 都非 2xx 时如实报错且带状态码", async () => {
    const { searchBing } = await import("../server/search-bing");
    vi.stubGlobal("fetch", vi.fn(async () => res(403)));
    await expect(searchBing("test")).rejects.toThrow(/bing 403/);
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(2);
  });

  it("200 但无 b_algo 仍走下一个 host（原有语义保持）", async () => {
    const { searchBing } = await import("../server/search-bing");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const host = new URL(typeof input === "string" ? input : input.toString()).host;
        return host === "cn.bing.com" ? res(200, "<html>无结果</html>") : res(200, OK_HTML);
      })
    );
    const out = await searchBing("test");
    expect(lastHostCalled()).toBe("www.bing.com");
    expect(out.length).toBe(2);
  });

  it("第一个 host 即成功则不再请求第二个 host", async () => {
    const { searchBing } = await import("../server/search-bing");
    vi.stubGlobal("fetch", vi.fn(async () => res(200, OK_HTML)));
    const out = await searchBing("test");
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(1);
    expect(out.length).toBe(2);
  });
});
