import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 正确性修复）：reminders 路由的派发索引维护曾是三处静默失败——
 * ① POST 里 registerAutomationOwner 失败被 .catch(() => {}) 吞掉：提醒本体已写成功、
 *    返回「已创建」，但 tick 永远扫不到这位用户，定时提醒静默失效；
 * ② DELETE 里 listReminders 失败被 .catch(() => []) 当成空列表：只要删除后列表读抖动一次，
 *    就会误 unregister 仍有效的派发条目，同样是静默失效；
 * ③ personal.readIndex 把传输错误也当空索引：register 的读改写会在一次网络抖动后
 *    用单条数据覆盖整份索引（丢其他用户的派发条目）。
 * 锁定：①注册失败 → POST 返回 503 且带可读错误（不再 200「已创建」），成功路径仍 200；
 * ②列表读失败 → 不触发 unregister（索引条目保留），列表真空才撤；
 * ③readIndex 读失败 → register/unregister 原样抛错，绝不写索引（防覆盖）。 */

const store = new Map<string, unknown>();
/* 测试开关：让「索引键」的写入抛错（saveReminder 会先消费一次 dbPut，不能用 one-shot stub） */
const state = { failIndexWrite: false };

vi.mock("../server/db", () => ({
  dbGet: vi.fn(async (key: string) => store.get(key) ?? null), // 缺键 = 404：与真实 dbGet 一致返回 null
  dbPut: vi.fn(async (key: string, val: unknown) => {
    if (state.failIndexWrite && key === INDEX) throw new Error("D1 请求失败（500）");
    store.set(key, val);
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

import { POST, DELETE } from "../../app/api/reminders/route";

const req = (over: { method?: string; json?: unknown; id?: string } = {}) =>
  ({
    headers: { get: () => null },
    nextUrl: { searchParams: { get: (k: string) => (k === "id" ? over.id ?? null : null) } },
    json: async () => over.json ?? {},
  }) as unknown as NextRequest;

const INDEX = "automations/_index.json";
const reminderJson = { title: "复习", prompt: "去复习", time: "08:00", days: [], timezone: "Asia/Shanghai", enabled: true };

beforeEach(() => {
  store.clear();
  state.failIndexWrite = false;
});

describe("POST：registerAutomationOwner 失败必须显式失败（不再吞掉）", () => {
  it("索引写失败 → 503 + 错误信息，绝不返回「已创建」", async () => {
    state.failIndexWrite = true; // 只有索引键的写入失败；提醒本体（automations/<userId>/）照常成功

    const res = await POST(req({ json: reminderJson }));

    expect(res.status).toBe(503);
    const j = (await res.json()) as { error?: string };
    expect(j.error).toContain("派发索引");
    expect(store.has(INDEX)).toBe(false); // 没有伪造成功
  });

  it("索引写成功 → 照常 200 返回 reminder，且索引里有该用户", async () => {
    const res = await POST(req({ json: reminderJson }));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { reminder?: { id?: string } };
    expect(j.reminder?.id).toBeTruthy();
    const owners = (store.get(INDEX) as { owners: { userId: string }[] }).owners;
    expect(owners.some((o) => o.userId === "u_fix")).toBe(true);
  });
});

describe("DELETE：列表读失败不得误撤派发索引", () => {
  it("listReminders 抛错 → 不 unregister，索引条目保留", async () => {
    store.set(INDEX, { owners: [{ userId: "u_fix", email: "fix@x.dev" }] });
    store.set("automations/u_fix/rem_1.json", { id: "rem_1", title: "复习", time: "08:00" });
    const dbList = (await import("../server/db")).dbList as ReturnType<typeof vi.fn>;
    dbList.mockImplementationOnce(async () => {
      throw new Error("RDS 请求失败：连接超时");
    });

    const res = await DELETE(req({ id: "rem_1" }));

    expect(res.status).toBe(200); // 删除本体成功，不影响响应
    const owners = (store.get(INDEX) as { owners: { userId: string }[] }).owners;
    expect(owners.some((o) => o.userId === "u_fix")).toBe(true); // 条目还在
  });

  it("列表确实为空 → 正常撤索引", async () => {
    store.set(INDEX, { owners: [{ userId: "u_fix", email: "fix@x.dev" }] });
    const res = await DELETE(req({ id: "rem_404" }));
    expect(res.status).toBe(200);
    const owners = (store.get(INDEX) as { owners: { userId: string }[] }).owners;
    expect(owners.some((o) => o.userId === "u_fix")).toBe(false);
  });
});

describe("personal.readIndex：读失败 fail-closed，不得用单条数据覆盖整份索引", () => {
  it("索引读抛错 → registerAutomationOwner 原样抛错且不写索引", async () => {
    store.set(INDEX, { owners: [{ userId: "u_other", email: "other@x.dev" }] });
    const dbGet = (await import("../server/db")).dbGet as ReturnType<typeof vi.fn>;
    dbGet.mockImplementationOnce(async () => {
      throw new Error("网络抖动");
    });

    const { registerAutomationOwner } = await import("../server/personal");
    await expect(registerAutomationOwner("u_fix", "fix@x.dev")).rejects.toThrow("网络抖动");
    // 索引原封不动：没有在"当空"之后写入只含 u_fix 的新索引
    const owners = (store.get(INDEX) as { owners: { userId: string }[] }).owners;
    expect(owners.map((o) => o.userId)).toEqual(["u_other"]);
  });

  it("索引不存在（dbGet 返回 null）→ 正常首建，这是合法路径", async () => {
    const { registerAutomationOwner, listAutomationOwners } = await import("../server/personal");
    await registerAutomationOwner("u_first", "first@x.dev");
    expect(await listAutomationOwners()).toEqual([{ userId: "u_first", email: "first@x.dev" }]);
  });
});
