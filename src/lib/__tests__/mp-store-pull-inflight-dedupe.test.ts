import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 store：pullIfSafe 必须做在途去重 ============
 * 旧实现只在成功回调里更新 lastPullAt，检查却发生在请求发出前：首次全量拉取
 * （MB 级、弱网下数秒）完成前，每次 tab onShow 都能穿过 30s 节流检查，各自发起
 * 一次全量快照请求——没有 in-flight 去重。影响是重复带宽/流量与服务端读放大。
 * 修复：pullInFlight 记录在途请求（带会话代数），同会话的在途拉取直接复用。
 * 本锁同时钉住：换账号后不能被上一账号的在途拉取顶替（否则新账号永远拿不到数据）。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();
const STORE_PATH = join(ROOT, "miniprogram/utils/store.js");
const API_PATH = join(ROOT, "miniprogram/utils/api.js");

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let storage: Map<string, unknown>;
let pulls: Deferred<any>[];
let store: any;

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
  pulls = [];
  api.pushCloud = () => Promise.resolve({ updatedAt: "2026-01-01T00:00:00.000Z" });
  api.pullCloud = () => {
    const d = deferred<any>();
    pulls.push(d);
    return d.promise;
  };
  return mod;
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(() => {
  installWxStub();
  store = loadStore();
});

describe("mp-store pullIfSafe 在途去重", () => {
  it("首次拉取未完成时连续多次 onShow：只发一次全量请求，共用同一结果", async () => {
    const first = store.onLogin("u1");
    await flush();
    expect(pulls).toHaveLength(1); // onLogin 的 force 拉取已发出

    // 首拉仍在途：模拟两次 tab onShow 的 pullIfSafe(false)
    const second = store.pullIfSafe(false);
    const third = store.pullIfSafe(true);
    await flush();
    expect(pulls).toHaveLength(1); // 没有并发重拉

    pulls[0].resolve({
      data: { goals: [{ id: "cloud-goal" }], knowledge: [], books: [], sessions: [], customPersonas: [] },
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    await flush();

    await expect(first).resolves.toBe("pulled");
    await expect(second).resolves.toBe("pulled");
    await expect(third).resolves.toBe("pulled");
    expect(store.state.goals.map((g: any) => g.id)).toEqual(["cloud-goal"]);
    expect(pulls).toHaveLength(1);
  });

  it("首拉完成后 30s 内的非 force 调用照常 skip（节流语义不变）", async () => {
    const first = store.onLogin("u1");
    await flush();
    pulls[0].resolve({ data: null, updatedAt: "" });
    await first;
    await flush();

    await expect(store.pullIfSafe(false)).resolves.toBe("skip");
    expect(pulls).toHaveLength(1);
  });
});
