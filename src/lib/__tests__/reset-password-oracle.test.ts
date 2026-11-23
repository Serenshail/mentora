import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
}));
vi.mock("@/lib/server/db", () => ({
  /* mock 补全（F15 配套）：route 的读-改-写现经 withUserLock，其 finally 调
   * dbDelete(key).catch(...)、首次 dbPutIfAbsent 抢锁——本文件无共享 store，
   * 恒可用语义等价于恒空的内存 Map，且不会跨用例残留活锁。dbDelete 原本无
   * 实现（返回 undefined），补 async 空实现使其返回 promise 供 .catch 消费。 */
  dbGet: mocks.get, dbPut: mocks.put, dbDelete: vi.fn(async () => {}), emailHash: () => "user",
  dbPutIfAbsent: vi.fn(async () => true),
}));
vi.mock("@/lib/server/auth", () => ({ hashPassword: () => ({ salt: "new", hash: "new" }) }));
vi.mock("@/lib/server/rate-limit", () => ({ rateLimitPersistent: async () => true, clientIp: () => "test" }));
vi.mock("@/lib/server/deploy-env", () => ({ deployEnv: () => "test" }));
vi.mock("@/lib/server/reset-code", () => ({ consumeResetCode: mocks.consume }));

import { POST } from "@/app/api/auth/reset-password/route";
import { NextRequest } from "next/server";

describe("password reset authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({ email: "test@example.com", salt: "old", hash: "old" });
    mocks.consume.mockResolvedValue("mismatch");
  });

  it("rejects an invalid reset code without comparing or changing the password", async () => {
    const request = new NextRequest("http://localhost/api/auth/reset-password", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", resetCode: "invalid", newPassword: "candidate" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(mocks.consume).toHaveBeenCalledOnce();
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
