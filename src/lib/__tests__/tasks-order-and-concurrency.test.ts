import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核，两处一起锁）：
 * ① 截断顺序：GET /api/tasks 旧实现先对目录原始序 items.slice(0, goalId ? 50 : 100) 截断，
 *   再做 goalId 过滤与 updatedAt 倒排——排序/过滤只对截断后的子集生效。taskId 形如
 *   pt_<Date.now().toString(36)>_…，目录序（RDS ORDER BY k 升序 / GitHub 字母序）≈ 时间
 *   升序即最旧在前，而任务记录只有写入没有删除路径：某用户累计超限后，最近一次被页面
 *   刷新中断的生成记录恰在列表尾部被截掉，learn/new/page.tsx:192-208 的中断恢复引导
 *   静默消失——与本路由 V26.1 P0「整页刷新后仍可查询任务发生过」的目标相反。
 *   修复：过滤→排序→截断；目录读取窗口从尾部取（最新优先，200 条兜住无界增长）。
 * ② 串行逐条 dbGet：旧实现 for 循环里逐个 await dbGet（最多 100 次远程往返），与
 *   personal.ts listMemory 修复过的同款反模式（MEMORY_READ_CHUNK=8 分块并行）。
 *   本文件用「块内并发确实重叠」（maxInFlight>1）锁住分块并行，与 memory-list-concurrency
 *   同法。 */

const store = new Map<string, unknown>();
const state = { inFlight: 0, maxInFlight: 0, dbGetCalls: 0 };
let failNames = new Set<string>();

vi.mock("../server/db", () => ({
  dbList: vi.fn(async (dir: string) =>
    [...store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .sort()
      .map((k) => ({ name: k.slice(dir.length + 1), sha: "mem" }))
  ),
  dbGet: vi.fn(async (path: string) => {
    state.dbGetCalls += 1;
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      /* 让并发的块内调用真的重叠，才能观测到 maxInFlight > 1 */
      await new Promise((r) => setTimeout(r, 1));
      if (failNames.has(path)) throw new Error("DB 读取失败（429）");
      return store.has(path) ? structuredClone(store.get(path)) : null;
    } finally {
      state.inFlight -= 1;
    }
  }),
  dbPut: vi.fn(async () => ({ sha: "mem" })),
}));

vi.mock("../server/auth", () => ({
  verifySession: vi.fn(async () => ({ userId: "u_me", email: "me@x.dev", name: "我", sv: 0 })),
}));

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
}));

vi.mock("../server/config", () => ({ logEvent: vi.fn() }));

import { GET } from "../../app/api/tasks/route";

const req = (query = "") =>
  ({ nextUrl: new URL(`http://localhost/api/tasks${query}`) }) as unknown as import("next/server").NextRequest;

/* 目录序 ≈ 时间升序（最旧在前）：名字与 updatedAt 都随 i 递增 */
function seedTasks(count: number, goalId = "g1") {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < count; i++) {
    store.set(`tasks/u_me/pt_${String(i).padStart(3, "0")}_x.json`, {
      taskId: `pt_${String(i).padStart(3, "0")}_x`,
      goalId,
      kind: "master",
      status: i === count - 1 ? "running" : "interrupted",
      startedAt: new Date(base + i * 1000).toISOString(),
      updatedAt: new Date(base + i * 1000).toISOString(),
    });
  }
}

beforeEach(() => {
  store.clear();
  failNames = new Set();
  state.inFlight = 0;
  state.maxInFlight = 0;
  state.dbGetCalls = 0;
});

describe("GET /api/tasks：截断必须在过滤与排序之后", () => {
  it("120 条同 goal 记录 + goalId 查询 → 返回最新 50 条（修复前截断在前，最新中断记录被截掉）", async () => {
    seedTasks(120);
    const res = await GET(req("?goalId=g1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { taskId: string }[] };
    expect(body.tasks).toHaveLength(50);
    /* 最新一条（running、被刷新打断的那次生成）必须在列表头部 */
    expect(body.tasks[0]!.taskId).toBe("pt_119_x");
    /* 修复前：slice(0,50) 先截掉 i>=50，倒排后头部是 pt_49_x */
    expect(body.tasks.map((t) => t.taskId)).not.toContain("pt_049_x");
    expect(body.tasks[1]!.taskId).toBe("pt_118_x");
  });

  it("120 条记录 + 不带 goalId → 返回最新 100 条（修复前截断在前，只拿到最旧 100 条）", async () => {
    seedTasks(120);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { taskId: string }[] };
    expect(body.tasks).toHaveLength(100);
    expect(body.tasks[0]!.taskId).toBe("pt_119_x");
    /* 新窗口 = 第 20..119 条：含 pt_100（旧实现拿不到），不含 pt_19（旧实现拿到的最旧段） */
    const ids = body.tasks.map((t) => t.taskId);
    expect(ids).toContain("pt_100_x");
    expect(ids).not.toContain("pt_019_x");
    expect(ids).not.toContain("pt_000_x");
  });

  it("250 条记录：读取窗口从目录序尾部取 200（最新优先），dbGet 至多 200 次", async () => {
    seedTasks(250);
    const res = await GET(req("?goalId=g1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { taskId: string }[] };
    expect(body.tasks).toHaveLength(50);
    expect(body.tasks[0]!.taskId).toBe("pt_249_x");
    expect(state.dbGetCalls).toBe(200); // 兜住「只增不删」目录的无界增长
  });
});

describe("GET /api/tasks：分块并行读（不再串行逐条往返）", () => {
  it("20 条记录的块内读确实并发重叠（串行实现 maxInFlight 恒为 1）", async () => {
    seedTasks(20);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { taskId: string }[] };
    expect(body.tasks).toHaveLength(20);
    expect(state.maxInFlight).toBeGreaterThan(1);
    /* 结果仍按 updatedAt 倒排 */
    expect(body.tasks[0]!.taskId).toBe("pt_019_x");
  });
});
