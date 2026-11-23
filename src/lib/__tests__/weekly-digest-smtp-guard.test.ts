import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：hasSmtp() 为 false 时原实现 `Response.json({ ok:false, ... })`
 * 不带 status（默认 200 成功态）。该分支的后果与同文件「用户列表读取失败 → 500」完全相同
 * （所有 digestWeekly 用户整周收不到邮件、连续多周），却以 200 返回——Vercel Cron / 运维
 * 告警只看状态码时该故障永久不可见（部署者已有人开周报但漏配 RESEND_API_KEY 的典型场景）。
 * 修复：与姊妹路由 cron/tick 的 degraded 503、同文件 500 口径一致 → 503。 */

const dbListSpy = vi.fn(async () => [{ name: "u0.json", sha: "t" }]);

vi.mock("@/lib/server/db", () => ({
  dbList: (...args: unknown[]) => dbListSpy(...(args as [])),
  dbGet: vi.fn(async () => null),
}));

vi.mock("@/lib/server/mail", () => ({
  hasSmtp: vi.fn(() => false),
  sendEmail: vi.fn(async () => ({ sent: true })),
}));

import { GET } from "../../app/api/cron/weekly-digest/route";

const req = () =>
  ({
    headers: { get: () => "Bearer s3cret" },
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  dbListSpy.mockClear();
});

describe("weekly-digest：SMTP 未配置必须 503（不得 200 假成功）", () => {
  it("hasSmtp()=false → 503 + ok:false + 显式错误信息", async () => {
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string; sent: number };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("未配置发信服务");
    expect(body.sent).toBe(0);
  });

  it("未配置发信时短路返回，不做用户扫描（不烧 KV 读）", async () => {
    await GET(req());
    expect(dbListSpy).not.toHaveBeenCalled();
  });
});
