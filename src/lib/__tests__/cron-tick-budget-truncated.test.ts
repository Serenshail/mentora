import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：cron/tick 的预算/上限截断（MAX_SEND_PER_RUN / BUDGET_MS 触发
 * break）之后响应仍 ok:true 且无任何截断标记——调用方无法区分「全部处理完」与「预算耗尽
 * 提前收尾」。主链路（腾讯云每分钟）下轮即补发无实害，但仅靠 Vercel Cron 每日兜底
 * （vercel.json tick schedule）+ isDue 只补当天的部署，单日到期超限的部分会被永久漏发
 * 且运维面显示全绿。修复：两处 break 都置 truncated=true，响应（200 与 degraded 503
 * 两个分支）都带 truncated 字段。本锁与 cron-tick-degraded 同法（可控时钟偏移）。 */

const store = new Map<string, unknown>();
const state = { skew: 0, puts: 0, skewAfterPuts: Number.POSITIVE_INFINITY };
const baseNow = Date.now();

vi.mock("@/lib/server/db", () => ({
  dbGet: vi.fn(async () => null), // 锁接管读/水位重读都拿到 null → 照常投递
  dbPut: vi.fn(async (path: string, value: unknown) => {
    store.set(path, structuredClone(value));
    state.puts += 1;
    if (state.puts >= state.skewAfterPuts) state.skew = 30_000; // 推过 BUDGET_MS=20s
    return { sha: "t" };
  }),
  dbPutIfAbsent: vi.fn(async () => true), // 每次都抢到锁
  dbDelete: vi.fn(async () => undefined),
}));

vi.mock("@/lib/server/mail", () => ({
  hasSmtp: vi.fn(() => false), // inapp 通道：不依赖 sendEmail 时序
  sendEmail: vi.fn(async () => ({ sent: true })),
}));

vi.mock("@/lib/server/personal", () => ({
  isDue: vi.fn(() => ({ due: true, key: "d 08:00" })),
  listAutomationOwners: vi.fn(async () => [
    { userId: "u1", email: "u1@x.dev" },
    { userId: "u2", email: "u2@x.dev" },
    { userId: "u3", email: "u3@x.dev" },
    { userId: "u4", email: "u4@x.dev" },
  ]),
  listReminders: vi.fn(async (userId: string) => [
    { id: `rem_${userId}`, title: "复习", prompt: "去复习", time: "08:00", enabled: true },
  ]),
}));

import { GET } from "../../app/api/cron/tick/route";

const req = () =>
  ({
    headers: { get: () => "Bearer s3cret" },
    nextUrl: { searchParams: { get: () => null } },
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  process.env.APP_URL = "";
  store.clear();
  state.skew = 0;
  state.puts = 0;
  state.skewAfterPuts = Number.POSITIVE_INFINITY;
  vi.spyOn(Date, "now").mockImplementation(() => baseNow + state.skew);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cron/tick：预算截断必须在响应里可见（truncated 字段）", () => {
  it("预算耗尽提前收尾 → ok:true 但 truncated:true，sent 停在截断点", async () => {
    state.skewAfterPuts = 2; // 第 2 次水位写（=第 2 条投递）后把时钟推过预算
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; truncated: boolean; sent: number; owners: number };
    expect(body.ok).toBe(true);
    expect(body.truncated).toBe(true); // 修复前无此字段，截断全绿不可见
    expect(body.sent).toBe(2);
    expect(body.owners).toBe(4); // 还有 owner 没轮到——截断如实呈现
  });

  it("正常跑完 → truncated:false（健康路径不误报）", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; truncated: boolean; sent: number };
    expect(body.ok).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.sent).toBe(4);
  });
});
