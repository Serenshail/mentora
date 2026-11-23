import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* 回归锁（2026-11-10）：内部 20s 总预算与调用方取消必须分开处理。
 * - 内部超时 = "别卡住回答" → 降级返回基线检索结果，绝不抛；
 * - 调用方 abort = "这轮作废" → 必须原样抛出，让调用方跳过落库/发送。
 * 旧实现把两者合流到同一个 signal，超时也会走 `if (signal.aborted) throw e`，
 * 导致 learn/[id] 的答疑在慢网下丢失早已算好的笔记上下文。 */

const streamChat = vi.fn();

vi.mock("@/lib/ai/client", () => ({
  streamChat: (...args: unknown[]) => streamChat(...args),
  extractJson: (text: string) => JSON.parse(text),
}));

import { retrieveEnhanced } from "../rag-pipeline";

type StreamOpts = { signal?: AbortSignal };

/** 永不返回的模型调用：只在 signal abort 时以 AbortError 拒绝（模拟弱网挂起） */
function hangingCall() {
  return (_opts: StreamOpts) =>
    new Promise<string>((_resolve, reject) => {
      const signal = _opts.signal;
      const fail = () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (signal?.aborted) return fail();
      signal?.addEventListener("abort", fail, { once: true });
    });
}

const notes = [
  {
    id: "n1",
    title: "React 闭包与状态快照",
    body: "闭包捕获的是渲染时的变量，不是最新值。解决办法用函数式更新或 ref。",
    tags: ["React"],
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    id: "n2",
    title: "JavaScript 闭包原理",
    body: "闭包是函数与其词法作用域的组合，可以让内部函数访问外部变量。",
  },
  {
    id: "n3",
    title: "闭包与定时器",
    body: "定时器里读到旧值，是因为回调闭包捕获了创建时的渲染快照。",
  },
  {
    id: "n4",
    title: "函数式更新",
    body: "setState 传函数可以拿到最新状态，避免闭包快照过期。",
  },
];

describe("retrieveEnhanced 取消来源区分", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    streamChat.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("内部 20s 超时降级为基线检索（不抛、上下文不丢）", async () => {
    streamChat.mockImplementation(hangingCall());

    const p = retrieveEnhanced("闭包 状态快照", notes, 3, { context: "React" });
    await vi.advanceTimersByTimeAsync(20_000);
    const r = await p;

    expect(streamChat).toHaveBeenCalledTimes(1); // 只试了改写
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.context).not.toBe("");
    expect(r.trace.degraded).toContain("超时");
    expect(r.trace.usedRerank).toBe(false);
  });

  it("改写成功但精排超时：保留融合结果，不抛", async () => {
    streamChat.mockImplementationOnce(async () =>
      JSON.stringify({ queries: ["闭包 词法作用域", "状态快照 ref"] })
    );
    streamChat.mockImplementation(hangingCall());

    const p = retrieveEnhanced("闭包 状态快照", notes, 3, { context: "React" });
    await vi.advanceTimersByTimeAsync(20_000);
    const r = await p;

    expect(streamChat).toHaveBeenCalledTimes(2); // 改写 + 精排
    expect(r.hits.length).toBe(3);
    expect(r.context).not.toBe("");
    expect(r.trace.usedRerank).toBe(false);
    expect(r.trace.degraded).toContain("精排超时");
  });

  it("调用方主动取消仍然抛出（这轮作废，不得降级继续）", async () => {
    streamChat.mockImplementation(hangingCall());
    const ac = new AbortController();

    const p = retrieveEnhanced("闭包 状态快照", notes, 3, { signal: ac.signal });
    const assertion = expect(p).rejects.toThrow();
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });

  it("进门前已取消：不会把作废请求当成功返回", async () => {
    streamChat.mockImplementation(hangingCall());
    const ac = new AbortController();
    ac.abort();

    const p = retrieveEnhanced("闭包 状态快照", notes, 3, { signal: ac.signal });
    const assertion = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });
});
