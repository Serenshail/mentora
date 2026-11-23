import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 store：分叉未决时自动推送必须被拦住（回归锁） ============
 * 事故链（miniprogram/utils/store.js 修复前）：pullIfSafe 的分叉守卫只拦
 * 「拉取触发的推送」。用户没看到/没读完一次性 toast 提示继续编辑时，
 * markDirty → pushDebounced(2.5s) → pushNow 把本地整包推上去，静默替换他端
 * 新快照——notifyConflict 的 448 行注释自述的正是这个后果；flushPush（切后台）
 * 同样绕过守卫。且分叉态 syncStatus 停在 idle，同步徽章无任何持久指示。
 * 修复：notifyConflict 置 conflictFork（撤掉挂起的防抖）+ emitStatus("conflict")
 * 持久徽章；markDirty/flushPush 在 conflictFork 期间不自动推；用户在
 * 「我的 → 数据」手动「推送到云端」（pushNow 直呼）或「从云端恢复」
 * （adoptCloud）收口后自动推送恢复常态。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();
const STORE_PATH = join(ROOT, "miniprogram/utils/store.js");
const API_PATH = join(ROOT, "miniprogram/utils/api.js");

let storage: Map<string, unknown>;
let statuses: string[];
let pushes: { payload: any }[];
let cloudToReturn: any;
let store: any;

function installWxStub() {
  storage = new Map();
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: (k: string) => (storage.has(k) ? storage.get(k) : ""),
    setStorageSync: (k: string, v: unknown) => void storage.set(k, v),
    removeStorageSync: (k: string) => void storage.delete(k),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    showToast: () => {},
  };
}

function loadStore() {
  for (const p of [STORE_PATH, API_PATH]) delete requireCjs.cache[p];
  const mod = requireCjs(STORE_PATH);
  const api = requireCjs(API_PATH);
  pushes = [];
  cloudToReturn = null;
  api.pushCloud = (payload: any) => {
    pushes.push({ payload });
    return Promise.resolve({ updatedAt: "2026-05-01T00:00:00.000Z" });
  };
  api.pullCloud = () => Promise.resolve(cloudToReturn);
  statuses = [];
  mod.onSyncStatus((s: string) => statuses.push(s));
  return mod;
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const CACHE_KEY = "mentora-mp-store-u1";
const DIRTY_KEY = "mentora-mp-dirty-u1";
const BASE_KEY = "mentora-mp-dirty-base-u1";

const localSnapshot = () =>
  JSON.stringify({
    goals: [{ id: "local-goal", topic: "本机离线编辑" }],
    knowledge: [],
    books: [],
    sessions: [],
    customPersonas: [],
    settings: {},
  });

const cloudSnapshot = (updatedAt: string) => ({
  data: {
    goals: [{ id: "web-goal", topic: "Web 端新工作" }],
    knowledge: [],
    books: [],
    sessions: [],
    customPersonas: [],
  },
  updatedAt,
});

beforeEach(() => {
  vi.useFakeTimers();
  installWxStub();
  store = loadStore();
  // 分叉现场：本机改动基于 2026-01-01，云端在 2026-02-01 被他端推过新快照
  storage.set(CACHE_KEY, localSnapshot());
  storage.set(DIRTY_KEY, true);
  storage.set(BASE_KEY, "2026-01-01T00:00:00.000Z");
  cloudToReturn = cloudSnapshot("2026-02-01T00:00:00.000Z");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("mp-store 分叉未决的自动推送闸门", () => {
  it("分叉检出后继续编辑：防抖到点不推，徽章转持久 conflict 态", async () => {
    const r = await store.onLogin("u1");
    await flush();
    expect(r).toBe("conflict");
    expect(pushes).toHaveLength(0);
    expect(statuses).toContain("conflict");

    // 用户没看到提示继续编辑：2.5s 防抖到点也不自动推
    store.markDirtyPublic();
    await vi.advanceTimersByTimeAsync(2500);
    expect(pushes).toHaveLength(0);
    expect(storage.get(DIRTY_KEY)).toBe(true);

    // 切后台 flushPush 同样不推
    store.flushPush();
    await flush();
    expect(pushes).toHaveLength(0);
  });

  it("手动「推送到云端」照常执行，落地后自动推送恢复常态", async () => {
    await store.onLogin("u1");
    await flush();
    store.markDirtyPublic();
    await vi.advanceTimersByTimeAsync(2500);
    expect(pushes).toHaveLength(0);

    const ok = await store.pushNow();
    await flush();
    expect(ok).toBe(true);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].payload.goals.map((g: any) => g.id)).toEqual(["local-goal"]);
    expect(storage.get(DIRTY_KEY)).toBeUndefined();

    // 收口后的下一次编辑：照常自动推
    store.markDirtyPublic();
    await vi.advanceTimersByTimeAsync(2500);
    expect(pushes).toHaveLength(2);
  });

  it("「从云端恢复」收口分叉：adoptCloud 清闸门，后续编辑照常自动推", async () => {
    await store.onLogin("u1");
    await flush();

    // 用户显式选择云端版
    const r = await store.pullIfSafe(true, { restore: true });
    await flush();
    expect(r).toBe("pulled");
    expect(store.state.goals.map((g: any) => g.id)).toEqual(["web-goal"]);

    store.markDirtyPublic();
    await vi.advanceTimersByTimeAsync(2500);
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    expect(pushes[0].payload.goals.map((g: any) => g.id)).toEqual(["web-goal"]);
  });
});
