import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归:/api/admin/overview 的 GitHub 反馈拉取曾是全片唯一无 AbortSignal.timeout 的出站 fetch
 * （linkcheck 6s / search 8s / mail.ts 10s 均有），GitHub API 偶发挂起时整个请求被拖到
 * maxDuration=60 平台强杀 → 管理页 spinner 转满 60s 后解析平台 500 HTML 失败，
 * 落入 catch 显示误导性的「网络错误」。
 * 锁三件事：
 *  1) 路由确实用 AbortSignal.timeout(10_000) 兜底，且超时真的会触发（原生实现缩到 300ms
 *     实测）：overview 仍 200 返回 JSON，feedbackError 显式定性为「超时」，users 等其余数据照常；
 *  2) 上游正常 → feedbackError 为 null，存量成功路径不被新 signal 误伤；
 *  3) 上游连接失败（TypeError: fetch failed）→ 走通用 e.message 分支，不误报为超时。 */

vi.mock("../server/db", () => ({
  dbList: vi.fn(async () => ["u1.json"]),
  dbGet: vi.fn(async () => ({
    userId: "u-1",
    email: "a@b.c",
    name: "张三",
    createdAt: "2026-01-01T00:00:00Z",
  })),
}));

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("../server/admin-auth", () => ({
  authorizeAdmin: vi.fn(async () => ({ email: "admin@x.com", name: "admin" })),
}));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/admin/overview/route";
import { dbGet, dbList } from "../server/db";

const req = () =>
  ({
    headers: { get: () => null },
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("admin overview GitHub 反馈拉取超时兜底", () => {
  it("分页时只读取当前页的档案和快照", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const files = Array.from({ length: 9 }, (_, index) => ({ name: `u${9 - index}.json`, sha: "d1" }));
    vi.mocked(dbList).mockResolvedValueOnce(files);
    vi.mocked(dbGet).mockClear();

    const response = await GET(new NextRequest("http://localhost/api/admin/overview?page=2"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.pagination).toEqual({ page: 2, totalPages: 2, totalUsers: 9 });
    expect(body.users).toHaveLength(1);
    expect(dbGet).toHaveBeenCalledTimes(2);
    expect(dbGet).toHaveBeenCalledWith("users/u9.json", { encrypted: true });
  });

  it("上游挂起 → AbortSignal.timeout(10_000) 真触发 TimeoutError，overview 仍 200 且 feedbackError 显式定性", async () => {
    /* AbortSignal.timeout 是 Node 原生实现，假定时器推不动；先捕获原生实现再包一层、
     * 上限缩到 300ms 实测「signal 会真的 abort」，同时用 toHaveBeenCalledWith
     * 锁定生产常量 10_000（远小于 maxDuration=60_000）。 */
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
      const res = await GET(req());
      const elapsed = Date.now() - t0;

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        feedbackError: string | null;
        feedback: unknown[];
        users: { email: string }[];
      };
      expect(timeoutSpy).toHaveBeenCalledWith(10_000);
      expect(elapsed).toBeLessThan(5_000); // 300ms 缩短定时器：证明是 signal 真触发，不是 mock 直接拒绝
      expect(body.feedbackError).toContain("超时");
      expect(body.feedback).toEqual([]);
      expect(body.users).toHaveLength(1); // 反馈挂起不拖垮用户列表
    } finally {
      timeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  }, 20_000);

  it("上游正常返回 issues → feedbackError 为 null，成功路径不受 signal 影响，PR 被过滤", async () => {
    const issues = [
      {
        number: 7,
        title: "[体验] 下拉刷新偶发空白",
        body: "正文内容\n\n---\n联系方式：a@b.c",
        state: "open",
        created_at: "2026-02-01T00:00:00Z",
        html_url: "https://github.com/x/issues/7",
      },
      {
        number: 8,
        title: "PR 占位",
        body: "",
        state: "open",
        created_at: "2026-02-02T00:00:00Z",
        html_url: "https://github.com/x/pull/8",
        pull_request: { url: "https://api.github.com/x/pulls/8" },
      },
    ];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(issues), { status: 200 }));
    vi.stubEnv("GITHUB_TOKEN", "t-ok");
    vi.stubEnv("GITHUB_REPO", "x/y");

    try {
      const res = await GET(req());
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        feedbackError: string | null;
        feedback: { number: number; type: string; content: string; contact: string }[];
      };
      expect(body.feedbackError).toBeNull();
      expect(body.feedback).toEqual([
        {
          number: 7,
          type: "体验",
          content: "正文内容",
          contact: "a@b.c",
          state: "open",
          createdAt: "2026-02-01T00:00:00Z",
          url: "https://github.com/x/issues/7",
        },
      ]);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("上游拒绝连接（fetch failed）→ 走通用 message 分支，不误报为超时", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("fetch failed"));
    vi.stubEnv("GITHUB_TOKEN", "t-fail");
    vi.stubEnv("GITHUB_REPO", "x/y");

    try {
      const res = await GET(req());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { feedbackError: string | null };
      expect(body.feedbackError).toBe("fetch failed");
      expect(body.feedbackError).not.toContain("超时");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
