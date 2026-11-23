import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* F8 回归锁：overview 对「解密成功但缺 userId 的畸形档案」必须计入 skippedUsers。
 *
 * 历史缺陷：dbGet 成功但 rec.userId 缺失（旧结构/半写入损坏）走 return null，
 * 既不进 users 列表也不进任何计数——本文件自立的可见性不变量（:59 注释
 * 「档案读取/解密失败 → 该用户从列表整体消失，必须让管理端知道」）只覆盖抛错
 * 路径（failed=true）。pagination.totalUsers 用 files.length 统计，出现
 * 「totalUsers - skippedUsers > 列表人数」时管理端无从解释差异。
 * 修复：缺 userId 的畸形档案同 failed 口径计数，维持 files.length = 列表 + skipped。 */

const state = vi.hoisted(() => ({
  files: [] as { name: string; sha: string }[],
  records: new Map<string, unknown>(),
  failPaths: new Set<string>(),
}));

vi.mock("@/lib/server/db", () => ({
  dbList: vi.fn(async () => state.files),
  dbGet: vi.fn(async (path: string) => {
    if (state.failPaths.has(path)) throw new Error("decrypt failed");
    return state.records.get(path) ?? null;
  }),
}));

vi.mock("@/lib/server/admin-auth", () => ({
  authorizeAdmin: vi.fn(async () => ({ email: "admin@x.com", name: "admin" })),
}));

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/server/config", () => ({ logEvent: vi.fn() }));

import { GET } from "../../app/api/admin/overview/route";

const req = () =>
  ({
    headers: { get: () => null },
    nextUrl: { searchParams: { get: () => null } },
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  state.files = [];
  state.records.clear();
  state.failPaths.clear();
});

describe("admin overview 畸形档案计数", () => {
  it("解密成功但缺 userId 的档案 → 进 skippedUsers，不出现在 users 列表", async () => {
    state.files = [{ name: "h_malformed.json", sha: "x" }];
    state.records.set("users/h_malformed.json", { email: "ghost@x.com", name: "no-userid" }); // 无 userId

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users: unknown[]; skippedUsers: number; pagination?: { totalUsers: number };
    };
    expect(body.users).toEqual([]);
    expect(body.skippedUsers).toBe(1);
  });

  it("正常档案不受影响：进列表且 skippedUsers=0；抛错档案仍按 failed 计数（原口径不变）", async () => {
    state.files = [
      { name: "h_ok.json", sha: "x" },
      { name: "h_bad.json", sha: "x" },
    ];
    state.records.set("users/h_ok.json", {
      userId: "u-ok", email: "ok@x.com", name: "ok", createdAt: "2026-01-01T00:00:00.000Z",
    });
    state.failPaths.add("users/h_bad.json");

    const res = await GET(req());
    const body = (await res.json()) as { users: { userId: string }[]; skippedUsers: number };
    expect(body.users.map((u) => u.userId)).toEqual(["u-ok"]);
    expect(body.skippedUsers).toBe(1); // 抛错的那条
  });

  it("混合：1 正常 + 1 抛错 + 1 缺 userId → skippedUsers=2，totalUsers=3，差异可解释", async () => {
    state.files = [
      { name: "h_ok.json", sha: "x" },
      { name: "h_throw.json", sha: "x" },
      { name: "h_malformed.json", sha: "x" },
    ];
    state.records.set("users/h_ok.json", {
      userId: "u-ok", email: "ok@x.com", name: "ok", createdAt: "2026-01-01T00:00:00.000Z",
    });
    state.records.set("users/h_malformed.json", { email: "ghost@x.com", name: "no-userid" });

    const res = await GET(req());
    const body = (await res.json()) as {
      users: unknown[]; skippedUsers: number; pagination: undefined;
    };
    expect(body.users.length).toBe(1);
    expect(body.skippedUsers).toBe(2);
  });
});
