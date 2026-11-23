import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：quota 的日键曾把明文 id（通常是登录邮箱）直接拼进 KV 键名
 * `quota/<id>/<日期>.json`，违反本代码库自declared的「PII 不进键名」约定
 * （usage.ts:path 用 emailHash、reset-code/loginfail 同样哈希，quota 是唯一破例点）。
 * 明文键会落进 D1 的 k 列 / DCS / GitHub 仓库路径。本锁钉住键名已哈希、不含明文邮箱。 */

const h = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("../server/db", () => ({
  hasHealthyRemoteDb: () => true,
  dbGet: vi.fn(async (p: string) => {
    h.paths.push(p);
    return null;
  }),
  dbPut: vi.fn(async (p: string) => {
    h.paths.push(p);
    return { sha: "s" };
  }),
  dbList: vi.fn(async () => []),
  dbDelete: vi.fn(async () => {}),
}));

import { checkAndCountServerKey } from "../server/quota";

describe("quota 键名：PII 不进键名", () => {
  it("日键用哈希 id，绝不含明文邮箱/大小写形态", async () => {
    h.paths.length = 0;
    await checkAndCountServerKey("Alice@Example.com");
    expect(h.paths.length).toBeGreaterThan(0);
    for (const p of h.paths) {
      expect(p.startsWith("quota/")).toBe(true);
      expect(p).not.toContain("alice");
      expect(p).not.toContain("Alice");
      expect(p).not.toContain("@");
      expect(p).not.toContain("example.com");
    }
  });

  it("同 id 大小写不同 → 同一哈希桶（确定、可分区）", async () => {
    h.paths.length = 0;
    await checkAndCountServerKey("Bob@x.dev");
    const a = h.paths.slice();
    h.paths.length = 0;
    await checkAndCountServerKey("bob@X.DEV");
    expect(h.paths.slice()).toEqual(a);
  });
});
