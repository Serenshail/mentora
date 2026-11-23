import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/* 回归锁（2026-11 复核）：open/plan 任务组装循环对脏快照元素无防护——
 *  :195/:196 `days.find((d) => d.status === …)` 的 d、:200 remainingDays 的 d、
 *  :211 `(day.knowledgePoints || []).map((k) => k.text)` 的 k 都是裸访问。
 * 同一文件已为同源风险加了三处防护（goals 的 !g、phases 的 ?.、counts 的 !g，注释明说
 * 「脏快照混入 null 元素时抛 TypeError 会变裸 500……插件『今日该做什么』整体不可用」），
 * 但 days 值与 knowledgePoints 元素漏了：plan.days 的值或其 knowledgePoints 数组混入
 * null/非对象元素时 TypeError 直接变平台 500。sync 的 sanitize（sync/route.ts）对
 * FIELDS 数组不做深层校验，任意 JSON 元素可经同步进入快照。
 * 修复后：脏元素被跳过，正常数据口径不变（防护不改变结果）。 */

vi.mock("server-only", () => ({}));

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "198.51.100.7"),
}));
vi.mock("@/lib/server/config", () => ({ logEvent: vi.fn(() => {}) }));

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
}));

import { GET } from "@/app/api/open/plan/route";

function makeReq(): NextRequest {
  return { headers: new Headers({ "x-open-token": "test-token" }) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.stubEnv("MENTORA_OPEN_TOKEN", "test-token");
  vi.stubEnv("MENTORA_OPEN_USER_ID", "userhash");
  delete process.env.MENTORA_OPEN_EMAIL;
  snapshot = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("open/plan：plan.days 值与 knowledgePoints 元素的脏数据防护", () => {
  it("days 含 null 值 + knowledgePoints 混入 null/非对象元素 → 200，脏元素跳过", async () => {
    snapshot = {
      updatedAt: "2026-11-08T00:00:00.000Z",
      data: {
        goals: [
          {
            id: "g1",
            topic: "Python",
            status: "active",
            plan: {
              phases: [{ id: "p1", title: "第一阶段" }],
              days: {
                d1: null, // 脏元素：修复前 days.find((d) => d.status === …) 直接 TypeError
                d2: {
                  id: "d2",
                  status: "active",
                  phaseId: "p1",
                  title: "Day 2",
                  /* 脏元素矩阵（前 4 个都在 slice(0,4) 窗口内）：null、非对象字符串、text 非字符串、
                   * 有效元素排在脏元素之后仍要存活 */
                  knowledgePoints: [null, "junk", { text: 123 }, { text: "闭包" }, { text: "装饰器" }],
                },
              },
            },
          },
          { id: "g2", topic: "Rust", status: "active", plan: { days: { d1: null, d2: null } } },
        ],
        knowledge: [],
      },
    };
    const res = await GET(makeReq());
    expect(res.status).toBe(200); // 修复前：TypeError → 裸 500，插件整体不可用
    const json = await res.json();
    expect(json.ok).toBe(true);
    /* g1 产出 d2 一个任务；g2 的 days 全是 null → 无任务 */
    expect(json.counts.tasks).toBe(1);
    expect(json.counts.days).toBe(1);
    expect(json.tasks[0].goalId).toBe("g1");
    expect(json.tasks[0].dayId).toBe("d2");
    expect(json.tasks[0].phase).toBe("第一阶段");
    /* points 只收 text 为字符串的元素：null / "junk"（字符串元素的 .text 是 undefined）/ {text:123} 全被滤掉，
     * 窗口内唯一有效元素存活；{text:"装饰器"} 在第 5 位，slice(0,4) 之外不出现 */
    expect(json.tasks[0].points).toEqual(["闭包"]);
    /* remainingDays 只数 status 可判定的 day（null 不计入） */
    expect(json.tasks[0].remainingDays).toBe(1);
    expect(json.counts.activeGoals).toBe(2);
  });

  it("干净快照：points/remainingDays 口径不变（防护不改变正常数据的结果）", async () => {
    snapshot = {
      updatedAt: "2026-11-08T00:00:00.000Z",
      data: {
        goals: [
          {
            id: "g1",
            topic: "Python",
            status: "active",
            plan: {
              days: {
                d1: { id: "d1", status: "passed", pendingUnlock: true, title: "Day 1", knowledgePoints: [] },
                d2: {
                  id: "d2",
                  status: "active",
                  phaseId: "p1",
                  title: "Day 2",
                  knowledgePoints: [{ text: "闭包" }, { text: "装饰器" }, { text: "生成器" }, { text: "协议" }, { text: "元类" }],
                },
              },
            },
          },
        ],
        knowledge: [],
      },
    };
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    /* 仍取前 4 个；迁移门（passed+pendingUnlock 之外的 active 优先）口径不变 */
    expect(json.tasks[0].dayId).toBe("d2");
    expect(json.tasks[0].points).toEqual(["闭包", "装饰器", "生成器", "协议"]);
  });
});
