import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* GET /api/memory?limit=… 的取值回归锁（修复前：只夹上界 200，不夹下界）。
 * 修复前 `Math.min(Number(q) || 0, 200)` 对 limit=-5 得 -5（真值），
 * 第 51 行 `filtered.slice(0, -5)` 语义从「取前 5 条」变成「丢掉最后 5 条」：
 * 8 条输入返回前 3 条，且 limit 为负数时调用方无法通过省略参数得到全量。
 * 修复 = Math.max(0, Math.min(…, 200))；0/非数字/缺省仍表示「不截断」。 */

const ENTRIES = Array.from({ length: 8 }, (_, i) => ({
  id: `mem_${i}`,
  text: `记忆条目 ${i}`,
  tags: ["t"],
  source: "chat",
  createdAt: `2026-11-0${i + 1}T00:00:00.000Z`,
}));

vi.mock("../server/personal", () => ({
  listMemory: vi.fn(async () => ENTRIES),
  addMemory: vi.fn(),
  deleteMemory: vi.fn(),
  isValidItemId: vi.fn(() => true),
  sanitizeMemoryInput: vi.fn(),
}));

vi.mock("../server/device-auth", () => ({
  verifyAnyAuth: vi.fn(async () => ({ userId: "u1" })),
}));

vi.mock("../server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
}));

vi.mock("../server/deploy-env", () => ({
  isDeployed: vi.fn(() => false),
}));

import { GET } from "../../app/api/memory/route";

function makeReq(limit?: string) {
  return {
    headers: { get: () => null },
    nextUrl: {
      searchParams: {
        get: (k: string) => {
          if (k === "limit") return limit ?? null;
          return null;
        },
      },
    },
  } as unknown as import("next/server").NextRequest;
}

async function getLength(limit?: string): Promise<{ entries: number; total: number }> {
  const res = await GET(makeReq(limit));
  const body = (await res.json()) as { entries: unknown[]; total: number };
  return { entries: body.entries.length, total: body.total };
}

describe("GET /api/memory limit 边界", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("负数字符串不反向截断（-5 返回全量，而非丢掉尾部 5 条）", async () => {
    expect(await getLength("-5")).toEqual({ entries: 8, total: 8 });
  });

  it("负数字符串 -1 也不截断", async () => {
    expect(await getLength("-1")).toEqual({ entries: 8, total: 8 });
  });

  it("正数正常截断", async () => {
    expect(await getLength("3")).toEqual({ entries: 3, total: 8 });
  });

  it("上界仍夹在 200（此例数据不足 200，验证不报错且返回全量）", async () => {
    expect(await getLength("500")).toEqual({ entries: 8, total: 8 });
  });

  it("0 / 缺省 / 非数字都表示不截断", async () => {
    expect(await getLength("0")).toEqual({ entries: 8, total: 8 });
    expect(await getLength(undefined)).toEqual({ entries: 8, total: 8 });
    expect(await getLength("abc")).toEqual({ entries: 8, total: 8 });
  });
});
