import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* 回归锁：ensureCheck 的体检请求必须有客户端预算，且 inflight 槽位一定会释放。
 *
 * 修复前 fetchChecks（resource-pipeline.ts:53-65）是裸 fetch 无 signal；ensureCheck
 * （:89-107）也不像 checkUrls 那样套 withTimeout，却把 promise 存进模块级 inflight Map。
 * /api/linkcheck 请求一旦挂起（弱网/自托管停滞连接），fetch 既不 resolve 也不 reject，
 * inflight 条目永久驻留：此后所有 ensureCheck(url) 都命中同一个永不 settle 的 promise，
 * learn/[id]/page.tsx:32 的 `void ensureCheck(url).then(...)` 徽章永远不出现且不重试。
 *
 * 锁四件事：
 *  1) fetch 挂起且不认 signal → ensureCheck 仍在预算内 settle 为 null，槽位释放后能重试；
 *  2) 旧请求迟到 → 不得删掉重试写入的新 inflight 条目（并发去重不被破坏）；
 *  3) 正常成功路径 → 返回体检结果并写缓存，第二次调用不再发请求；
 *  4) fetch 确实带上 AbortSignal.timeout(12_000)。 */

vi.mock("@/lib/ai/client", () => ({
  streamChat: vi.fn(),
  extractJson: (t: string) => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  },
}));

import { ensureCheck } from "../resource-pipeline";

const BUDGET = 12_000;

const check = (url: string) => ({ url, ok: true, dead: false, ad: false, reason: "可访问" });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ensureCheck：客户端体检预算与 inflight 释放", () => {
  it("fetch 永不 settle 且忽略 signal → 预算内返回 null，且后续调用会重新体检（槽位不永久驻留）", async () => {
    const url = "https://example.com/ensurecheck-hang";
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const p1 = ensureCheck(url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BUDGET);
    expect(await p1).toBeNull(); // 不会永远 pending

    // 槽位已释放：同一 URL 再问一次必须重新发请求，而不是拿到旧 promise
    const p2 = ensureCheck(url);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(BUDGET);
    expect(await p2).toBeNull();
  });

  it("旧请求超时后迟到 settle → 不得删掉重试写入的新 inflight 条目", async () => {
    const url = "https://example.com/ensurecheck-late";
    let resolveFirst!: (r: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((res) => (resolveFirst = res)))
      .mockImplementationOnce(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const p1 = ensureCheck(url);
    await vi.advanceTimersByTimeAsync(BUDGET);
    expect(await p1).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 超时后重试：新 promise 占住 inflight
    const p2 = ensureCheck(url);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 旧请求迟到返回空结果（不写缓存，避免干扰去重断言）
    resolveFirst(Response.json({ results: [] }));
    await vi.advanceTimersByTimeAsync(0);

    const p3 = ensureCheck(url);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 复用新请求，没有第三次
    expect(p3).toBe(p2);
    await vi.advanceTimersByTimeAsync(BUDGET);
    expect(await p3).toBeNull();
  });

  it("正常成功路径不受预算影响：返回体检结果、写缓存，第二次调用不再发请求", async () => {
    const url = "https://example.com/ensurecheck-ok";
    const fetchMock = vi.fn(async () => Response.json({ results: [check(url)] }));
    vi.stubGlobal("fetch", fetchMock);

    const c = await ensureCheck(url);
    expect(c?.ok).toBe(true);
    expect(c?.dead).toBe(false);

    const c2 = await ensureCheck(url);
    expect(c2?.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 缓存命中
  });

  it("fetch 带上 AbortSignal.timeout(12_000)：预算覆盖响应与 body 读取", async () => {
    const url = "https://example.com/ensurecheck-signal";
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    let seenSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return Response.json({ results: [check(url)] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await ensureCheck(url);

    expect(timeoutSpy).toHaveBeenCalledWith(BUDGET);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });
});
