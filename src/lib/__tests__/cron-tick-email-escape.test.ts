import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：cron/tick 把 r.title / r.prompt（用户任意输入，限 60/600 字）
 * 未转义就拼进提醒邮件 HTML——用户可让 Mentora 发信域投递任意 HTML（伪造按钮/链接/
 * 追踪像素的钓鱼样式）。weekly-digest 早有 escapeHtml，tick 漏了。修复：同款转义，
 * 且换行仍以 <br/> 呈现（转义后再替换，避免 \\n 被当成 HTML）。 */

const h = vi.hoisted(() => ({
  sent: [] as { to: string; subject: string; html: string }[],
  reminders: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/server/db", () => ({
  dbGet: vi.fn(async () => null),
  dbPut: vi.fn(async () => ({ sha: "t" })),
  dbPutIfAbsent: vi.fn(async () => true),
  dbDelete: vi.fn(async () => undefined),
}));

vi.mock("@/lib/server/mail", () => ({
  hasSmtp: vi.fn(() => true),
  sendEmail: vi.fn(async (to: string, subject: string, html: string) => {
    h.sent.push({ to, subject, html });
    return { sent: true };
  }),
}));

vi.mock("@/lib/server/personal", () => ({
  isDue: vi.fn(() => ({ due: true, key: "2026-11-10 08:00" })),
  listAutomationOwners: vi.fn(async () => [{ userId: "u1", email: "u1@x.dev" }]),
  listReminders: vi.fn(async () => h.reminders),
}));

import { GET } from "../../app/api/cron/tick/route";

const req = () =>
  ({
    headers: { get: () => "Bearer s3cret" },
    nextUrl: { searchParams: { get: () => null } },
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  h.sent = [];
  h.reminders = [];
});

describe("cron/tick 提醒邮件 HTML 转义", () => {
  it("标题/正文里的标签与引号被转义，不会原样投递", async () => {
    h.reminders = [
      {
        id: "rem_1",
        title: `<img src=x onerror="alert(1)">`,
        prompt: `第一行\n<a href="https://evil.example">点我</a>`,
        time: "08:00",
        enabled: true,
      },
    ];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(h.sent).toHaveLength(1);
    const html = h.sent[0]!.html;
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('<a href="https://evil.example">');
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&quot;");
    /* 换行仍以 <br/> 呈现 */
    expect(html).toContain("第一行<br/>");
  });
});
