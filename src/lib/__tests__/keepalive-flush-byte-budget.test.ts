import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ============ keepalive flush 体积闸按 UTF-8 字节计的回归锁 ============
 * 缺陷：pushOnce 用 text.length（UTF-16 码元数）判断 keepalive 的 60_000 门槛，
 * 而浏览器对 keepalive 请求体硬限 64KiB 是按字节计的。纯中文每字 UTF-8 占 3 字节，
 * ~2.2 万汉字（活跃会话/笔记 JSON 常见体量）就撞 65536 字节上限，但 text.length 只有
 * 2.2 万 < 60_000 被放行 → keepalive fetch 当场被浏览器 reject（retries=keepalive?0:2
 * 无重试）→ setSyncStatus("error") 误报同步失败，且 flush 保护目标静默失效。
 *
 * 本锁真实 import auth-client.ts（沿用 auth-submit-timeout.test.ts 的 @/lib/store mock
 * + stubGlobal 做法），钉住三件事：
 *  A) 中文大体量（UTF-16 码元 < 60_000 但 UTF-8 字节 > 60_000）的 keepalive flush
 *     必须被跳过：不发 fetch、返回 false、同步态绝不落成 error（浏览器拒发
 *     由 fetchMock 抛 TypeError 模拟，旧实现会因此走到 setSyncStatus("error")）；
 *  B) 正常小载荷 keepalive 仍放行且带 keepalive:true（保护目标不退化）；
 *  C) 该门槛只作用于 keepalive，常规 2.5s 防抖推送（keepalive:false）不受影响；
 *     大 ASCII 体量（字节与码元都超 60_000）依旧被闸住（不回退既有防护）。
 *
 * 另附源码护栏：门槛表达式不得改回按 text.length 判断。 */

/* auth-client 顶层只用到 useAppStore 与 setStoreUser 的引用；state 用 hoisted 容器
 * 以便每个用例注入不同体量的本地数据（localData() 在 pushOnce 里读 getState()）。 */
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

/* 构造最小 state：localData() 只序列化这七个字段，knowledge 里塞可控长度的内容。 */
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

/* 25_000 个汉字：UTF-16 码元 25_000，UTF-8 字节 75_000。外加 localData 的固定键名
 * 包装（约百余字节）后仍稳稳落在 [text.length < 60_000 < UTF-8 字节] 的错位区间——
 * 正是旧 text.length 门槛会漏判、被浏览器按字节拒发的那一档。 */
const CHINESE_NOTE = "中".repeat(25_000);

beforeEach(() => {
  fetchMock.mockReset();
  lsStore.clear();
  useSyncStatus.setState({ status: "idle" });
  setStateWithNote("");
});

describe("错位区间的量级证据（UTF-16 码元 vs UTF-8 字节）", () => {
  it("25_000 汉字：码元 25_000 < 60_000，字节 75_000 > 60_000", () => {
    expect(CHINESE_NOTE.length).toBe(25_000);
    expect(new Blob([CHINESE_NOTE]).size).toBe(75_000);
    expect(new TextEncoder().encode(CHINESE_NOTE).length).toBe(75_000);
    expect(CHINESE_NOTE.length).toBeLessThan(60_000);
    expect(new Blob([CHINESE_NOTE]).size).toBeGreaterThan(60_000);
  });
});

describe("keepalive flush 按字节跳过（行为锁）", () => {
  it("中文大体量 keepalive：跳过、不发 fetch、返回 false、同步态不落 error", async () => {
    setStateWithNote(CHINESE_NOTE);
    /* 模拟浏览器对超 64KiB 的 keepalive 请求体当场 reject（Node fetch 不强制该闸）。
     * 旧实现（text.length 放行）会走到这里 → retries=0 无重试 → setSyncStatus("error")。 */
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const ok = await pushCloud({ keepalive: true });

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); // 白发一次都不允许
    expect(useSyncStatus.getState().status).not.toBe("error"); // 根因：误报同步失败
  });

  it("正常小载荷 keepalive：仍放行、带 keepalive:true、结果 saved", async () => {
    setStateWithNote("a".repeat(200));
    fetchMock.mockResolvedValue(okResponse());

    const ok = await pushCloud({ keepalive: true });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.keepalive).toBe(true);
    expect(useSyncStatus.getState().status).toBe("saved");
  });

  it("门槛只作用于 keepalive：同一中文大体量常规推送（keepalive:false）照发", async () => {
    setStateWithNote(CHINESE_NOTE);
    fetchMock.mockResolvedValue(okResponse());

    const ok = await pushCloud();

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("大 ASCII 体量（码元与字节均 > 60_000）keepalive 依旧被闸住", async () => {
    setStateWithNote("a".repeat(60_500));
    fetchMock.mockResolvedValue(okResponse());

    const ok = await pushCloud({ keepalive: true });

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("源码护栏：门槛表达式按字节而非码元", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/auth-client.ts"), "utf8");

  it("keepalive 体积闸使用 new Blob([text]).size（UTF-8 字节），禁回 text.length", () => {
    const guard = src.split("\n").find((l) => l.includes("if (keepalive &&") && l.includes("return false;")) ?? "";
    expect(guard).toContain("new Blob([text]).size");
    expect(guard).not.toContain("text.length");
  });
});
