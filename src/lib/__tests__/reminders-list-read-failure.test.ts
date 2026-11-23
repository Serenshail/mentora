import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：GET /api/reminders 读失败曾被 .catch(() => []) 折叠成空列表，
 * 响应 200 + {reminders: []} 与「这个用户确实没有提醒」完全一致。消费方
 * lib/agent/tool-executors.ts 不区分两者，拿到 ok:true 后直接对模型/用户说
 * 「还没有定时提醒」——用户据此以为提醒全丢了而重建，产生重复提醒与重复邮件，
 * 而失败全程不可见。修复：listReminders 抛错 → 503 + error，横幅侧
 * （app-shell.tsx 的 r.ok 判断）照常忽略，agent 侧走「获取失败」分支。
 * 本文件钉住：故障 → 503 且不带 reminders 字段；正常空态仍是 200 + []（不误伤真空态）。 */

const h = vi.hoisted(() => ({
  failList: false,
  reminders: [] as { id: string; title: string; time: string; enabled: boolean; lastRunKey?: string }[],
}));

vi.mock("@/lib/server/personal", () => ({
  listReminders: vi.fn(async () => {
    if (h.failList) throw new Error("D1 请求失败（500）");
    return h.reminders;
  }),
  registerAutomationOwner: vi.fn(async () => undefined),
  unregisterAutomationOwner: vi.fn(async () => undefined),
  saveReminder: vi.fn(),
  deleteReminder: vi.fn(),
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

import { GET } from "../../app/api/reminders/route";

const req = () =>
  ({
    headers: { get: () => null },
    nextUrl: { searchParams: { get: () => null } },
  }) as unknown as NextRequest;

beforeEach(() => {
  h.failList = false;
  h.reminders = [];
});

describe("GET /api/reminders：故障态与空态可区分", () => {
  it("listReminders 抛错 → 503，绝不返回骗人的空列表", async () => {
    h.failList = true;
    const res = await GET(req());
    expect(res.status).toBe(503);
    const j = (await res.json()) as { error?: string; reminders?: unknown };
    expect(j.error).toBeTruthy();
    expect(j.reminders).toBeUndefined();
  });

  it("确实没有提醒 → 200 + 空数组（真空态不受影响）", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ reminders: [] });
  });

  it("正常路径 → 200 且带 firedToday 标记", async () => {
    h.reminders = [{ id: "rem_1", title: "复习", time: "08:00", enabled: true, lastRunKey: "2026-11-10 08:00" }];
    const res = await GET(req());
    expect(res.status).toBe(200);
    const j = (await res.json()) as { reminders: { id: string; firedToday: boolean }[] };
    expect(j.reminders[0]!.firedToday).toBe(true);
  });
});
