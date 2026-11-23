import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));

/* 删号级联清理回归锁（v27.4 安全修复）：
 * 旧口径删号只清 users/ data/ versions/，漏两处会真出事：
 *  ① memory/<userId>/ 长期记忆残留——违背 account 路由「注销必须清掉用户数据」的隐私承诺；
 *  ② automations/<userId>/ + automations/_index.json 残留——cron/tick 按索引对已删账号
 *     照常到期并发提醒邮件（邮箱被回收再分配时会把内容发给陌生人）。
 * ①②用内存 KV 替身跑真实 purgePersonalData 执行校验；两个删号路由用源码扫描护栏
 * （路由文件 import 依赖 @/ 别名，vitest 无 alias 配置，现有测试均不直测路由）。 */

const store = new Map<string, unknown>();

vi.mock("../server/db", () => ({
  dbGet: vi.fn(async (key: string) => store.get(key) ?? null),
  dbPut: vi.fn(async (key: string, val: unknown) => {
    store.set(key, val);
    return {};
  }),
  dbDelete: vi.fn(async (key: string) => {
    store.delete(key);
  }),
  dbList: vi.fn(async (dir: string) =>
    [...store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .map((k) => ({ name: k.slice(dir.length + 1), sha: "t" }))
  ),
  dbDeleteDir: vi.fn(async (dir: string) => {
    let n = 0;
    for (const k of [...store.keys()]) {
      if (k.startsWith(`${dir}/`)) {
        store.delete(k);
        n++;
      }
    }
    return n;
  }),
}));

import { purgePersonalData, registerAutomationOwner, listAutomationOwners, addMemory } from "../server/personal";

const INDEX = "automations/_index.json";

function seedDeletedAccount(userId: string) {
  store.set(`automations/${userId}/rem_1.json`, { id: "rem_1", title: "复习", time: "08:00" });
  store.set(`memory/${userId}/mem_1.json`, { id: "mem_1", text: "我习惯用 Python 写脚本" });
}

beforeEach(() => {
  store.clear();
});

describe("purgePersonalData（删号级联清理，真实执行）", () => {
  it("撤派发索引 + 清空 automations/ 与 memory/ 三个键空间", async () => {
    seedDeletedAccount("u_purge");
    await registerAutomationOwner("u_purge", "gone@x.dev");
    expect((store.get(INDEX) as { owners: unknown[] }).owners).toHaveLength(1);

    await purgePersonalData("u_purge");

    expect(await listAutomationOwners()).toHaveLength(0); // 索引已撤
    expect(store.get("automations/u_purge/rem_1.json")).toBeUndefined(); // 提醒已删
    expect(store.get("memory/u_purge/mem_1.json")).toBeUndefined(); // 记忆已删
  });

  it("只清目标用户：其他用户的索引条目与数据不受波及", async () => {
    seedDeletedAccount("u_gone");
    seedDeletedAccount("u_stay");
    await registerAutomationOwner("u_gone", "gone@x.dev");
    await registerAutomationOwner("u_stay", "stay@x.dev");
    await addMemory("u_stay", { text: " stay 的记忆 ", tags: [], source: "agent" });

    await purgePersonalData("u_gone");

    const owners = await listAutomationOwners();
    expect(owners).toHaveLength(1);
    expect(owners[0].userId).toBe("u_stay");
    expect(store.get("automations/u_stay/rem_1.json")).toBeDefined();
    expect([...store.keys()].some((k) => k.startsWith("memory/u_stay/"))).toBe(true);
    expect([...store.keys()].some((k) => k.startsWith("memory/u_gone/"))).toBe(false);
  });

  it("无任何数据的用户也能安全走完（幂等，不抛异常）", async () => {
    await expect(purgePersonalData("u_never_existed")).resolves.toBeUndefined();
    expect(store.has(INDEX)).toBe(false); // 不该凭空造出索引
  });
});

describe("源码护栏：两条删号路径必须接 purgePersonalData（防回归漂移）", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("管理端删除（admin/users DELETE）在删 versions 后调用 purgePersonalData", () => {
    const src = read("../../app/api/admin/users/route.ts");
    expect(src).toContain('import { purgePersonalData } from "@/lib/server/personal"');
    const del = src.slice(src.indexOf("export async function DELETE"), src.indexOf("export async function POST"));
    expect(del).toMatch(/dbDeleteDir\(`versions\/\$\{rec\.userId\}`\)/);
    expect(del).toContain("purgePersonalData(rec.userId)");
    expect(del.indexOf("purgePersonalData")).toBeGreaterThan(del.indexOf("versions/")); // 在最后一步清理
  });

  it("自助注销（auth/account DELETE）同口径调用 purgePersonalData", () => {
    const src = read("../../app/api/auth/account/route.ts");
    expect(src).toContain('import { purgePersonalData } from "@/lib/server/personal"');
    const del = src.slice(src.indexOf("export async function DELETE"));
    expect(del).toMatch(/dbDeleteDir\(`versions\/\$\{record\.userId\}`\)/);
    expect(del).toContain("purgePersonalData(record.userId)");
    expect(del.indexOf("clearSessionCookie")).toBeGreaterThan(del.indexOf("purgePersonalData")); // 清会话前先清数据
  });

  it("purgePersonalData 先撤索引再删目录（撤索引失败不阻断删目录）", () => {
    const src = read("../server/personal.ts");
    const fn = src.slice(src.indexOf("export async function purgePersonalData"));
    expect(fn.indexOf("unregisterAutomationOwner")).toBeLessThan(fn.indexOf("dbDeleteDir(`automations/"));
    expect(fn).toMatch(/\.catch\(\(\) => \{\}\)/);
  });
});
