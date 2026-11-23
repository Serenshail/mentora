import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* cron/tick 双调度源并发下的幂等回归锁（2026-11 复核发现）。
 *
 * 触发源是「腾讯云 systemd timer 每分钟」+「Vercel Cron 每日 23:00」
 * （vercel.json crons 里 path=/api/cron/tick, schedule="0 23 * * *"）。
 * 修复前 route.ts 的幂等只靠 lastRunKey，而 lastRunKey 是在 sendEmail **之后**才写：
 * 两个实例在同一分钟内重叠时，两边都先 isDue→due=true，然后各自发信、各自写水位，
 * 当天每个到期提醒收两封邮件。
 *
 * 修复：发信前用 dbPutIfAbsent 抢一把按提醒粒度的短锁（lock/run/<userId>/<id>.json），
 * 抢到后**重读水位**再发信，发完写水位才释放锁。本文件锁住五件事：
 *  1) 并发两个实例 → 只发一封（第二个在锁处落败并跳过）；
 *  2) 抢到锁但水位已被别人写掉（列目录快照过期）→ 不发，且释放锁；
 *  3) 锁按 userId/reminderId 隔离，且不落在 automations/ 目录下（否则被当成提醒）；
 *  4) 投递失败 → 释放锁，下一轮能重试（不得把当天提醒静默吞掉）；
 *  5) 崩溃遗留的锁超过阈值可接管，未超阈值不接管。 */

type SendEmailMock = ((to: string, subject: string, html: string) => Promise<{ sent: boolean }>) & {
  mockClear: () => void;
  mock: { calls: unknown[][] };
};

/* vi.mock 工厂被提升到文件顶部执行（早于普通 const），共享状态必须走 vi.hoisted，
 * 否则工厂里读到 TDZ 变量会抛 "Cannot access before initialization"。 */
const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  claims: new Map<string, number>(),
  calls: [] as string[],
  /* 模拟并发：抢到锁后挂起，直到测试显式放行，制造"两个实例都在飞行中"的窗口 */
  gate: null as Promise<void> | null,
  openGate: null as (() => void) | null,
  failSend: false,
  sendEmail: undefined as unknown as SendEmailMock,
}));

vi.mock("@/lib/server/db", () => ({
  dbGet: vi.fn(async (path: string) => {
    if (h.claims.has(path)) return { at: h.claims.get(path) };
    const v = h.store.get(path);
    return v == null ? null : structuredClone(v);
  }),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    h.store.set(path, structuredClone(value));
    return { sha: "t" };
  }),
  /* SET NX 语义：键已存在返回 false；首次抢到时按需挂起等待放行 */
  dbPutIfAbsent: vi.fn(async (path: string) => {
    h.calls.push(path);
    if (h.claims.has(path)) return false;
    h.claims.set(path, Date.now());
    if (h.gate) await h.gate;
    return true;
  }),
  dbDelete: vi.fn(async (path: string) => {
    h.claims.delete(path);
  }),
}));

vi.mock("@/lib/server/mail", () => ({
  hasSmtp: vi.fn(() => true),
  /* 延迟解引用：工厂在 import 提升阶段执行，那时 h.sendEmail 还没赋值 */
  sendEmail: (to: string, subject: string, html: string) => h.sendEmail(to, subject, html),
}));

h.sendEmail = vi.fn(async () => {
  if (h.failSend) throw new Error("resend 500");
  return { sent: true };
}) as unknown as SendEmailMock;
const sendEmailMock = h.sendEmail;

vi.mock("@/lib/server/personal", () => ({
  /* 真实 isDue 的语义：当天该时刻已投递过就不再 due */
  isDue: vi.fn((r: { time: string; enabled: boolean; lastRunKey?: string }) => ({
    due: r.enabled && r.lastRunKey !== "2026-11-05 08:00",
    key: "2026-11-05 08:00",
  })),
  listAutomationOwners: vi.fn(async () => [{ userId: "u1", email: "u1@x.dev" }]),
  listReminders: vi.fn(async (userId: string) => {
    const dir = `automations/${userId}/`;
    return [...h.store.entries()]
      .filter(([k]) => k.startsWith(dir) && k.endsWith(".json"))
      .map(([, v]) => structuredClone(v) as { id: string; title: string; prompt: string; time: string; enabled: boolean });
  }),
}));

import { GET } from "../../app/api/cron/tick/route";

function seed(reminderId = "rem_1", extra: Record<string, unknown> = {}) {
  h.store.set("automations/_index.json", { owners: [{ userId: "u1", email: "u1@x.dev" }] });
  h.store.set(`automations/u1/${reminderId}.json`, {
    id: reminderId,
    title: "复习",
    prompt: "去复习",
    time: "08:00",
    enabled: true,
    ...extra,
  });
}

