import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* ============ 回归锁：proxy 白名单与错误响应契约 ============
 * 1) 登录页底部向未登录用户展示「隐私政策 · 用户协议」链接（login-form.tsx），
 *    但 PUBLIC_PATHS 曾缺 /privacy、/terms——未登录用户点击即被登录墙 302 弹回，
 *    形成「入口→弹回」死循环，本地模式（无 cookie）用户永远读不到。
 * 2) UA 黑名单 403 曾返回纯文本 "Forbidden"，偏离全站 JSON {error} 契约：调用方按
 *    res.json() 解析会抛 SyntaxError，真实原因（UA 被拦）丢失。
 * 3) 放行逻辑曾分散在三处（PUBLIC_PATHS 条目、isPublic 分支、主干独立判断），
 *    现收敛为「精确路径集合 + 前缀/扩展名规则 + 主干 /_next/ 一处」。 */

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(() => true),
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "203.0.113.7"),
  withBudget: vi.fn(async (...args: [Promise<boolean>, boolean, number]) => args[0]),
}));

vi.mock("../server/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  rateLimitPersistent: mocks.rateLimitPersistent,
  clientIp: mocks.clientIp,
}));

vi.mock("../server/db", () => ({ withBudget: mocks.withBudget }));

import { proxy } from "../../proxy";

function makeReq(pathname: string, ua = "Mozilla/5.0") {
  return {
    nextUrl: { pathname, search: "" },
    method: "GET",
    url: `https://mentora.example${pathname}`,
    headers: new Headers({ "user-agent": ua }),
    cookies: { get: () => undefined },
  } as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockReturnValue(true);
  mocks.rateLimitPersistent.mockResolvedValue(true);
});

describe("proxy 未登录白名单", () => {
  it("隐私政策 / 用户协议免登录可读（不被登录墙弹回）", async () => {
    for (const p of ["/privacy", "/terms"]) {
      const res = await proxy(makeReq(p));
      expect(res.headers.get("location")).toBeNull();
      expect(res.status).not.toBe(307);
    }
  });

  it("其它业务页仍未登录 → 重定向到 /login", async () => {
    const res = await proxy(makeReq("/brain"));
    expect(res.headers.get("location")).toContain("/login");
  });
});

describe("proxy 静态资源放行（前缀/扩展名规则唯一来源）", () => {
  it("构建产物/字体/媒体/图标均免登录放行", async () => {
    for (const p of [
      "/_next/static/chunk.js",
      "/fonts/GreatVibes.woff2",
      "/hero.mp4",
      "/hero-poster.jpg",
      "/favicon.ico",
      "/icon.png",
    ]) {
      const res = await proxy(makeReq(p));
      expect(res.headers.get("location")).toBeNull();
    }
  });
});

describe("proxy UA 黑名单 403 遵循 JSON 错误契约", () => {
  it("返回 JSON {error} 而非纯文本 Forbidden", async () => {
    const res = await proxy(makeReq("/", "python-requests/2.31"));
    expect(res.status).toBe(403);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("application/json");
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
    expect(body.error).not.toBe("Forbidden");
  });
});
