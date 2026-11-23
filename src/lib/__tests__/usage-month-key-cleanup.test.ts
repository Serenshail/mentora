import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* ============ usage/ 旧月键必须被清理（键头注释早已承诺）============
 * 历史缺陷：模块头注释写「旧月键在首次计量时顺手清理」，但 addUsage/getMonthlyUsage 里
 * 从没有任何 dbList/dbDelete——usage/<hash>/<YYYY-MM>.json 每用户每月永久累积一行、
 * 无界增长（quota.ts v17 修过同类问题，usage 借了注释没借实现）。
 * 修复：本月第一次计量（此前无本月记录）时列出该用户目录、删掉非本月键；不 await、
 * 失败无所谓——绝不挡在请求路径上。 */

let store = new Map<string, unknown>();
const { listMock, deleteMock } = vi.hoisted(() => ({ listMock: vi.fn(), deleteMock: vi.fn() }));

vi.mock("../server/db", () => ({
  emailHash: () => "h",
  hasHealthyRemoteDb: () => true,
  dbGet: vi.fn(async (path: string) => (store.has(path) ? structuredClone(store.get(path)) : null)),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    store.set(path, structuredClone(value));
    return { sha: "mem" };
  }),
  dbList: listMock,
  dbDelete: deleteMock,
}));

import { addUsage } from "../server/usage";

const EMAIL = "u@x.com";
const month = () => new Date().toISOString().slice(0, 7);
const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  store = new Map();
  listMock.mockReset();
  deleteMock.mockReset();
  listMock.mockImplementation(async (dir: string) =>
    [...store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .map((k) => ({ name: k.slice(dir.length + 1), sha: "mem" }))
  );
  deleteMock.mockImplementation(async (path: string) => {
    store.delete(path);
  });
});

describe("addUsage：历史月键清理", () => {
  it("本月首次计量 → 清掉旧月键、保留本月", async () => {
    store.set("usage/h/2020-01.json", { ti: 1, to: 1, n: 1 });
    await addUsage(EMAIL, 10, 20, {});
    await tick();

    const cur = `usage/h/${month()}.json`;
    expect(store.has(cur)).toBe(true);
    expect(store.has("usage/h/2020-01.json")).toBe(false);
    expect((store.get(cur) as { ti: number }).ti).toBe(10);
  });

  it("已有本月记录时不再触发清理（不每次计量都列目录）", async () => {
    store.set(`usage/h/${month()}.json`, { ti: 1, to: 1, n: 1 });
    store.set("usage/h/2020-01.json", { ti: 1, to: 1, n: 1 });
    await addUsage(EMAIL, 10, 20, {});
    await tick();

    expect(listMock).not.toHaveBeenCalled();
    expect(store.has("usage/h/2020-01.json")).toBe(true);
  });
});
