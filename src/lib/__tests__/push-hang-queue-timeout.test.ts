import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ============ 推送挂起不得永久占住串行队列的回归锁 ============
 * 缺陷：pushOnce 的三个 doFetch 变体（keepalive 直传 / gzip / 常规 JSON）都是无 signal 的
 * 裸 fetch。pushCloud 经 withPushLock 串行化，pushChain 在 fn() settle 前不 release——
 * 一次 TCP 半开/弱网停滞的请求永不 settle，release 就永不执行，后续所有 pushCloud
 * （2.5s 防抖自动推 + pagehide/visibilitychange 的 keepalive flush）永久排队：
 * 关页前的最新编辑发不出去（丢数据窗口），同步态永远停在 saving，重试也卡在第一次。
 *
 * 修复：每次尝试带 AbortSignal.timeout（常规 60s，与服务端 POST /api/sync 的
 * maxDuration 同量级；keepalive flush 10s），并给一次 pushOnce 加总预算（75s），
 * 让队列等待时间有确定上界。
 *
 * 本锁真实 import auth-client.ts（沿用 keepalive-flush-byte-budget.test.ts 的
 * @/lib/store mock + stubGlobal 做法），钉住：
 *  A) 行为锁：第一个推送挂起（fetch 只在 signal abort 时拒绝，模拟真实浏览器）时，
 *     排在它后面的 keepalive flush 仍能在有限时间内执行并成功——队列不会永久堵死；
 *  B) 超时值：常规尝试的 signal 上限落在 60s 量级、keepalive 落在 10s 量级；
 *  C) 源码护栏：pushOnce 里每个 fetch 调用都必须包在 attemptInit(...) 里（带 signal），
 *     防手改漂移回裸 fetch；
 *  D) 正常快响应不被新 signal 误伤（不额外发请求、状态 saved）。 */

const h = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("@/lib/store", () => ({
  useAppStore: {
    getState: () => h.state,
    setState: () => {},
    subscribe: () => () => {},
  },
  setStoreUser: vi.fn(),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const lsStore = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => void lsStore.set(k, v),
  removeItem: (k: string) => void lsStore.delete(k),
});

import { pushCloud, useSyncStatus } from "@/lib/auth-client";

function setStateWithNote(note: string) {
  h.state = {
    goals: [],
    knowledge: [{ note }],
    books: [],
    sessions: [],
    customPersonas: [],
    agentSessions: [],
    settings: {},
    _storeUserId: null,
    importData: () => true,
    subscribe: () => () => {},
  };
}

function okResponse() {
  return new Response(JSON.stringify({ ok: true, updatedAt: "2026-11-09T00:00:00.000Z" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/* 真实浏览器里挂起的 fetch 表现：请求永不完成，仅在 signal abort 时以 TimeoutError 拒绝。
 * 旧实现没有 signal → 这个 Promise 永不 settle → 串行队列永久堵死（正是本锁要拦的回归）。 */
function hangUntilAbort(_url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const fail = () => reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    if (init?.signal?.aborted) return fail();
    init?.signal?.addEventListener("abort", fail);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  fetchMock.mockReset();
  lsStore.clear();
  useSyncStatus.setState({ status: "idle" });
  setStateWithNote("");
});

describe("推送挂起不永久占住串行队列（行为锁）", () => {
  it("首个推送挂起 → 排在后面的 keepalive flush 仍执行并成功，队列不被堵死", async () => {
    /* AbortSignal.timeout 是 Node 原生实现，假定时器推不动：捕获原生实现再包一层，
     * 上限缩到 120ms 实测「signal 真触发」，生产常量另由 C 组断言。 */
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms?: number) => nativeTimeout(Math.min(ms ?? 0, 120)));
    let hang = true;
    fetchMock.mockImplementation((url: RequestInfo | URL, init?: RequestInit) =>
      hang ? hangUntilAbort(url, init) : Promise.resolve(okResponse())
    );

    try {
      setStateWithNote("本地最新编辑");
      const t0 = Date.now();
      /* retries:0 —— 单个挂起尝试即可复现「release 永不执行」，不必等重试退避 */
      const first = pushCloud({ retries: 0 });
      await sleep(20); // 让首个 fetch 真正进入挂起态
      expect(fetchMock).toHaveBeenCalledTimes(1);
      hang = false; // 之后的请求正常返回（模拟网络恢复）
      const flush = pushCloud({ keepalive: true });

      const [firstOk, flushOk] = await Promise.all([first, flush]);
      const elapsed = Date.now() - t0;

      expect(firstOk).toBe(false); // 挂起请求被超时终结，判失败
      expect(flushOk).toBe(true); // 队列解锁后，关页 flush 真的发出去了
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(elapsed).toBeLessThan(5_000); // 有界，不是永久挂起
      expect(useSyncStatus.getState().status).toBe("saved"); // 最后一次成功即 saved
    } finally {
      timeoutSpy.mockRestore();
    }
  }, 15_000);

  it("keepalive 推送自身挂起也会在短超时内收尾，不把后续自动推送压住", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms?: number) => nativeTimeout(Math.min(ms ?? 0, 120)));
    let hang = true;
    fetchMock.mockImplementation((url: RequestInfo | URL, init?: RequestInit) =>
      hang ? hangUntilAbort(url, init) : Promise.resolve(okResponse())
    );

    try {
      const t0 = Date.now();
      const flush = pushCloud({ keepalive: true }); // retries 默认 0
      await sleep(20);
      hang = false;
      const auto = pushCloud(); // 2.5s 防抖自动推，排在 flush 之后
      const [flushOk, autoOk] = await Promise.all([flush, auto]);

      expect(flushOk).toBe(false);
      expect(autoOk).toBe(true);
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  }, 15_000);
});

