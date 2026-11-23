import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：POST /api/reminders 用裸 req.json() 解析请求体，与同仓库认证
 * 路由的 readJsonBody 纪律脱节（login:35、register:34、device:36、profile:84 都已接入）。
 * body-limit.ts 明确动机：自托管（Caddy 默认不限 body）下「攻击者用限流额度内的请求发
 * GB 级 JSON，JSON.parse 的内存尖峰足以 OOM 杀掉单进程 Node」；本路由 30 次/30s 的限流
 * 管不住单个 GB 级请求体——sanitizeReminderInput 的字段截断发生在完整 parse 之后，
 * 挡不住 parse 本身的内存尖峰。修复：接入 readJsonBody，超标回 413。 */

const store = new Map<string, unknown>();

vi.mock("../server/db", () => ({
  dbGet: vi.fn(async (key: string) => store.get(key) ?? null),
  dbPut: vi.fn(async (key: string, val: unknown) => {
    store.set(key, val);
    return { sha: "test" };
  }),
  dbDelete: vi.fn(async (key: string) => {
    store.delete(key);
  }),
  dbList: vi.fn(async () => []),
  dbDeleteDir: vi.fn(async () => 0),
}));

vi.mock("../server/device-auth", () => ({
  verifyAnyAuth: vi.fn(async () => ({ userId: "u_fix", email: "fix@x.dev", name: "fix" })),
}));

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
}));

vi.mock("../server/config", () => ({ logEvent: vi.fn(() => {}) }));

vi.mock("../server/personal", () => ({
  sanitizeReminderInput: vi.fn((raw: { title?: string }) =>
    raw && typeof raw.title === "string" && raw.title.length >= 1
      ? { title: raw.title, prompt: "", time: "08:00", days: [], timezone: "Asia/Shanghai", enabled: true }
      : { error: "标题不能为空" }
  ),
  saveReminder: vi.fn(async () => ({ id: "rem_1", title: "复习" })),
  registerAutomationOwner: vi.fn(async () => undefined),
  unregisterAutomationOwner: vi.fn(async () => undefined),
  deleteReminder: vi.fn(async () => undefined),
  listReminders: vi.fn(async () => []),
  localNow: vi.fn(() => ({ date: "2026-11-23" })),
  isValidItemId: vi.fn(() => true),
}));

import { POST } from "../../app/api/reminders/route";

function makeReq(headers?: Record<string, string>) {
  return {
    headers: headers ? new Headers(headers) : undefined,
    json: async () => ({ title: "复习", prompt: "去复习", time: "08:00", days: [], timezone: "Asia/Shanghai", enabled: true }),
    nextUrl: { searchParams: { get: () => null } },
  } as unknown as NextRequest;
}

beforeEach(() => {
  store.clear();
});

describe("reminders POST 请求体体积闸", () => {
  it("声明体积超 512KB → 413，不进入 sanitize/save 流程", async () => {
    const res = await POST(makeReq({ "content-length": String(600_000) }));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("过大");
  });

  it("正常小载荷不受闸影响 → 200 { reminder }（存量路径不变）", async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reminder: { id: string } };
    expect(body.reminder.id).toBe("rem_1");
  });

  it("无 content-length 的 chunked 包由流式终闸兜底（替身流超限即断）", async () => {
    const chunk = new Uint8Array(1024);
    async function* gen() {
      for (let i = 0; i < 600; i++) yield chunk;
    }
    const req = {
      json: async () => ({}),
      body: gen(),
      nextUrl: { searchParams: { get: () => null } },
    } as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(413);
  });
});
