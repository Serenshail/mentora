import { z } from "zod";

/* 后台 /api/admin/overview 响应形状契约。
 * 项目双端部署（Vercel + 腾讯云自托管），前后端版本可能不同步：
 * 字段缺失/改名时若只靠 `as Overview` 盲断言，渲染处 data.users.length 等直接 TypeError，
 * 且 admin 路由无 error.tsx，整页落到 Next 默认错误页。这里 parse 失败就地降级为
 * 「加载失败」，页面仍可刷新/重试，绝不白屏。
 *
 * 宽进严出原则：只锁「渲染会触碰的数组/数值/字符串字段」为必有且类型正确，
 * 其余一律 optional——形状漂移宁可显示兜底值，不炸页面。 */

const userSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  avatar: z.string().optional(),
  createdAt: z.string(),
  lastSyncAt: z.string().nullable(),
  stats: z.object({
    goals: z.number(),
    knowledge: z.number(),
    books: z.number(),
    sessions: z.number(),
    personas: z.number(),
  }),
});

const feedbackSchema = z.object({
  number: z.number(),
  type: z.string(),
  content: z.string(),
  contact: z.string(),
  state: z.string(),
  createdAt: z.string(),
  url: z.string(),
});

export const adminOverviewSchema = z.object({
  you: z.object({ email: z.string(), name: z.string() }),
  users: z.array(userSchema),
  feedback: z.array(feedbackSchema),
  feedbackConfigured: z.boolean(),
  feedbackError: z.string().nullable().optional(),
  skippedUsers: z.number().optional(),
  statsPartial: z.number().optional(),
  pagination: z.object({ page: z.number(), totalPages: z.number(), totalUsers: z.number() }).optional(),
});

export type AdminOverview = z.infer<typeof adminOverviewSchema>;
