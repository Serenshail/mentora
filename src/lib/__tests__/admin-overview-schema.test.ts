import { describe, expect, it } from "vitest";
import { adminOverviewSchema } from "../admin-overview-schema";

/* 回归:admin/page.tsx 曾用 `as Overview` 盲断言 /api/admin/overview 的 2xx 响应，
 * 项目双端部署（Vercel + 腾讯云）前后端版本可能不同步——users/feedback 字段缺失或改名时
 * 渲染处 data.users.length 直接 TypeError，且 admin 路由无 error.tsx，整页白屏。
 * 现在成功形状必须过 schema：形状漂移就地降级为「加载失败」，不炸页面。 */

const validUser = {
  userId: "u1",
  email: "a@b.c",
  name: "张三",
  createdAt: "2026-01-01T00:00:00Z",
  lastSyncAt: null,
  stats: { goals: 1, knowledge: 2, books: 3, sessions: 4, personas: 5 },
};

const validFeedback = {
  number: 1,
  type: "问题",
  content: "内容",
  contact: "",
  state: "open",
  createdAt: "2026-01-01T00:00:00Z",
  url: "https://github.com/x/issues/1",
};

const validOverview = {
  you: { email: "admin@x.c", name: "admin" },
  users: [validUser],
  feedback: [validFeedback],
  feedbackConfigured: true,
  feedbackError: null,
  skippedUsers: 0,
  statsPartial: 0,
};

describe("adminOverviewSchema（成功响应形状契约，字段漂移不炸后台）", () => {
  it("完整合法响应 → 解析成功，类型收窄保留全部渲染字段", () => {
    const parsed = adminOverviewSchema.parse(validOverview);
    expect(parsed.users[0]!.stats.goals).toBe(1);
    expect(parsed.feedback[0]!.state).toBe("open");
  });

  it("旧服务端缺 skippedUsers/statsPartial/feedbackError（可选字段）→ 仍解析成功", () => {
    const legacy = { ...validOverview } as Record<string, unknown>;
    delete legacy.skippedUsers;
    delete legacy.statsPartial;
    delete legacy.feedbackError;
    expect(() => adminOverviewSchema.parse(legacy)).not.toThrow();
  });

  it("users 字段缺失（前后端版本漂移）→ 解析失败，渲染层可降级不 TypeError", () => {
    const broken = { ...validOverview } as Record<string, unknown>;
    delete broken.users;
    expect(adminOverviewSchema.safeParse(broken).success).toBe(false);
  });

  it("feedback 字段改名 → 解析失败", () => {
    const broken = { ...validOverview, feedbackList: validOverview.feedback };
    delete (broken as { feedback?: unknown }).feedback;
    expect(adminOverviewSchema.safeParse(broken).success).toBe(false);
  });

  it("users 数组内单条缺 stats → 解析失败（渲染处直接读 u.stats.*）", () => {
    const badUser = { ...validUser } as Record<string, unknown>;
    delete badUser.stats;
    expect(adminOverviewSchema.safeParse({ ...validOverview, users: [badUser] }).success).toBe(false);
  });

  it("整包非对象（如网关返回 HTML 错误串）→ 解析失败", () => {
    expect(adminOverviewSchema.safeParse("<html>502</html>").success).toBe(false);
    expect(adminOverviewSchema.safeParse(null).success).toBe(false);
  });

  it("stats 数值漂成字符串（上游类型漂移）→ 解析失败，不给 NaN 渲染机会", () => {
    const badUser = { ...validUser, stats: { ...validUser.stats, goals: "3" } };
    expect(adminOverviewSchema.safeParse({ ...validOverview, users: [badUser] }).success).toBe(false);
  });
});
