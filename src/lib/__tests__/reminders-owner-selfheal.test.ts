import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 正确性修复，接续 reminders-owner-registration.test.ts）：
 * tick 只扫 automations/_index.json（全量遍历 users/ 实测 46s，超 Vercel 60s 上限，
 * 做不了兜底扫描）。所以"提醒本体存在、索引里却没有这位用户"= 永久静默失效：
 * 用户看到提醒列表，但永远不会收到任何派发。
 * 三处落点：
 *  ① POST 新建时索引注册失败 → 503（显式失败，不谎称成功）且必须回滚刚写入的提醒本体，
 *     否则用户按提示重试就会积出重复提醒（每条都扫不到，双重静默）；
 *  ② POST 编辑（带 id）时注册失败 → 503，但绝不能删掉用户原有的提醒（回滚只针对新建）；
 *  ③ GET 读列表时若本人确有提醒而索引缺条目 → 补登记一次（对账自愈）。
 *     这是索引丢更新/历史孤儿唯一不依赖 46s 全量扫描的修复窗口。
 * GET 的自愈是 best-effort：补登记失败只记日志，绝不把"读列表"变成失败响应。 */

const store = new Map<string, unknown>();
/* clobber: 模拟并发写者——我们的 dbPut 落地后，它用"读于我们之前"的旧快照整份覆盖索引
 * （dbPut 是 last-write-wins，五个通道都无 CAS）。once = 只发生一次（校验重试应救回），
 * always = 每轮都被覆盖（register 必须抛错而不是谎称成功）。 */
const state = { failIndexWrite: false, failIndexRead: false, clobber: "none" as "none" | "once" | "always", clobberTo: [] as unknown[] };

const INDEX = "automations/_index.json";

vi.mock("../server/db", () => ({
  dbGet: vi.fn(async (key: string) => {
    if (state.failIndexRead && key === INDEX) throw new Error("网络抖动");
    return store.get(key) ?? null; // 缺键 = 404：与真实 dbGet 一致返回 null
  }),
  dbPut: vi.fn(async (key: string, val: unknown) => {
    if (state.failIndexWrite && key === INDEX) throw new Error("D1 请求失败（500）");
    store.set(key, val);
    if (key === INDEX && state.clobber !== "none") {
      // 并发写者用旧快照覆盖（我们的条目被抹掉）
      store.set(INDEX, { owners: state.clobberTo });
      if (state.clobber === "once") state.clobber = "none";
    }
    return { sha: "test" };
  }),
  dbDelete: vi.fn(async (key: string) => {
    store.delete(key);
  }),
  dbList: vi.fn(async (dir: string) =>
    [...store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .map((k) => ({ name: k.slice(dir.length + 1), sha: "t" }))
  ),
  dbDeleteDir: vi.fn(async () => 0),
}));

vi.mock("../server/device-auth", () => ({
  verifyAnyAuth: vi.fn(async () => ({ userId: "u_fix", email: "fix@x.dev", name: "fix" })),
}));

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
}));

import { GET, POST } from "../../app/api/reminders/route";

const req = (over: { json?: unknown; id?: string } = {}) =>
  ({
    headers: { get: () => null },
    nextUrl: { searchParams: { get: (k: string) => (k === "id" ? over.id ?? null : null) } },
    json: async () => over.json ?? {},
  }) as unknown as NextRequest;

const reminderJson = { title: "复习", prompt: "去复习", time: "08:00", days: [], timezone: "Asia/Shanghai", enabled: true };

const ownerIds = () =>
  ((store.get(INDEX) as { owners?: { userId: string }[] } | undefined)?.owners ?? []).map((o) => o.userId);

const reminderKeys = () => [...store.keys()].filter((k) => k.startsWith("automations/u_fix/"));

beforeEach(() => {
  store.clear();
  state.failIndexWrite = false;
  state.failIndexRead = false;
  state.clobber = "none";
  state.clobberTo = [];
});

