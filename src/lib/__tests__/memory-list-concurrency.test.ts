import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* listMemory 串行 N+1 的性能回归锁（修复前：for 循环里逐条 await dbGet）。
 * 每条记忆一次远端 KV 往返 + 一次 AES 解密，上限 500 条时 D1 100-300ms/次即分钟级：
 *  ① chat/route.ts 每条 agent 对话都调（withBudget 1500 只保证先返回，不取消底层读）；
 *  ② GET /api/memory 无预算直等；
 *  ③ addMemory 每次新增都全量拉一遍做去重/上限检查。
 * 修复口径与 admin/members、admin/leads、cron/weekly-digest 一致：块内并行 8、块间串行，
 * 并支持 deadline 真停（超预算不再继续烧远端读）。
 * 本锁同时钉住数据面未变：单条失败只跳过、非 .json 忽略、按 createdAt 降序。 */

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  failPaths: new Set<string>(),
  inFlight: 0,
  maxInFlight: 0,
  gets: 0,
  clock: 0,
  bumpClockAfter: 0,
}));

vi.mock("../server/db", () => ({
  dbGet: vi.fn(async (path: string) => {
    h.gets++;
    h.inFlight++;
    h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
    try {
      /* 模拟远端读延迟：块内并发才会在时间上重叠，串行实现 maxInFlight 恒为 1 */
      await new Promise((r) => setTimeout(r, 3));
      if (h.bumpClockAfter && h.gets >= h.bumpClockAfter) h.clock = 10_000;
      if (h.failPaths.has(path)) throw new Error("单条解密失败");
      const v = h.store.get(path);
      return v == null ? null : JSON.parse(v);
    } finally {
      h.inFlight--;
    }
  }),
  dbList: vi.fn(async (dir: string) =>
    [...h.store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .map((k) => ({ name: k.slice(dir.length + 1), sha: "mem" }))
  ),
  dbPut: vi.fn(async (path: string, val: unknown) => {
    h.store.set(path, JSON.stringify(val));
    return { sha: "mem" };
  }),
}));

import { addMemory, listMemory } from "../server/personal";

const DIR = "memory/u1";
const pathOf = (i: number) => `${DIR}/mem_${i}.json`;

function seed(i: number) {
  h.store.set(
    pathOf(i),
    JSON.stringify({
      id: `mem_${i}`,
      text: `记忆条目 ${i}`,
      tags: ["t"],
      source: "agent",
      createdAt: `2026-11-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    })
  );
}

beforeEach(() => {
  h.store.clear();
  h.failPaths.clear();
  h.inFlight = 0;
  h.maxInFlight = 0;
  h.gets = 0;
  h.clock = 0;
  h.bumpClockAfter = 0;
  vi.spyOn(Date, "now").mockImplementation(() => h.clock);
});

afterEach(() => {
  vi.restoreAllMocks(); // 还原 Date.now，避免污染同进程的其他测试文件
});

describe("listMemory 分块并发读", () => {
  it("30 条：maxInFlight=8（修复前串行恒为 1），全量返回且按 createdAt 降序", async () => {
    for (let i = 0; i < 30; i++) seed(i);
    const out = await listMemory("u1");
    expect(out).toHaveLength(30);
    expect(h.maxInFlight).toBe(8);
    expect(h.gets).toBe(30);
    const times = out.map((m) => m.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("单条解密失败只跳过该条，其余照常返回", async () => {
    for (let i = 0; i < 20; i++) seed(i);
    h.failPaths.add(pathOf(7));
    const out = await listMemory("u1");
    expect(out).toHaveLength(19);
    expect(out.some((m) => m.id === "mem_7")).toBe(false);
  });

  it("非 .json 条目被忽略（不发起读）", async () => {
    seed(0);
    h.store.set(`${DIR}/_index.json.bak`, "{}");
    const out = await listMemory("u1");
    expect(out).toHaveLength(1);
    expect(h.gets).toBe(1);
  });

  it("deadline 已过：一次读都不发，返回空（超预算不再烧远端读）", async () => {
    for (let i = 0; i < 30; i++) seed(i);
    h.clock = 10_000; // 时钟已在 deadline 之后
    const out = await listMemory("u1", { deadline: 1_000 });
    expect(out).toEqual([]);
    expect(h.gets).toBe(0);
  });

  it("读到一半超 deadline：只跑完首块（8 次），不再继续后续块", async () => {
    for (let i = 0; i < 30; i++) seed(i);
    h.bumpClockAfter = 8; // 首块 8 次读完成后时钟越到 10000 > deadline
    const out = await listMemory("u1", { deadline: 5_000 });
    expect(h.gets).toBe(8);
    expect(out).toHaveLength(8);
  });
});

describe("addMemory 行为不变（内部依赖全量列表做去重与上限）", () => {
  it("重复文本拒绝、新文本入库", async () => {
    seed(0);
    h.store.set(
      pathOf(0),
      JSON.stringify({ id: "mem_0", text: "我习惯用 Python", tags: [], source: "agent", createdAt: "2026-11-01T00:00:00.000Z" })
    );
    const dup = await addMemory("u1", { text: "我习惯用 Python", tags: [], source: "agent" });
    expect("error" in dup).toBe(true);
    const ok = await addMemory("u1", { text: "我在学 Rust", tags: [], source: "agent" });
    expect("error" in ok).toBe(false);
    expect(h.store.has(`${DIR}/${(ok as { id: string }).id}.json`)).toBe(true);
  });
});
