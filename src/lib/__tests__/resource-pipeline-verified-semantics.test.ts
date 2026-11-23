import { afterEach, describe, expect, it, vi } from "vitest";

/* 回归锁：verified / kind 只在「平台视频接口实证」时才写入。
 * Resource.verified（types.ts:30）语义 = 单集视频已通过 YouTube oEmbed / B站 view API 实测存在；
 * UI（learn/[id]/page.tsx:1718）据此显示「视频已验证」徽章，rankResources（utils.ts:40）按 kind 排序。
 * 修复前的 enrich 对「替代项路径」传进来的任意 ok 体检结果（不要求 video）都打 verified:true
 * 且把缺失的 kind 兜底成 "video"——文档/仓库类替代链接被谎称为已实测视频，污染徽章与排序。
 * 本测试用模块级单例缓存 + 不同 URL 跨用例不冲突；fetch 按 body.urls 顺序回体检结果。 */

const { streamChatMock, checkMap } = vi.hoisted(() => ({
  // 每用例可重设：RESOURCE_FIX 返回的替代资源 JSON 数组
  streamChatMock: vi.fn(async () => ""),
  // url -> LinkCheck（按体检顺序返回）
  checkMap: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@/lib/ai/client", () => ({
  streamChat: streamChatMock,
  extractJson: (t: string) => {
    try { return JSON.parse(t); } catch { return null; }
  },
}));

import { refineResources } from "../resource-pipeline";
import type { Resource } from "../types";

function setChecks(entries: Record<string, Record<string, unknown>>) {
  checkMap.clear();

  for (const [url, c] of Object.entries(entries)) {
    checkMap.set(url, { url, ok: true, dead: false, ad: false, reason: "可访问", ...c });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: { body?: string }) => {
      const urls: string[] = JSON.parse(init?.body ?? "{}").urls ?? [];
      return Response.json({
        results: urls.map((u) => checkMap.get(u) ?? {
          url: u, ok: true, dead: false, ad: false, reason: "可访问",
        }),
      });
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  streamChatMock.mockReset();
});

const mk = (over: Partial<Resource> = {}): Resource => ({
  title: "r", url: "https://example.com/x", why: "w", ...over,
});

describe("refineResources：verified / kind 的视频实证语义", () => {
  it("非视频替代资源（缺 kind、体检无 video）→ 不得打 verified:true，也不得兜底 kind=\"video\"", async () => {
    const badUrl = "https://example.com/dead-video";
    const repUrl = "https://github.com/python/cpython"; // 文档/仓库类替代，无视频实证
    setChecks({
      [badUrl]: { ok: false, dead: true, reason: "HTTP 404 已失效" },
      [repUrl]: { ok: true, reason: "可访问" }, // 无 video 字段
    });
    streamChatMock.mockResolvedValue(JSON.stringify([
      { title: "CPython 源码仓库", url: repUrl, why: "可读源码" }, // 故意缺省 kind
    ]));

    const out = await refineResources([mk({ url: badUrl, title: "坏掉的视频课" })], "Python 基础");

    expect(out).toHaveLength(1);
    expect(out[0].url).toBe(repUrl);
    expect(out[0].verified).toBeUndefined(); // 不能谎称平台视频接口实证过
    expect(out[0].kind).toBeUndefined();     // 不能兜底成 "video" 污染排序/标签
    expect(out[0].author).toBeUndefined();
  });

  it("替代资源确有视频实证（video:true + 真实标题/作者）→ 仍正常写 verified:true 并覆盖标题", async () => {
    const badUrl = "https://example.com/old-link";
    const repUrl = "https://www.youtube.com/watch?v=abcdefghijk";
    setChecks({
      [badUrl]: { ok: false, dead: true, reason: "HTTP 404 已失效" },
      [repUrl]: { ok: true, video: true, title: "真实平台标题", author: "UP主", reason: "视频已验证" },
    });
    streamChatMock.mockResolvedValue(JSON.stringify([
      { title: "模型编的标题", url: repUrl, why: "视频课" },
    ]));

    const out = await refineResources([mk({ url: badUrl })], "Python 基础");

    expect(out).toHaveLength(1);
    expect(out[0].verified).toBe(true);
    expect(out[0].title).toBe("真实平台标题");
    expect(out[0].author).toBe("UP主");
    expect(out[0].kind).toBe("video"); // 有视频实证才允许兜底 kind
  });

  it("好资源路径（无替代发生）：非视频 ok 结果不得伪造 verified", async () => {
    const goodUrl = "https://docs.python.org/3/tutorial/"; // 文档类好资源，无 video
    setChecks({ [goodUrl]: { ok: true, reason: "可访问" } });

    const out = await refineResources([mk({ url: goodUrl, kind: "doc", title: "官方文档" })], "Python 基础");

    expect(out).toHaveLength(1);
    expect(out[0].verified).toBeUndefined();
    expect(out[0].kind).toBe("doc"); // 原 kind 不被改写
  });
});
