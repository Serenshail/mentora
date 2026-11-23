import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：weekly-digest 两阶段循环（组装/发送）均无时间预算，
 * sendEmail 自带 10s 超时 + 5 路并发，最坏 wall time ≈ ceil(mails/5)×10s——opt-in 用户
 * ≥~30 且 SMTP 偏慢时整轮超过 maxDuration=60 被平台强杀：本轮响应（含 ok/failed 统计）
 * 不会发出，尾部用户本周静默漏信——周级任务意味着错一周。姊妹路由 cron/tick、
 * cron/expiry-reminder 都有 BUDGET_MS 逐块 deadline + 503/truncated 如实上报。
 * 修复口径与 expiry-reminder-budget.test.ts 相同（可控时钟偏移）。 */

const state = {
  skew: 0,
  baseNow: Date.now(),
  dataReads: 0,
  skewAfterDataReads: Number.POSITIVE_INFINITY,
  sends: 0,
  skewAfterSends: Number.POSITIVE_INFINITY,
};

vi.mock("@/lib/server/db", () => ({
  dbList: vi.fn(async () =>
    Array.from({ length: 10 }, (_, i) => ({ name: `u${i}.json`, sha: "t" }))
  ),
  dbGet: vi.fn(async (path: string) => {
    if (path.startsWith("users/")) {
      const i = Number(path.slice("users/u".length).replace(".json", ""));
      return { userId: `uid${i}`, email: `u${i}@x.dev`, name: `U${i}` };
    }
    if (path.startsWith("data/")) {
      state.dataReads += 1;
      if (state.dataReads >= state.skewAfterDataReads) state.skew = 40_000;
    }
    return {
      updatedAt: "2026-11-08T00:00:00.000Z",
      data: {
        settings: { digestWeekly: true },
        knowledge: [{ title: `知识点${path}`, unresolved: false, nextReviewAt: new Date().toISOString().slice(0, 10) }],
        goals: [],
      },
    };
  }),
}));

const sentEmails: { to: string }[] = [];
vi.mock("@/lib/server/mail", () => ({
  hasSmtp: vi.fn(() => true),
  sendEmail: vi.fn(async (to: string) => {
    state.sends += 1;
    if (state.sends >= state.skewAfterSends) state.skew = 40_000;
    sentEmails.push({ to });
    return { sent: true };
  }),
}));

vi.mock("@/lib/server/config", () => ({ logEvent: vi.fn() }));

import { GET } from "../../app/api/cron/weekly-digest/route";

const req = () =>
  ({
    headers: { get: () => "Bearer s3cret" },
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  process.env.APP_URL = "";
  state.skew = 0;
  state.dataReads = 0;
  state.sends = 0;
  state.skewAfterDataReads = Number.POSITIVE_INFINITY;
  state.skewAfterSends = Number.POSITIVE_INFINITY;
  sentEmails.length = 0;
  vi.spyOn(Date, "now").mockImplementation(() => state.baseNow + state.skew);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("weekly-digest：两阶段时间预算与截断可见性", () => {
  it("健康路径：10 个 opt-in 用户全部发送，200 ok:true 无 truncated", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sent: number; truncated?: boolean };
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(10);
    expect(body.truncated).toBeUndefined();
    expect(sentEmails).toHaveLength(10);
  });

  it("第二阶段预算耗尽 → 503 + truncated:true + unsent 如实上报（修复前被强杀、零响应）", async () => {
    /* SEND_CONCURRENCY=5：第 5 次发信调用后把时钟推过 BUDGET_MS=30s，
     * 第二块（剩 5 封）起发前即停 */
    state.skewAfterSends = 5;
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      ok: boolean; truncated: boolean; sent: number; unsent: number; unscanned: number;
    };
    expect(body.ok).toBe(false);
    expect(body.truncated).toBe(true);
    expect(body.sent).toBe(5);
    expect(body.unsent).toBe(5);
    expect(body.unscanned).toBe(0);
    expect(sentEmails).toHaveLength(5);
  });

  it("第一阶段预算耗尽 → 剩余用户不组装（unscanned>0），已组装的也不发（unsent>0）", async () => {
    /* 第 3 次 data/ 读后时钟越过预算：第一块 8 人组装完，剩 2 人未扫；
     * 第二阶段第一块起发前预算已尽 → 8 封全部 unsent */
    state.skewAfterDataReads = 3;
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      ok: boolean; truncated: boolean; sent: number; unsent: number; unscanned: number;
    };
    expect(body.ok).toBe(false);
    expect(body.truncated).toBe(true);
    expect(body.unscanned).toBe(2);
    expect(body.unsent).toBe(8);
    expect(sentEmails).toHaveLength(0);
  });
});
