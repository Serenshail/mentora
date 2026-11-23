import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：GET /api/memory 读失败曾被 .catch(() => []) 折叠成空列表，
 * 200 + {entries: []} 与「确实没有记忆」完全一致，前端数据结构里没有错误通道，
 * 永远只能渲染空态、无法区分失败也无重试引导；DELETE 侧 deleteMemory 吞掉失败、
 * 路由无条件 ok:true，用户看到"删除成功"但条目仍在。本锁钉住两处都如实暴露失败。
 * 与 reminders-list-read-failure.test.ts 同纪律（提醒侧先修，记忆侧此前漏网）。 */

const h = vi.hoisted(() => ({
  failList: false,
  failDelete: false,
  entries: [] as { id: string; text: string; tags: string[]; source: string; createdAt: string }[],
}));

vi.mock("@/lib/server/personal", () => ({
  listMemory: vi.fn(async () => {
    if (h.failList) throw new Error("D1 请求失败（500）");
    return h.entries;
  }),
  deleteMemory: vi.fn(async () => {
    if (h.failDelete) throw new Error("DB 删除失败（500）");
  }),
  addMemory: vi.fn(),
  sanitizeMemoryInput: vi.fn(),
  isValidItemId: vi.fn(() => true),
}));

vi.mock("@/lib/server/device-auth", () => ({
  verifyAnyAuth: vi.fn(async () => ({ userId: "u1", email: "u1@x.dev" })),
}));

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
}));

vi.mock("@/lib/server/config", () => ({ logEvent: vi.fn() }));

import { DELETE, GET } from "../../app/api/memory/route";

const req = (params: Record<string, string | null> = {}) =>
  ({
    headers: { get: () => null },
    nextUrl: { searchParams: { get: (k: string) => params[k] ?? null } },
  }) as unknown as NextRequest;

beforeEach(() => {
  h.failList = false;
  h.failDelete = false;
  h.entries = [];
});

describe("GET /api/memory：故障态与空态可区分", () => {
  it("listMemory 抛错 → 503，绝不返回骗人的空列表", async () => {
    h.failList = true;
    const res = await GET(req());
    expect(res.status).toBe(503);
    const j = (await res.json()) as { error?: string; entries?: unknown };
    expect(j.error).toBeTruthy();
    expect(j.entries).toBeUndefined();
  });

  it("确实没有记忆 → 200 + 空数组（真空态不受影响）", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ entries: [], total: 0 });
  });
});

describe("DELETE /api/memory：删除失败可见", () => {
  it("deleteMemory 抛错 → 503，不再谎报 ok:true", async () => {
    h.failDelete = true;
    const res = await DELETE(req({ id: "mem_1" }));
    expect(res.status).toBe(503);
    const j = (await res.json()) as { ok?: boolean; error?: string };
    expect(j.ok).toBeUndefined();
    expect(j.error).toBeTruthy();
  });

  it("正常删除 → 200 ok:true", async () => {
    const res = await DELETE(req({ id: "mem_1" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});
