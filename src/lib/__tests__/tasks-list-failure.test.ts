import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* GET /api/tasks 故障态 vs 空态回归锁（v27 修复）：
 * 旧实现把 dbList 的失败 .catch(() => [])、逐条 dbGet 的失败 .catch(() => null)
 * 折叠成空列表，响应与"这个用户确实没有任务"逐字节相同。前端 learn/new/page.tsx
 * 靠这份列表判断"上次生成被页面刷新中断"并给重新生成引导，故障时引导静默消失。
 * 锁四件事：
 *  1) 列目录失败 → 503，绝不返回 {tasks:[]}；
 *  2) 有记录但全部读失败 → 503（无法断言"没有任务"）；
 *  3) 部分读失败 → 200 + degraded:true + 能读到的照常返回；
 *  4) 真空目录 → 200 + {tasks:[]} 且不带 degraded（空态不受影响）。 */

let listFails = false;
let failNames = new Set<string>();
const store = new Map<string, unknown>();

vi.mock("../server/db", () => ({
  dbList: vi.fn(async (dir: string) => {
    if (listFails) throw new Error("DB 列目录失败（429）");
    return [...store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .map((k) => ({ name: k.slice(dir.length + 1), sha: "mem" }));
  }),
  dbGet: vi.fn(async (path: string) => {
    if (failNames.has(path)) throw new Error("DB 读取失败（429）");
    return store.has(path) ? structuredClone(store.get(path)) : null;
  }),
}));

vi.mock("../server/auth", () => ({
  verifySession: vi.fn(async () => ({ userId: "u_me", email: "me@x.dev", name: "我", sv: 0 })),
}));

import { GET } from "../../app/api/tasks/route";

const req = (query = "") =>
  ({ nextUrl: new URL(`http://localhost/api/tasks${query}`) }) as unknown as import("next/server").NextRequest;

const rec = (taskId: string, goalId: string, status = "running") => ({
  taskId,
  goalId,
  kind: "master",
  status,
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  listFails = false;
  failNames = new Set();
  store.clear();
});

describe("GET /api/tasks：故障态与空态可区分", () => {
  it("列目录失败 → 503（不再伪装成空列表）", async () => {
    listFails = true;
    const res = await GET(req("?goalId=g1"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { tasks?: unknown; error?: string };
    expect(body.tasks).toBeUndefined();
    expect(body.error).toContain("暂时不可用");
  });

  it("有记录但全部读取失败 → 503（无法断言没有任务）", async () => {
    store.set("tasks/u_me/pt_a.json", rec("pt_a", "g1"));
    store.set("tasks/u_me/pt_b.json", rec("pt_b", "g1"));
    failNames = new Set(["tasks/u_me/pt_a.json", "tasks/u_me/pt_b.json"]);
    const res = await GET(req("?goalId=g1"));
    expect(res.status).toBe(503);
  });

  it("部分读取失败 → 200 + degraded:true + 能读到的照常返回", async () => {
    store.set("tasks/u_me/pt_a.json", rec("pt_a", "g1"));
    store.set("tasks/u_me/pt_b.json", rec("pt_b", "g1", "interrupted"));
    failNames = new Set(["tasks/u_me/pt_b.json"]);
    const res = await GET(req("?goalId=g1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { taskId: string }[]; degraded?: boolean };
    expect(body.degraded).toBe(true);
    expect(body.tasks.map((t) => t.taskId)).toEqual(["pt_a"]);
  });

  it("真空目录 → 200 + tasks:[] 且不带 degraded（空态不被误报成故障）", async () => {
    const res = await GET(req("?goalId=g1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[]; degraded?: boolean };
    expect(body.tasks).toEqual([]);
    expect(body.degraded).toBeUndefined();
  });

  it("goalId 过滤与倒序保持（按 updatedAt 新→旧）", async () => {
    store.set("tasks/u_me/pt_old.json", { ...rec("pt_old", "g1"), updatedAt: "2026-01-01T00:00:00.000Z" });
    store.set("tasks/u_me/pt_new.json", { ...rec("pt_new", "g1"), updatedAt: "2026-02-01T00:00:00.000Z" });
    store.set("tasks/u_me/pt_other.json", rec("pt_other", "g2"));
    const res = await GET(req("?goalId=g1"));
    const body = (await res.json()) as { tasks: { taskId: string }[] };
    expect(body.tasks.map((t) => t.taskId)).toEqual(["pt_new", "pt_old"]);
  });
});
