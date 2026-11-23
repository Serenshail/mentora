import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* cron/tick 派发读失败回归锁：
 * 修复前两层读失败都被折叠成空数组——owners 层 route.ts:38 .catch(()=>[])（当时
 * personal.ts readIndex 也把 dbGet 失败吞成 []），每用户层 :42 listReminders 失败
 * 被 .catch(()=>[]) 后 continue。两种故障的响应都是 ok:true / sent:0 / failed 不增，
 * 与「真的没有人配提醒」完全不可区分；而 isDue 只补发当天（跨天错过不追发），
 * 故障跨过提醒时刻 = 提醒永久丢失且运维面（systemd timer 拉 JSON）显示一切正常。
 * 修复后锁四件事：
 *  1) 索引读失败 → 503 + ok:false + degraded:true，failed 不再虚报全绿；
 *  2) 单用户提醒读失败 → 计入 failed，响应仍 200（单用户故障不拖垮整轮派发）；
 *  3) 索引键不存在（null = 还没人配过提醒）→ 正常 ok:true，空态不受影响；
 *  4) 健康路径（有 owner、有到期提醒）→ 照常派发并写回 lastRunKey。 */

let indexFail = false;
let failListForUser: string | null = null;
const store = new Map<string, unknown>();

vi.mock("@/lib/server/db", () => ({
  dbGet: vi.fn(async () => {
    if (indexFail) throw new Error("kv read timeout");
    return store.get("automations/_index.json") ?? null;
  }),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    store.set(path, structuredClone(value));
    return { sha: "t" };
  }),
}));

vi.mock("@/lib/server/mail", () => ({
  hasSmtp: vi.fn(() => false),
  sendEmail: vi.fn(async () => ({ sent: true })),
}));

vi.mock("@/lib/server/personal", () => ({
  isDue: vi.fn((r: { time: string; enabled: boolean; lastRunKey?: string }) => {
    /* 测试固定"现在"= 08:05，所有提醒都设 08:00 → 到期 */
    return { due: r.enabled && r.lastRunKey !== "d 08:00", key: "d 08:00" };
  }),
  listAutomationOwners: vi.fn(async () => {
    if (indexFail) throw new Error("kv read timeout");
    return (store.get("automations/_index.json") as { owners: { userId: string; email: string }[] })
      ?.owners ?? [];
  }),
  listReminders: vi.fn(async (userId: string) => {
    if (failListForUser === userId) throw new Error("list dir failed");
    const dir = `automations/${userId}/`;
    return [...store.entries()]
      .filter(([k]) => k.startsWith(dir) && k.endsWith(".json"))
      .map(([, v]) => structuredClone(v) as { id: string; title: string; prompt: string; time: string });
  }),
}));

import { GET } from "../../app/api/cron/tick/route";

function seedOwner(userId: string, email = `${userId}@x.dev`) {
  store.set("automations/_index.json", {
    owners: [{ userId, email }],
  });
}
function seedReminder(userId: string, id: string) {
  store.set(`automations/${userId}/${id}.json`, {
    id,
    title: "复习",
    prompt: "去复习",
    time: "08:00",
    enabled: true,
  });
}

function req(authed = true) {
  return {
    headers: { get: () => (authed ? "Bearer s3cret" : "Bearer wrong") },
    nextUrl: { searchParams: { get: () => null } },
  } as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  process.env.APP_URL = "";
  indexFail = false;
  failListForUser = null;
  store.clear();
});

describe("cron/tick：读失败必须可观测，不得静默漏发", () => {
  it("索引读失败 → 503 + degraded:true + ok:false（不再是 ok:true/sent:0 全绿）", async () => {
    seedOwner("u1");
    indexFail = true;
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; degraded: boolean; failed: number; sent: number };
    expect(body.ok).toBe(false);
    expect(body.degraded).toBe(true);
    expect(body.failed).toBe(0); // owners 层失败不算单用户失败，但 503/degraded 已可告警
    expect(body.sent).toBe(0);
  });

  it("单用户提醒读失败 → failed≥1、其余用户照常派发（200，不中断整轮）", async () => {
    seedOwner("u_bad");
    store.set("automations/_index.json", {
      owners: [
        { userId: "u_bad", email: "bad@x.dev" },
        { userId: "u_good", email: "good@x.dev" },
      ],
    });
    seedReminder("u_good", "rem_g1");
    failListForUser = "u_bad";
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; failed: number; sent: number; degraded?: boolean };
    expect(body.ok).toBe(true);
    expect(body.degraded).toBeUndefined(); // 索引读没坏，不算 degraded
    expect(body.failed).toBe(1);
    expect(body.sent).toBe(1);
    expect(store.get("automations/u_good/rem_g1.json")).toMatchObject({ lastRunKey: "d 08:00" });
  });

  it("索引键不存在（还没人配过提醒）→ ok:true，空态不受影响", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sent: number; owners: number };
    expect(body.ok).toBe(true);
    expect(body.owners).toBe(0);
    expect(body.sent).toBe(0);
  });

  it("健康路径：到期提醒照常派发（回归保护，确保 fail-closed 没误伤正常流）", async () => {
    seedOwner("u1");
    seedReminder("u1", "rem_1");
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sent: number; byChannel: { inapp: number } };
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(1);
    expect(body.byChannel.inapp).toBe(1); // hasSmtp=false → 应用内通道
  });

  it("认证失败 → 403，不进入派发逻辑", async () => {
    const res = await GET(req(false));
    expect(res.status).toBe(403);
  });
});
