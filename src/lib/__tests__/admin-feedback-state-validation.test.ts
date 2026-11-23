import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归:/api/admin/feedback-state 的 state 曾用 `body?.state === "open" ? "open" : "closed"`
 * 静默归一——任何非 "open" 值（"CLOSE"、"closed "、"closes"、缺失、非字符串）都被当成
 * "closed" 执行，即调用方本想重开却传错值会把 GitHub issue 直接关掉，且响应回 {state:"closed"}
 * 与传参不一致、无任何显式提示。破坏性动作（关闭他人反馈）必须先做参数校验。
 * 锁两件事：
 *  1) 非法/缺失 state → 400，且绝不发出 GitHub PATCH（不能有副作用）；
 *  2) 合法 "open"/"closed" → 原样透传给上游并在响应中回显，成功路径不被误伤。 */

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("../server/admin-auth", () => ({
  authorizeAdmin: vi.fn(async () => ({ email: "admin@x.com", name: "admin" })),
}));

import { POST } from "../../app/api/admin/feedback-state/route";

const req = (body: unknown) =>
  ({
    headers: { get: () => null },
    json: async () => body,
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("admin feedback-state state 参数校验", () => {
  const badStates: Array<[string, unknown]> = [
    ["大写 CLOSE", "CLOSE"],
    ["尾部空格", "closed "],
    ["typo closes", "closes"],
    ["拼写 open 变体", "OPEN"],
    ["缺失", undefined],
    ["null", null],
    ["非字符串 true", true],
    ["数字 0", 0],
  ];

  it.each(badStates)("非法 state（%s）→ 400 且不发出 GitHub PATCH", async (_label, state) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("GITHUB_TOKEN", "t-bad");
    vi.stubEnv("GITHUB_REPO", "x/y");

    try {
      const res = await POST(req({ number: 7, state }));
      expect(res.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("state");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each(["open", "closed"] as const)("合法 state=%s → 200，原样透传给上游并回显", async (state) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ number: 7, state }), { status: 200 }));
    vi.stubEnv("GITHUB_TOKEN", "t-ok");
    vi.stubEnv("GITHUB_REPO", "x/y");

    try {
      const res = await POST(req({ number: 7, state }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; state: string };
      expect(body).toEqual({ ok: true, state });

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(String(init.body))).toEqual({ state });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