describe("超时值的量级（与同文件既有先例一致）", () => {
  it("常规推送尝试的 signal 上限为 60s 量级，keepalive flush 为 10s 量级", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms?: number) => nativeTimeout(Math.min(ms ?? 0, 120)));
    fetchMock.mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
      /* 立刻按 signal 拒绝，只为采集 timeout 的入参 */
      const sig = init?.signal;
      return new Promise<Response>((_r, reject) => {
        if (sig?.aborted) return reject(new DOMException("aborted", "TimeoutError"));
        sig?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
      });
    });

    try {
      await pushCloud({ retries: 0 });
      const regularArg = timeoutSpy.mock.calls.at(-1)?.[0] ?? 0;
      expect(regularArg).toBeGreaterThan(55_000); // 60s 量级，且不超过服务端 60s 太多
      expect(regularArg).toBeLessThanOrEqual(60_000);

      await pushCloud({ keepalive: true });
      const keepaliveArg = timeoutSpy.mock.calls.at(-1)?.[0] ?? 0;
      expect(keepaliveArg).toBeGreaterThan(5_000);
      expect(keepaliveArg).toBeLessThanOrEqual(10_000); // 关页兜底不该占住队列 60s
    } finally {
      timeoutSpy.mockRestore();
    }
  }, 15_000);
});

describe("正常快响应不被新 signal 误伤", () => {
  it("一次成功推送只发一次请求、状态 saved、仍写同步水位", async () => {
    fetchMock.mockResolvedValue(okResponse());
    setStateWithNote("a".repeat(200));

    const ok = await pushCloud();

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(useSyncStatus.getState().status).toBe("saved");
    expect(lsStore.get("mentora-sync-choice")).toBe("2026-11-09T00:00:00.000Z");
  });
});

describe("源码护栏：pushOnce 的每个 fetch 都带超时信号", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/auth-client.ts"), "utf8");
  const start = src.indexOf("async function pushOnce");
  const body = src.slice(start, src.indexOf("/** 关页/切后台前"));

  it("attemptInit 注入 AbortSignal.timeout，且 pushOnce 内不存在裸 fetch", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(/signal:\s*AbortSignal\.timeout\(/);

    /* 抽出 pushOnce 里每个 fetch( 调用点，其后 200 字符内必须出现 attemptInit( */
    const sites: string[] = [];
    const re = /fetch\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) sites.push(body.slice(m.index, m.index + 200));
    expect(sites.length).toBe(3); // keepalive 直传 / gzip / 常规 JSON 三变体都在
    for (const site of sites) expect(site).toContain("attemptInit(");
  });
});
