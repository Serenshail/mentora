import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* ============ rl/ 持久化限流桶必须有清理（D1/Upstash 无原生 TTL）============
 * 历史缺陷：只有华为 DCS 通道给 rl/ 配了 1h EX（db.ts DCS_TTL_SECONDS）；D1/Upstash/
 * RDS/GitHub 通道没有任何过期机制，而每个唯一 clientIp 都会为每个端点留下一个永久的
 * rl/<env>/<hash>.json——公网流量下 IP 只增不减，存储无界蔓延。
 * 修复：rateLimitPersistent 里做乐观清理（每进程 ≤1 次/小时，删 updated 早于 1h 的桶）。 */

const { deleteMock } = vi.hoisted(() => ({ deleteMock: vi.fn() }));

let kv = new Map<string, unknown>();
const now = Date.now();
const stale = `rl/test/${"a".repeat(32)}.json`;
const fresh = `rl/test/${"b".repeat(32)}.json`;

vi.mock("../server/db", () => ({
  hasHealthyRemoteDb: () => true,
  dbGet: vi.fn(async (path: string) => {
    if (kv.has(path)) return structuredClone(kv.get(path));
    if (path.startsWith("rl/test/c-")) return { tokens: 10, updated: now };
    return null;
  }),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    kv.set(path, structuredClone(value));
    return { sha: "mem" };
  }),
  dbList: vi.fn(async (dir: string) =>
    dir === "rl/test" ? [{ name: stale.slice("rl/test/".length), sha: "mem" }, { name: fresh.slice("rl/test/".length), sha: "mem" }] : []
  ),
  dbDelete: deleteMock,
}));

vi.mock("../server/deploy-env", () => ({ deployEnv: () => "test", isDeployed: () => true, isProdDeploy: () => false }));

import { rateLimitPersistent } from "../server/rate-limit";

beforeEach(() => {
  kv = new Map();
  deleteMock.mockReset();
  deleteMock.mockImplementation(async (path: string) => {
    kv.delete(path);
  });
  kv.set(stale, { tokens: 1, updated: now - 2 * 3600_000 }); // 2h 未动 → 死桶
  kv.set(fresh, { tokens: 1, updated: now }); // 活跃桶 → 必须保留
});

describe("rateLimitPersistent：乐观清理 rl/ 死桶", () => {
  it("删掉超过 1h 未动的桶，保留活跃桶", async () => {
    const ok = await rateLimitPersistent("c-some-client", { capacity: 10, refillPerSec: 1 });
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20)); // 清理是 fire-and-forget

    expect(deleteMock).toHaveBeenCalledWith(stale, null);
    expect(deleteMock).not.toHaveBeenCalledWith(fresh, null);
  });

  it("本次调用的桶正常落盘（清理不干扰限流本身）", async () => {
    await rateLimitPersistent("c-another", { capacity: 10, refillPerSec: 1 });
    const path = `rl/test/${crypto.createHash("sha256").update("c-another").digest("hex").slice(0, 32)}.json`;
    expect(kv.has(path)).toBe(true);
  });
});
