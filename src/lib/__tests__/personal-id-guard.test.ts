import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));

/* 记忆/提醒条目 id 越权删除防护（v27.5 安全修复）回归锁：
 * DELETE /api/memory?id=… 与 /api/reminders?id=… 的 id 会拼进存储路径
 * memory/<userId>/<id>.json / automations/<userId>/<id>.json。GitHub Contents
 * 兜底通道（db.ts ghApi）把整条 path 拼进 api.github.com URL，URL 规范化会消解
 * `..`：登录用户传 id=../../users/<hash> 可越权删除任意用户档案，id=../_index
 * 可删掉 automations/_index.json 全局提醒派发索引（所有用户提醒静默停发）。
 * 修复 = isValidItemId 字符白名单，双重落点：
 *  ① personal.ts deleteMemory/deleteReminder 数据层拦（覆盖未来任何调用方）；
 *  ② memory/reminders 两条 DELETE 路由显式 400（源码扫描护栏防漂移）。
 * ①用内存 KV 替身跑真实函数验证；②路由文件 import 依赖 @/ 别名，同
 * account-purge.test.ts 的既定做法用源码扫描护栏。 */

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

import { deleteMemory, deleteReminder, isValidItemId, newId } from "../server/personal";

const VICTIM_HASH = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"; // 24 位，形如 emailHash(email)

beforeEach(() => {
  store.clear();
  store.set(`users/${VICTIM_HASH}.json`, { userId: "u_victim" }); // 越权删除的目标
  store.set("automations/_index.json", { owners: [{ userId: "u_victim", email: "v@x.dev" }] });
  store.set("memory/u_me/mem_ok.json", { id: "mem_ok", text: "自己的记忆" });
  store.set("automations/u_me/rem_ok.json", { id: "rem_ok", title: "自己的提醒" });
});

describe("isValidItemId（条目 id 字符白名单）", () => {
  it("放行真实形态 id：newId 产物与普通字母数字/连字符/下划线", () => {
    const sample = newId("mem");
    expect(isValidItemId(sample)).toBe(true);
    expect(isValidItemId("mem_abc123")).toBe(true);
    expect(isValidItemId("rem_x-y_z09")).toBe(true);
  });

  it("拦截路径遍历与特殊字符", () => {
    expect(isValidItemId("../../users/" + VICTIM_HASH)).toBe(false);
    expect(isValidItemId("../_index")).toBe(false);
    expect(isValidItemId("..")).toBe(false);
    expect(isValidItemId("a/b")).toBe(false);
    expect(isValidItemId("a.b")).toBe(false);
    expect(isValidItemId("a%2Fb")).toBe(false);
    expect(isValidItemId("")).toBe(false);
    expect(isValidItemId(null as unknown as string)).toBe(false);
  });

  it("拦截超长 id（上限 80，防 KV 键滥用）", () => {
    expect(isValidItemId("a".repeat(80))).toBe(true);
    expect(isValidItemId("a".repeat(81))).toBe(false);
  });
});

describe("deleteMemory/deleteReminder（数据层防护，真实执行）", () => {
  it("恶意 id=../../users/<hash> 不越权删除用户档案", async () => {
    await deleteMemory("u_me", `../../users/${VICTIM_HASH}`);
    await deleteReminder("u_me", `../../users/${VICTIM_HASH}`);
    expect(store.get(`users/${VICTIM_HASH}.json`)).toBeDefined();
  });

  it("恶意 id=../_index 不删除全局提醒派发索引", async () => {
    await deleteReminder("u_me", "../_index");
    expect(store.get("automations/_index.json")).toBeDefined();
  });

  it("合法 id 正常删除自己的条目（功能不受影响）", async () => {
    await deleteMemory("u_me", "mem_ok");
    await deleteReminder("u_me", "rem_ok");
    expect(store.get("memory/u_me/mem_ok.json")).toBeUndefined();
    expect(store.get("automations/u_me/rem_ok.json")).toBeUndefined();
  });
});

describe("源码护栏：两条 DELETE 路由必须接 isValidItemId（防回归漂移）", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("memory DELETE 在调用 deleteMemory 前显式 400", () => {
    const src = read("../../app/api/memory/route.ts");
    expect(src).toMatch(/import \{[\s\S]*isValidItemId[\s\S]*\} from "@\/lib\/server\/personal"/);
    const del = src.slice(src.indexOf("export async function DELETE"));
    expect(del).toMatch(/if \(!isValidItemId\(id\)\) return Response\.json\(\{ error: "id 不合法" \}, \{ status: 400 \}\)/);
    expect(del.indexOf("isValidItemId")).toBeLessThan(del.indexOf("deleteMemory"));
  });

  it("reminders DELETE 在调用 deleteReminder 前显式 400", () => {
    const src = read("../../app/api/reminders/route.ts");
    expect(src).toMatch(/import \{[\s\S]*isValidItemId[\s\S]*\} from "@\/lib\/server\/personal"/);
    const del = src.slice(src.indexOf("export async function DELETE"));
    expect(del).toMatch(/if \(!isValidItemId\(id\)\) return Response\.json\(\{ error: "id 不合法" \}, \{ status: 400 \}\)/);
    expect(del.indexOf("isValidItemId")).toBeLessThan(del.indexOf("deleteReminder"));
  });

  it("personal.ts 两个删除函数内部各自保留数据层拦截", () => {
    const src = read("../server/personal.ts");
    const mem = src.slice(src.indexOf("export async function deleteMemory"));
    const rem = src.slice(src.indexOf("export async function deleteReminder"));
    expect(mem).toMatch(/if \(!isValidItemId\(id\)\) return/);
    expect(rem).toMatch(/if \(!isValidItemId\(id\)\) return/);
  });
});
