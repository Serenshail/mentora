import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* ============ 回归锁：reading-metrics 留存窗口必须封顶（FIX 2026-11-10）============
 * 修复前 route.ts 的 window(k) 只判 `parseTs(e.at) > firstLearn + k*86400e3`（无上界），
 * 度量的是「第 k 天之后任意时点」而非注释写的「k 天窗口内是否再发生有效学习」：
 *  · 首日后 2 小时就回来的高活跃用户 → d1=false（漏计）；
 *  · 第 30 天才回访的用户 → d1/d7/revisit14 全 true（d1⊇d7⊇revisit14 反向嵌套）。
 * 本锁用真路由 GET + 伪造 events 行钉死「k 天内复访」口径与分母资格。 */

const rows: { name: string; account: string; props: string; created_at: string }[] = [];

vi.mock("../server/db", () => ({
  dbReadingEvents: vi.fn(async () => rows),
}));

vi.mock("../server/admin-auth", () => ({
  authorizeAdminDetailed: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../server/config", () => ({
  logEvent: vi.fn(),
}));

vi.mock("../track", () => ({
  track: vi.fn(),
  trackReading: vi.fn(),
}));

import { GET } from "../../app/api/admin/reading-metrics/route";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0); // 2026-11-10T12:00:00Z
const DAY = 86400e3;

/** 与 route 的 parseTs 对齐：不带 T 的时间串按 UTC 解释（D1 datetime('now') 格式） */
const ts = (epoch: number) => {
  const d = new Date(epoch);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

const ev = (account: string, name: string, at: number) => {
  rows.push({ name, account, props: "{}", created_at: ts(at) });
};

function req(days = 90) {
  return {
    nextUrl: { searchParams: { get: () => String(days) } },
    headers: { get: () => null },
  } as unknown as import("next/server").NextRequest;
}

type UserRow = { account: string; d1: boolean | null; d7: boolean | null; revisit14: boolean | null };
type Body = {
  ok: boolean;
  retention: Record<"d1" | "d7" | "revisit14", { retained: number; eligible: number }>;
  users: UserRow[];
};

async function run() {
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = (await res.json()) as Body;
  expect(body.ok).toBe(true);
  return body;
}

beforeEach(() => {
  rows.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reading-metrics 留存窗口 = (首学, 首学 + k 天]", () => {
  it("首日后 2 小时就回访 → d1 计为留存（修复前漏计）", async () => {
    const t0 = NOW - 60 * DAY;
    ev("u1", "learning_node_started", t0);
    ev("u1", "learning_node_started", t0 + 2 * 3600e3);
    const body = await run();
    expect(body.users[0]).toMatchObject({ d1: true, d7: true, revisit14: true });
    expect(body.retention.d1).toEqual({ retained: 1, eligible: 1 });
  });

  it("第 30 天才回访 → d1/d7/revisit14 全不计留存（修复前全计）", async () => {
    const t0 = NOW - 60 * DAY;
    ev("u1", "reading_started", t0);
    ev("u1", "node_assessment_completed", t0 + 30 * DAY);
    const body = await run();
    expect(body.users[0]).toMatchObject({ d1: false, d7: false, revisit14: false });
    expect(body.retention.d1).toEqual({ retained: 0, eligible: 1 });
    expect(body.retention.revisit14).toEqual({ retained: 0, eligible: 1 });
  });

  it("第 5 天回访 → d1=false / d7=true / revisit14=true（单调嵌套，方向正确）", async () => {
    const t0 = NOW - 30 * DAY;
    ev("u1", "learning_node_started", t0);
    ev("u1", "learning_node_started", t0 + 5 * DAY);
    const body = await run();
    expect(body.users[0]).toMatchObject({ d1: false, d7: true, revisit14: true });
  });

  it("恰在窗口右端点（首学 + k 天）回访 → 计入（闭区间上界）", async () => {
    const t0 = NOW - 30 * DAY;
    ev("u1", "learning_node_started", t0);
    ev("u1", "learning_node_started", t0 + 7 * DAY);
    const body = await run();
    expect(body.users[0]).toMatchObject({ d7: true });
  });

  it("首学事件本身不计作回访（无第二个有效学习 → false）", async () => {
    const t0 = NOW - 30 * DAY;
    ev("u1", "learning_node_started", t0);
    const body = await run();
    expect(body.users[0]).toMatchObject({ d1: false, d7: false, revisit14: false });
  });

  it("观察窗口未满（首学 12 小时前）→ 三个指标均为 null 且不进分母", async () => {
    ev("u1", "learning_node_started", NOW - 12 * 3600e3);
    ev("u1", "learning_node_started", NOW - 1 * 3600e3);
    const body = await run();
    expect(body.users[0]).toMatchObject({ d1: null, d7: null, revisit14: null });
    expect(body.retention.d1).toEqual({ retained: 0, eligible: 0 });
    expect(body.retention.d7).toEqual({ retained: 0, eligible: 0 });
    expect(body.retention.revisit14).toEqual({ retained: 0, eligible: 0 });
  });

  it("分母按各自窗口资格独立计：首学 3 天前 → 只进 d1 分母", async () => {
    const t0 = NOW - 3 * DAY;
    ev("u1", "learning_node_started", t0);
    ev("u1", "learning_node_started", t0 + 1 * DAY);
    const body = await run();
    expect(body.users[0]).toMatchObject({ d1: true, d7: null, revisit14: null });
    expect(body.retention.d1).toEqual({ retained: 1, eligible: 1 });
    expect(body.retention.d7).toEqual({ retained: 0, eligible: 0 });
    expect(body.retention.revisit14).toEqual({ retained: 0, eligible: 0 });
  });
});