function req() {
  return {
    headers: { get: () => "Bearer s3cret" },
    nextUrl: { searchParams: { get: () => null } },
  } as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  process.env.APP_URL = "";
  h.store.clear();
  h.claims.clear();
  h.calls = [];
  h.gate = null;
  h.openGate = null;
  h.failSend = false;
  h.sendEmail.mockClear();
});

describe("cron/tick：双触发源重叠时只能发一封", () => {
  it("两个实例并发（都在飞行中）→ sendEmail 只调用一次，第二个实例跳过", async () => {
    seed();
    /* 第一个实例抢到锁后挂起，模拟 sendEmail 的 10s 窗口里第二个实例进来 */
    h.gate = new Promise<void>((resolve) => {
      h.openGate = resolve;
    });

    const first = GET(req());
    await new Promise((r) => setTimeout(r, 20)); // 让第一个实例跑到 await gate

    const second = await GET(req());
    const secondBody = (await second.json()) as { sent: number; byChannel: { email: number } };
    expect(secondBody.sent).toBe(0);
    expect(secondBody.byChannel.email).toBe(0);

    h.openGate!();
    const firstBody = (await (await first).json()) as { sent: number; byChannel: { email: number } };
    expect(firstBody.sent).toBe(1);
    expect(firstBody.byChannel.email).toBe(1);

    /* 核心断言：整轮并发只发了一封 */
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(h.store.get("automations/u1/rem_1.json")).toMatchObject({ lastRunKey: "2026-11-05 08:00" });
    /* 锁已释放（成功路径），不会永久挡住明天的提醒 */
    expect([...h.claims.keys()]).toHaveLength(0);
  });

  it("串行重跑（第一次已写水位）→ 不发第二封", async () => {
    seed();
    await GET(req());
    const again = await GET(req());
    expect(((await again.json()) as { sent: number }).sent).toBe(0);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("锁内重读水位：快照过期（别人已发完并放锁）→ 不发信，且释放锁", async () => {
    /* 模拟 A 已发完：水位是新值、锁已空。B 的 listReminders 快照却是旧的。 */
    seed("rem_1", { lastRunKey: "2026-11-05 08:00" });
    /* 让 isDue 对这个快照仍返回 due（模拟快照早于 A 的写入） */
    const { isDue } = await import("../server/personal");
    vi.mocked(isDue).mockReturnValueOnce({ due: true, key: "2026-11-05 08:00" });

    const res = await GET(req());
    const body = (await res.json()) as { sent: number };
    expect(body.sent).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect([...h.claims.keys()]).toHaveLength(0); // 锁必须放掉
  });

  it("锁键按 userId/reminderId 隔离，且不落在 automations/ 目录下", async () => {
    seed();
    await GET(req());
    expect(h.calls).toHaveLength(1);
    const key = h.calls[0];
    expect(key).toBe("lock/run/u1/rem_1.json");
    /* 锁若落进 automations/<userId>/，listReminders 会把它当提醒读回来 */
    expect(key.startsWith("automations/")).toBe(false);
  });

  it("两条提醒各自独立上锁：互不阻塞", async () => {
    seed("rem_1");
    h.store.set("automations/u1/rem_2.json", {
      id: "rem_2", title: "背单词", prompt: "去背", time: "08:00", enabled: true,
    });
    await GET(req());
    expect(h.calls).toHaveLength(2);
    expect(new Set(h.calls).size).toBe(2);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });

  it("投递失败 → 释放锁（下一轮能重试），且计入 failed", async () => {
    seed();
    h.failSend = true;
    const bad = await GET(req());
    expect(((await bad.json()) as { failed: number }).failed).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    /* 锁必须已释放：否则当天这条提醒永久静默丢失 */
    expect([...h.claims.keys()]).toHaveLength(0);

    h.failSend = false;
    const retry = await GET(req());
    expect(((await retry.json()) as { sent: number }).sent).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });

  it("崩溃遗留的锁：未超阈值不接管；超阈值可接管", async () => {
    seed();
    const lock = "lock/run/u1/rem_1.json";

    /* 未超阈值（3s 前）：视为另一个实例正在发 → 跳过，不发信 */
    h.claims.set(lock, Date.now() - 3_000);
    const skipped = await GET(req());
    expect(((await skipped.json()) as { sent: number }).sent).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();

    /* 超阈值（5 分钟前，进程被杀）：允许接管并发信 */
    h.claims.set(lock, Date.now() - 5 * 60_000);
    const took = await GET(req());
    expect(((await took.json()) as { sent: number }).sent).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});