describe("GET 对账自愈：提醒存在但索引缺条目 → 补登记", () => {
  it("索引里没有本人（丢更新/历史孤儿）→ GET 后本人被补登记", async () => {
    store.set("automations/u_fix/rem_1.json", { id: "rem_1", title: "复习", prompt: "去复习", time: "08:00", days: [], timezone: "Asia/Shanghai", enabled: true });
    store.set(INDEX, { owners: [{ userId: "u_other", email: "other@x.dev" }] });

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(ownerIds()).toEqual(["u_other", "u_fix"]); // 追加而非覆盖
  });

  it("索引键还不存在 → 首建条目（合法路径）", async () => {
    store.set("automations/u_fix/rem_1.json", { id: "rem_1", title: "复习", time: "08:00", enabled: true });

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(ownerIds()).toEqual(["u_fix"]);
  });

  it("本人没有任何提醒 → 不写索引（不给空用户造派发条目）", async () => {
    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(store.has(INDEX)).toBe(false);
  });

  it("补登记失败（索引读抛错）→ GET 仍 200 且照常返回提醒（best-effort，不拖垮列表）", async () => {
    store.set("automations/u_fix/rem_1.json", { id: "rem_1", title: "复习", time: "08:00", enabled: true });
    state.failIndexRead = true;

    const res = await GET(req());

    expect(res.status).toBe(200);
    const j = (await res.json()) as { reminders?: { id: string }[] };
    expect(j.reminders?.map((r) => r.id)).toEqual(["rem_1"]);
    expect(store.has(INDEX)).toBe(false); // 没有伪造写入
  });
});

describe("POST 新建：索引注册失败必须回滚提醒本体（不留扫不到的孤儿）", () => {
  it("索引写失败 → 503，且刚写入的提醒被删除（用户重试不会积出重复提醒）", async () => {
    state.failIndexWrite = true;

    const res = await POST(req({ json: reminderJson }));

    expect(res.status).toBe(503);
    const j = (await res.json()) as { error?: string };
    expect(j.error).toContain("派发索引");
    expect(reminderKeys()).toEqual([]); // 回滚干净
    expect(store.has(INDEX)).toBe(false);
  });

  it("注册成功 → 200 且提醒与索引条目都在", async () => {
    const res = await POST(req({ json: reminderJson }));

    expect(res.status).toBe(200);
    expect(reminderKeys()).toHaveLength(1);
    expect(ownerIds()).toEqual(["u_fix"]);
  });
});

describe("POST 编辑（带 id）：索引注册失败不得删掉用户原有提醒", () => {
  it("索引写失败 → 503，但已有提醒仍然存在（回滚只针对新增记录）", async () => {
    store.set("automations/u_fix/rem_1.json", { id: "rem_1", title: "旧标题", prompt: "去复习", time: "08:00", days: [], timezone: "Asia/Shanghai", enabled: true, createdAt: "2026-11-01T00:00:00.000Z" });
    state.failIndexWrite = true;

    const res = await POST(req({ json: { ...reminderJson, id: "rem_1" } }));

    expect(res.status).toBe(503);
    expect(store.get("automations/u_fix/rem_1.json")).toBeDefined(); // 没被误删
  });

  it("传了不存在的 id → saveReminder 生成新记录，失败时该新记录同样回滚（不把幽灵 id 当编辑）", async () => {
    state.failIndexWrite = true;

    const res = await POST(req({ json: { ...reminderJson, id: "rem_ghost" } }));

    expect(res.status).toBe(503);
    expect(reminderKeys()).toEqual([]); // 新增的记录已回滚
  });
});

describe("索引读-改-写并发（dbPut last-write-wins，无 CAS）", () => {
  it("本次写入被并发写者覆盖一次 → 校验发现后基于最新快照重试，两个用户都在索引里", async () => {
    store.set(INDEX, { owners: [{ userId: "u_other", email: "other@x.dev" }] });
    /* 并发写者：它先读到只有 u_other 的旧快照，在我们写完后整份覆盖回去 */
    state.clobber = "once";
    state.clobberTo = [{ userId: "u_other", email: "other@x.dev" }];

    const res = await POST(req({ json: reminderJson }));

    expect(res.status).toBe(200); // 重试救回，不谎报失败
    expect(ownerIds().sort()).toEqual(["u_fix", "u_other"]); // 没有丢更新
  });

  it("每一轮都被覆盖 → 不谎称成功：POST 503 且回滚提醒本体", async () => {
    state.clobber = "always";
    state.clobberTo = [{ userId: "u_other", email: "other@x.dev" }];

    const res = await POST(req({ json: reminderJson }));

    expect(res.status).toBe(503);
    expect(reminderKeys()).toEqual([]); // 孤儿提醒已回滚
  });
});
