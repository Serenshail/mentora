import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/* open/plan 脏快照统计回归锁（修复：counts 的 goals.filter 直接取 g.status，无 !g 防护）。
 * goals/knowledge 数组元素来自用户云端快照，sync 的 sanitize 只保证键存在
 * （out[k] = data[k] ?? []，不逐项校验）——快照里混入一个 null 元素
 * （坏快照/手改存储/客户端 bug）时，本路由对同一数据源的防护口径是：
 *   任务循环 `if (!g || g.status !== "active" ...) continue`、复习过滤 `k && ...`，
 *   唯独 counts 统计的 filter 裸取 g.status → TypeError。
 * GET 的 try 只包住读库段，异常变裸 500，插件侧「今日该做什么」整体不可用。
 * 本锁验证：脏元素被统计跳过、正常数据的统计口径不变。 */

vi.mock("server-only", () => ({}));

/* 令牌桶恒放行、IP 恒定——本锁只关心鉴权后的数据面 */
vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "198.51.100.7"),
}));
vi.mock("@/lib/server/config", () => ({ logEvent: vi.fn(() => {}) }));

/* db 替身：users/ 返回绑定档案，data/ 返回云端快照（各用例覆盖） */
const userData = { userId: "userhash", email: "open@example.com", name: "Tester" };
let snapshot: unknown = null;
vi.mock("@/lib/server/db", () => ({
  dbGet: vi.fn(async (path: string) => {
    if (path.startsWith("users/")) return userData;
    if (path.startsWith("data/")) return snapshot;
    return null;
  }),
  dbList: vi.fn(async () => []),
  dbPut: vi.fn(async () => ({ sha: "test" })),
  emailHash: vi.fn((s: string) => s),
}));

import { GET } from "@/app/api/open/plan/route";

/* 路由只用 headers.get（clientIp 已 mock），最小 NextRequest 形状即可 */
function makeReq(): NextRequest {
  return { headers: new Headers({ "x-open-token": "test-token" }) } as unknown as NextRequest;
}

const ACTIVE_DAY_GOAL = {
  id: "g1",
  topic: "Python",
  status: "active",
  plan: {
    days: { d1: { id: "d1", status: "active", phaseId: "p1", title: "Day 1", knowledgePoints: [] } },
  },
};

beforeEach(() => {
  vi.stubEnv("MENTORA_OPEN_TOKEN", "test-token");
  vi.stubEnv("MENTORA_OPEN_USER_ID", "userhash");
  delete process.env.MENTORA_OPEN_EMAIL;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("open/plan 脏快照统计（counts 空值防护）", () => {
  it("goals 混入 null 元素：统计不再抛 TypeError（裸 500），脏元素被跳过", async () => {
    snapshot = {
      updatedAt: "2026-11-08T00:00:00.000Z",
      data: {
        goals: [
          null, // 脏元素：sync sanitize 只保证数组存在，不逐项校验
          ACTIVE_DAY_GOAL,
          { id: "g2", topic: "Rust", status: "done" },
        ],
        knowledge: [null],
      },
    };
    const res = await GET(makeReq());
    expect(res.status).toBe(200); // 修复前此处抛 TypeError → GET 整体拒绝
    const json = await res.json();
    expect(json.ok).toBe(true);
    // null 不计入任何统计：active 1（g1）+ done 1（g2）
    expect(json.counts.activeGoals).toBe(1);
    expect(json.counts.doneGoals).toBe(1);
    // 任务循环本有 !g 防护：null 不产出任务，g1 产出唯一 day 任务
    expect(json.counts.tasks).toBe(1);
    expect(json.counts.days).toBe(1);
    expect(json.tasks[0].kind).toBe("day");
    expect(json.tasks[0].goalId).toBe("g1");
    // knowledge 的 null 由既有 k && 防护跳过
    expect(json.counts.reviewsDue).toBe(0);
  });

  it("干净快照：统计口径不变（防护不改变正常数据的结果）", async () => {
    snapshot = {
      updatedAt: "2026-11-08T00:00:00.000Z",
      data: {
        goals: [
          ACTIVE_DAY_GOAL,
          { id: "g2", topic: "Rust", status: "done" },
          { id: "g3", topic: "Go", status: "paused" },
        ],
        knowledge: [],
      },
    };
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.counts).toEqual({ tasks: 1, days: 1, reviewsDue: 0, activeGoals: 1, doneGoals: 1 });
    expect(json.user).toEqual({ name: "Tester", email: "open@example.com" });
    expect(json.updatedAt).toBe("2026-11-08T00:00:00.000Z");
  });
});
