import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* readEntitlement 的进程内 memo 必须有界：自托管长驻进程里每个历史用户都会
 * 留一条，无上限就是内存泄漏。这里用 dbGet 调用次数反推缓存是否被淘汰。 */

const dbGet = vi.fn(async (_path: string) => null as unknown);

vi.mock("../server/db", () => ({
  emailHash: (email: string) => Buffer.from(email.toLowerCase()).toString("hex").slice(0, 24),
  dbGet: (path: string) => dbGet(path),
  dbPut: vi.fn(async () => ({ sha: "mem" })),
  dbDelete: vi.fn(async () => {}),
  dbPutIfAbsent: vi.fn(async () => true),
}));

import { readEntitlement } from "../server/entitlement";

const N = 20_005; // 超过 MAX_MEMO_ENTRIES = 20_000

describe("readEntitlement 进程内 memo 有界", () => {
  it("超出上限后淘汰旧条目，不会随历史用户数无界增长", async () => {
    for (let i = 0; i < N; i++) await readEntitlement(`u${i}@example.com`);
    expect(dbGet).toHaveBeenCalledTimes(N);

    // 最新写入的仍在缓存内：不再读库
    await readEntitlement(`u${N - 1}@example.com`);
    expect(dbGet).toHaveBeenCalledTimes(N);

    // 最早的已被淘汰：必须重新读库（若 Map 无界增长，这里不会增加调用次数）
    await readEntitlement("u0@example.com");
    expect(dbGet).toHaveBeenCalledTimes(N + 1);
  }, 30_000);

  it("30s TTL 内的命中仍然生效", async () => {
    await readEntitlement("hit@example.com");
    const before = dbGet.mock.calls.length;
    await readEntitlement("hit@example.com");
    expect(dbGet.mock.calls.length).toBe(before);
  });
});
