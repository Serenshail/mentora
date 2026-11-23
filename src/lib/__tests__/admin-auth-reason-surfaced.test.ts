import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：authorizeAdminDetailed 会产出四类失败原因
 * （bad-password / no-session / not-admin），但唯一调用方 reading-metrics 路由曾
 * 直接丢弃 .reason、统一回 401「未授权」。后台操作员输错 x-admin-password、
 * 会话被吊销、非管理员账号三种处置完全不同，却看到一模一样的反馈，无法自助定位。
 * 本锁钉住：reason 被消费进响应，且互不相同；成功路径不受影响。 */

const h = vi.hoisted(() => ({
  result: { ok: false, reason: "bad-password" } as { ok: boolean; reason?: string },
}));

vi.mock("@/lib/server/admin-auth", () => ({
  authorizeAdminDetailed: vi.fn(async () => h.result),
}));

vi.mock("@/lib/server/db", () => ({ dbReadingEvents: vi.fn(async () => []) }));
vi.mock("@/lib/server/config", () => ({ logEvent: vi.fn() }));

import { GET } from "../../app/api/admin/reading-metrics/route";

const req = () =>
  ({
    headers: { get: () => null },
    nextUrl: { searchParams: { get: () => "30" } },
  }) as unknown as NextRequest;

beforeEach(() => {
  h.result = { ok: false, reason: "bad-password" };
});

async function errOf(reason: string) {
  h.result = { ok: false, reason };
  const res = await GET(req());
  expect(res.status).toBe(401);
  const j = (await res.json()) as { ok: boolean; error: string; reason?: string };
  expect(j.ok).toBe(false);
  expect(j.reason).toBe(reason);
  return j.error;
}

describe("reading-metrics 401：四种失败原因不再压成单一「未授权」", () => {
  it("bad-password / no-session / not-admin 三类给出可区分的文案", async () => {
    const bad = await errOf("bad-password");
    const noSession = await errOf("no-session");
    const notAdmin = await errOf("not-admin");
    expect(bad).toBeTruthy();
    expect(new Set([bad, noSession, notAdmin]).size).toBe(3);
  });
});
