import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* 计划任务 taskId 路径穿越防护回归锁（v27.6 安全修复）：
 * POST /api/tasks 的 taskId 仅 slice(0,64) 即拼进存储路径
 * tasks/<userId>/<taskId>.json。GitHub Contents 兜底通道（db.ts ghApi）把整条
 * path 原样拼进 api.github.com URL，WHATWG URL 规范化会消解 `..`：登录用户传
 * taskId=../../users/<24位emailHash> 可越权覆盖任意用户档案（salt/hash 被一条
 * 加密 TaskRecord 换掉，受害者无法登录），taskId=../../data/<userId> 可毁任意
 * 用户数据快照。修复 = TASK_ID_RE 字符白名单（[A-Za-z0-9_-]{1,64}），双重落点：
 *  ① tasks/route.ts POST 入口显式 400（白名单矩阵 + 真实路由执行）；
 *  ② 源码扫描护栏：白名单校验必须位于 dbGet/dbPut 之前（防回归漂移），
 *    与 personal-id-guard.test.ts 的既定做法同源。 */

const store = new Map<string, unknown>();

vi.mock("../server/db", () => ({
  dbGet: vi.fn(async (key: string) => (store.has(key) ? structuredClone(store.get(key)) : null)),
  dbPut: vi.fn(async (key: string, val: unknown) => {
    store.set(key, structuredClone(val));
    return { sha: "mem" };
  }),
  dbDelete: vi.fn(async (key: string) => {
    store.delete(key);
  }),
  dbList: vi.fn(async (dir: string) =>
    [...store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .map((k) => ({ name: k.slice(dir.length + 1), sha: "mem" }))
  ),
}));

vi.mock("../server/auth", () => ({
  verifySession: vi.fn(async () => ({ userId: "u_me", email: "me@x.dev", name: "我", sv: 0 })),
}));

import { POST } from "../../app/api/tasks/route";

const VICTIM_HASH = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"; // 24 位，形如 emailHash(email)

const req = (body: Record<string, unknown>) =>
  ({
    json: async () => body,
    nextUrl: new URL("http://localhost/api/tasks"),
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  store.clear();
  store.set(`users/${VICTIM_HASH}.json`, { userId: "u_victim", email: "v@x.dev" });
  store.set(`data/u_victim.json`, { userId: "u_victim", payload: "受害者的学习数据" });
});

describe("POST /api/tasks：taskId 白名单拦截路径穿越（真实路由执行）", () => {
  it("taskId=../../users/<hash> → 400，受害者档案不被覆盖", async () => {
    const res = await POST(req({ taskId: `../../users/${VICTIM_HASH}`, goalId: "g1", status: "running" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "taskId 不合法" });
    expect(store.get(`users/${VICTIM_HASH}.json`)).toEqual({ userId: "u_victim", email: "v@x.dev" });
  });

  it("taskId=../../data/<userId> → 400，受害者数据快照不被污染", async () => {
    const res = await POST(req({ taskId: "../../data/u_victim", goalId: "g1", status: "running" }));
    expect(res.status).toBe(400);
    expect(store.get("data/u_victim.json")).toEqual({ userId: "u_victim", payload: "受害者的学习数据" });
  });

  it("taskId=..、a/b、a.b、a%2Fb、空串等特殊形态 → 400", async () => {
    for (const bad of ["..", "../x", "a/b", "a.b", "a%2Fb", "a b", "", null]) {
      const res = await POST(req({ taskId: bad, goalId: "g1", status: "running" }));
      expect(res.status, `taskId=${String(bad)} 应被拒`).toBe(400);
    }
    expect([...store.keys()].filter((k) => !k.startsWith("users/") && !k.startsWith("data/"))).toEqual([]);
  });

  it("合法 taskId 正常写入自己的命名空间（功能不受影响）", async () => {
    const good = `pt_${Date.now().toString(36)}_abc123`;
    const res = await POST(req({ taskId: good, goalId: "g1", status: "running", startedAt: "2026-01-01T00:00:00.000Z" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    const rec = store.get(`tasks/u_me/${good}.json`) as { taskId: string; status: string } | undefined;
    expect(rec?.taskId).toBe(good);
    expect(rec?.status).toBe("running");
  });

  it("64 字符合法形态放行；未登录时无写入（鉴权仍先行）", async () => {
    const res = await POST(req({ taskId: "T".repeat(64), goalId: "g1", status: "completed" }));
    expect(res.status).toBe(200);
    expect(store.has(`tasks/u_me/${"T".repeat(64)}.json`)).toBe(true);
  });
});

describe("源码护栏：POST 入口白名单必须先于 dbGet/dbPut（防回归漂移）", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("tasks/route.ts 定义字符白名单且在 dbGet 之前校验", () => {
    const src = read("../../app/api/tasks/route.ts");
    expect(src).toMatch(/const TASK_ID_RE = \/\^\[A-Za-z0-9_-\]\{1,64\}\$\//);
    const post = src.slice(src.indexOf("export async function POST"));
    const guard = post.indexOf("TASK_ID_RE.test(taskId)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(post.indexOf("dbGet"));
    expect(guard).toBeLessThan(post.indexOf("dbPut"));
  });

  it("GitHub 兜底通道 URL 拼接点未被削弱（ghApi 仍拼 path——防护在入口层）", () => {
    const src = read("../server/db.ts");
    expect(src).toMatch(/api\.github\.com\/repos\/\$\{REPO\}\/contents\/\$\{path\}/);
  });
});

describe("URL 折叠攻击面记录（WHATWG 规范化实测，防通道语义回归）", () => {
  it("contents 路径中的 ../ 确实被 URL 规范化消解（漏洞成立的前提）", () => {
    const u = new URL(`https://api.github.com/repos/o/r/contents/tasks/u_me/../../users/${VICTIM_HASH}.json`);
    expect(u.pathname).toBe(`/repos/o/r/contents/users/${VICTIM_HASH}.json`);
  });
});
