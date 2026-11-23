import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));

/* 注销删除失败可观测性回归锁（v27.4 安全修复）：
 * 旧实现 data/<userId>.json 与 versions/<userId>/ 删除失败被空 catch 吞掉——
 * 接口照常 ok:true 清会话，加密残留无任何日志、前端宣称"已删净"、且档案已删
 * 用户永远失去重试入口。修复后：失败必须 logEvent 留痕 + 响应带 partial 数组，
 * 前端据 partial 如实警告。直测路由 DELETE（vitest.config 已配 @ 别名），
 * 存储层全部用受控替身。 */

const mocks = vi.hoisted(() => ({
  dbGet: vi.fn(),
  dbDelete: vi.fn(),
  dbDeleteDir: vi.fn(),
  logEvent: vi.fn(),
  verifySession: vi.fn(),
  verifyPassword: vi.fn(),
  clearSessionCookie: vi.fn(),
  dropRefCode: vi.fn(),
  purgePersonalData: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({
  dbGet: mocks.dbGet,
  dbDelete: mocks.dbDelete,
  dbDeleteDir: mocks.dbDeleteDir,
  emailHash: (e: string) => `h_${e.length}`,
}));
vi.mock("@/lib/server/auth", () => ({
  verifySession: mocks.verifySession,
  verifyPassword: mocks.verifyPassword,
  /* mock 补全（F12 配套）：route 已改用异步版；await 兼容同步布尔返回 */
  verifyPasswordAsync: mocks.verifyPassword,
  clearSessionCookie: mocks.clearSessionCookie,
}));
vi.mock("@/lib/server/config", () => ({ logEvent: mocks.logEvent }));
vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: async () => true,
  clientIp: () => "198.51.100.7",
}));
vi.mock("@/lib/server/referral", () => ({ dropRefCode: mocks.dropRefCode }));
vi.mock("@/lib/server/personal", () => ({ purgePersonalData: mocks.purgePersonalData }));

import { DELETE } from "@/app/api/auth/account/route";

const REQ = () =>
  new Request("http://localhost/api/auth/account", {
    method: "DELETE",
    body: JSON.stringify({ password: "pw" }),
  }) as unknown as Parameters<typeof DELETE>[0];

let dataFile: unknown = null;

beforeEach(() => {
  vi.clearAllMocks();
  dataFile = null;
  mocks.verifySession.mockResolvedValue({ email: "user@example.com" });
  mocks.verifyPassword.mockReturnValue(true);
  mocks.dbGet.mockImplementation(async (key: string) => {
    if (key.startsWith("users/")) return { userId: "u1", salt: "s", hash: "h" };
    if (key.startsWith("data/")) return dataFile;
    return null;
  });
  mocks.dbDelete.mockResolvedValue(undefined);
  mocks.dbDeleteDir.mockResolvedValue(0);
  mocks.clearSessionCookie.mockResolvedValue(undefined);
  mocks.dropRefCode.mockResolvedValue(undefined);
  mocks.purgePersonalData.mockResolvedValue(undefined);
});

describe("auth/account DELETE：派生数据删除失败必须可见", () => {
  it("data/ 删除失败：仍 200 清会话（不阻断注销），但 logEvent 留痕且响应带 partial:['data']", async () => {
    dataFile = { note: "encrypted-blob" };
    mocks.dbDelete.mockImplementation(async (key: string) => {
      if (key.startsWith("data/")) throw new Error("D1 请求失败（429）");
    });

    const res = await DELETE(REQ());
    const body = (await res.json()) as { ok: boolean; partial?: string[] };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.partial).toEqual(["data"]);
    expect(mocks.clearSessionCookie).toHaveBeenCalledTimes(1); // 注销照常完成
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ ev: "data-delete-fail", userId: "u1" })
    );
    // 错误详情只进日志，不进响应体（不泄露通道细节给客户端）
    expect(JSON.stringify(body)).not.toContain("D1");
  });

  it("versions/ 目录删除失败：partial:['versions'] + logEvent 留痕", async () => {
    mocks.dbDeleteDir.mockRejectedValue(new Error("GitHub 列目录失败（503）"));

    const res = await DELETE(REQ());
    const body = (await res.json()) as { ok: boolean; partial?: string[] };

    expect(res.status).toBe(200);
    expect(body.partial).toEqual(["versions"]);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ ev: "versions-delete-fail", userId: "u1" })
    );
  });

  it("全部成功：响应不含 partial，无 delete-fail 日志", async () => {
    dataFile = { note: "blob" };

    const res = await DELETE(REQ());
    const body = (await res.json()) as { ok: boolean; partial?: string[] };

    expect(body.ok).toBe(true);
    expect(body.partial).toBeUndefined();
    expect(mocks.logEvent).not.toHaveBeenCalled();
    expect(mocks.dbDelete).toHaveBeenCalledWith(
      "data/u1.json",
      null // KV 通道 _sha 占位 undefined ?? null
    );
  });

  it("data/ 本就不存在（dbGet 返回 null）：不算失败，无 partial", async () => {
    const res = await DELETE(REQ());
    const body = (await res.json()) as { ok: boolean; partial?: string[] };

    expect(body.partial).toBeUndefined();
    expect(mocks.dbDelete).not.toHaveBeenCalledWith(expect.stringContaining("data/"), expect.anything());
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

describe("源码护栏：前端必须消费 partial 如实告知", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("settings 注销流程读取 j.partial 并用 toast.warning 警告残留", () => {
    const src = read("../../app/settings/page.tsx");
    expect(src).toContain("j.partial");
    expect(src).toContain("toast.warning");
    /* partial 时的跳转必须给用户留出读到警告的时间（不能立即整页刷新） */
    const partialBranch = src.slice(src.indexOf("j.partial"));
    expect(partialBranch).toMatch(/setTimeout\(\(\) => \(window\.location\.href = "\/"\), \d{4,}\)/);
  });
});
