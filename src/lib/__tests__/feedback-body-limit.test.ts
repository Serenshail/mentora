import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：feedback POST 的 req.json() 无体积闸——本端点未登录即可调
 * （限流 5 突发/2 每分回填），req.json() 会把整个请求体缓冲并解析后才截断 content/contact，
 * 正是 body-limit.ts 描述的自托管 OOM 威胁模型（「攻击者用限流额度内的请求发 GB 级 JSON，
 * JSON.parse 的内存尖峰足以 OOM 杀掉单进程 Node」）。reset-password/change-password/account
 * 已全部接入 readJsonBody（512KB 声明闸+流式终闸），feedback 属于公开端点反而没接。
 * 修复：接入 readJsonBody，超标回 413；正常载荷路径不受影响。 */

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/server/db", () => ({
  dbFeedbackSave: vi.fn(async () => undefined),
}));

import { POST } from "../../app/api/feedback/route";

function makeReq(headers?: Record<string, string>) {
  return {
    headers: headers ? new Headers(headers) : undefined,
    json: vi.fn(async () => ({ content: "好" })), // 1 字：正常路径会走到「内容太短」400
  } as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.stubEnv("GITHUB_TOKEN", "t");
  vi.stubEnv("GITHUB_REPO", "x/y");
});

describe("feedback POST 请求体体积闸", () => {
  it("声明体积超 512KB → 413，请求体一个字节都不读", async () => {
    const jsonSpy = vi.fn();
    const req = {
      headers: new Headers({ "content-length": String(600_000) }),
      json: jsonSpy,
    } as unknown as import("next/server").NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(jsonSpy).not.toHaveBeenCalled(); // 声明闸：未读一字节就拒
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("太大");
  });

  it("正常小载荷不受闸影响：解析后走到业务校验（内容太短 400，而非 413）", async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("太短");
  });
});
