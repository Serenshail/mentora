import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：DELETE /api/reminders 里 deleteReminder 曾吞掉 dbDelete 失败、
 * 路由随后无条件返回 ok:true。删除请求落在 KV 重试耗尽的故障窗口时，UI 显示"删除成功"，
 * 但提醒仍在 automations/_index.json 里、cron/tick 到点继续发邮件，用户刷新才看到条目"复活"，
 * 失败全程不可见。修复：deleteReminder 抛错 → 路由 503 + error。 */

const h = vi.hoisted(() => ({ failDelete: false }));

vi.mock("@/lib/server/personal", () => ({
  deleteReminder: vi.fn(async () => {
    if (h.failDelete) throw new Error("DB 删除失败（500）");
  }),
  listReminders: vi.fn(async () => []),
  registerAutomationOwner: vi.fn(async () => undefined),
  unregisterAutomationOwner: vi.fn(async () => undefined),
  saveReminder: vi.fn(),
  sanitizeReminderInput: vi.fn(),
  isValidItemId: vi.fn(() => true),
  localNow: vi.fn(() => ({ date: "2026-11-10", hhmm: "08:00", weekday: 1 })),
}));

vi.mock("@/lib/server/device-auth", () => ({
  verifyAnyAuth: vi.fn(async () => ({ userId: "u1", email: "u1@x.dev" })),
}));

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
}));

vi.mock("@/lib/server/config", () => ({ logEvent: vi.fn() }));

import { DELETE } from "../../app/api/reminders/route";

const req = (id: string | null) =>
  ({
    headers: { get: () => null },
    nextUrl: { searchParams: { get: () => id } },
  }) as unknown as NextRequest;

beforeEach(() => {
  h.failDelete = false;
});

describe("DELETE /api/reminders：删除失败必须可见", () => {
  it("deleteReminder 抛错 → 503，不再谎报删除成功", async () => {
    h.failDelete = true;
    const res = await DELETE(req("rem_1"));
    expect(res.status).toBe(503);
    const j = (await res.json()) as { ok?: boolean; error?: string };
    expect(j.ok).toBeUndefined();
    expect(j.error).toBeTruthy();
  });

  it("正常删除 → 200 ok:true", async () => {
    const res = await DELETE(req("rem_1"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});
