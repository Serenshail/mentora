import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 store：换账号登录不得沿用上一账号的内存数据 ============
 * 事故链（utils/store.js onLogin）：
 *   onLogin 只做 `state.userId = userId; loadLocal();`。loadLocal() 在新账号本机
 *   没有缓存时返回 false 且**不覆写 state**，上一账号的 goals/knowledge/books/
 *   sessions 就原样留在内存里。随后 pullIfSafe(true) 看到 hasLocalData() 为真、
 *   新账号云端为空，走 pushNow —— 把上一账号的整份快照推上新账号的云端。
 *   这条路径真实存在：会话失效时 app.js 只 clearSession + reLaunch 登录页，
 *   不经过 onLogout/resetState，所以换账号不保证 state 被清过。
 * 修法：onLogin 在身份真的变化时先清空内存态（再 loadLocal 读本账号缓存）。
 *
 * 同时锁住会话围栏：上一账号的在途拉取响应（epoch 已变）必须整份丢弃。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();
const STORE_PATH = join(ROOT, "miniprogram/utils/store.js");
const API_PATH = join(ROOT, "miniprogram/utils/api.js");

let storage: Map<string, unknown>;
let pushes: { payload: any }[];
let cloudToReturn: any;
let pullDeferred: { promise: Promise<any>; resolve: (v: any) => void } | null;
let store: any;

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function installWxStub() {
  storage = new Map();
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: (k: string) => (storage.has(k) ? storage.get(k) : ""),
    setStorageSync: (k: string, v: unknown) => void storage.set(k, v),
    removeStorageSync: (k: string) => void storage.delete(k),
    showToast: () => {},
  };
}

function loadStore() {
  for (const p of [STORE_PATH, API_PATH]) delete requireCjs.cache[p];
  const mod = requireCjs(STORE_PATH);
  const api = requireCjs(API_PATH);
  pushes = [];
  pullDeferred = null;
  api.pushCloud = (payload: any) => {
    pushes.push({ payload });
    return Promise.resolve({ updatedAt: "2026-01-01T00:00:00.000Z" });
  };
  api.pullCloud = () => {
    if (pullDeferred) return pullDeferred.promise;
    return Promise.resolve(cloudToReturn);
  };
  return mod;
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(() => {
  installWxStub();
  store = loadStore();
  cloudToReturn = null;
});

describe("mp-store 换账号：内存态与在途响应都不得跨账号", () => {
  it("A 的数据在内存里时登录 B（B 无本机缓存、云端为空）：B 看不到 A 的数据，也不会推 A 的快照", async () => {
    // 账号 A 已登录并有数据
    cloudToReturn = { data: { goals: [], knowledge: [], books: [], sessions: [], customPersonas: [] }, updatedAt: "" };
    await store.onLogin("A");
    await flush();
    store.state.goals = [{ id: "a-goal", topic: "A 的目标" }];
    store.state.knowledge = [{ id: "a-k", title: "A 的笔记" }];

    // 未经过 onLogout 直接换账号（会话失效 → 登录页 → 登录 B）
    cloudToReturn = { data: { goals: [], knowledge: [], books: [], sessions: [], customPersonas: [] }, updatedAt: "2026-01-02T00:00:00.000Z" };
    await store.onLogin("B");
    await flush();

    // B 的 state 不能带 A 的任何数据
    expect(store.state.userId).toBe("B");
    expect(store.state.goals).toEqual([]);
    expect(store.state.knowledge).toEqual([]);
    // 也不该把 A 的快照反推上 B 的云端
    expect(pushes.some((p) => (p.payload.goals || []).some((g: any) => g.id === "a-goal"))).toBe(false);
  });

  it("B 自己本机有缓存：读 B 的缓存，仍不掺 A 的数据", async () => {
    await store.onLogin("A");
    await flush();
    store.state.goals = [{ id: "a-goal" }];

    // B 的本机缓存（cacheKey 按 userId 分键）
    storage.set(
      "mentora-mp-store-B",
      JSON.stringify({ goals: [{ id: "b-goal" }], knowledge: [], books: [], sessions: [], customPersonas: [], settings: {} })
    );
    cloudToReturn = { data: { goals: [{ id: "b-cloud" }], knowledge: [], books: [], sessions: [], customPersonas: [] }, updatedAt: "2026-01-05T00:00:00.000Z" };
    await store.onLogin("B");
    await flush();

    const ids = store.state.goals.map((g: any) => g.id);
    expect(ids).not.toContain("a-goal");
    expect(ids).toContain("b-cloud"); // 云端为准
  });

  it("同一账号重复 onLogin（冷启动 app.js 与页面 probe 各调一次）：不清掉已加载的数据", async () => {
    cloudToReturn = { data: { goals: [{ id: "g1" }], knowledge: [], books: [], sessions: [], customPersonas: [] }, updatedAt: "2026-01-01T00:00:00.000Z" };
    await store.onLogin("A");
    await flush();
    const before = store.state.goals.map((g: any) => g.id);

    await store.onLogin("A");
    await flush();
    expect(store.state.goals.map((g: any) => g.id)).toEqual(before);
  });

  it("A 的在途拉取在换账号 B 后才返回：整份丢弃，不写进 B 的 state/本机缓存", async () => {
    // A 登录：拉取挂起（模拟 pullCloud 60s 超时窗口内的慢响应）
    const aPull = deferred<any>();
    pullDeferred = aPull;
    const aLogin = store.onLogin("A");
    await flush();
    expect(store.state.userId).toBe("A");

    // 期间换账号 B（B 本机无缓存、云端为空）——A 的拉取仍在途
    pullDeferred = null;
    cloudToReturn = {
      data: { goals: [], knowledge: [], books: [], sessions: [], customPersonas: [] },
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    await store.onLogin("B");
    await flush();

    // A 的迟到响应现在才回来，带着 A 的整份快照
    aPull.resolve({
      data: { goals: [{ id: "a-goal" }], knowledge: [], books: [], sessions: [], customPersonas: [] },
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    await aLogin;
    await flush();

    // 围栏必须按会话代数丢弃：B 的 state 与云端都不能沾到 A 的数据
    expect(store.state.userId).toBe("B");
    expect(store.state.goals.map((g: any) => g.id)).not.toContain("a-goal");
    expect(pushes.some((p) => (p.payload.goals || []).some((g: any) => g.id === "a-goal"))).toBe(false);
    // 也不该把 A 的快照写进 B 的本机缓存键
    const bCache = storage.get("mentora-mp-store-B");
    expect(String(bCache || "")).not.toContain("a-goal");
  });
});
