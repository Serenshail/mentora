import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 store：删光数据时脏守卫不得失效（回归锁） ============
 * 事故链（miniprogram/utils/store.js pullIfSafe 修复前）：「本地有未推送改动
 * 绝不覆盖」守卫以 hasLocalData() 为前提，而它只累计
 * goals/knowledge/books/sessions/customPersonas 五项。只用圆桌、无其他数据的
 * 用户删掉最后一条会话后：dirtyPending=true 但 hasLocalData()=false → 守卫整体
 * 跳过 → 云端仍有该会话且水位未变 → 走到 adoptCloud——删除意图被静默回滚且
 * 脏标记被清，操作不可恢复。
 * 修复：守卫前提扩展为 (hasLocalData() || localLoaded)。localLoaded 在本机缓存
 * JSON 解析成功时为真——内存态可信，「删光」是真实改动，照常走 pushNow 把
 * 删除同步上云。缓存缺失/损坏（localLoaded=false）时内存空可能是假的，保持
 * 原样跳过守卫走 adoptCloud，绝不自动整包推空快盖云端。 */

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
    return Promise.resolve({ updatedAt: "2026-04-01T00:00:00.000Z" });
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

const snapshot = (sessions: unknown[]) =>
  JSON.stringify({ goals: [], knowledge: [], books: [], sessions, customPersonas: [], settings: {} });

const cloudWith = (sessions: unknown[], updatedAt: string) => ({
  data: { goals: [], knowledge: [], books: [], sessions, customPersonas: [] },
  updatedAt,
});

beforeEach(async () => {
  vi.useFakeTimers();
  installWxStub();
  store = loadStore();
  // 基线：本机与云端都只有一条会话 s1（adopt 后水位 2026-01-01）
  storage.set(CACHE_KEY, snapshot([{ id: "s1" }]));
  cloudToReturn = cloudWith([{ id: "s1" }], "2026-01-01T00:00:00.000Z");
  await store.onLogin("u1");
  await flush();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("mp-store 删光数据的脏守卫", () => {
  it("删掉最后一条会话后、防抖推送落地前拉取：走 pushNow 同步删除，不被 adoptCloud 回滚", async () => {
    store.removeSession("s1");
    expect(storage.get(DIRTY_KEY)).toBe(true);
    expect(store.state.sessions).toEqual([]);

    // 删除后 2.5s 防抖尚未落地（不 advance），此时切 tab 触发 force-pull
    cloudToReturn = cloudWith([{ id: "s1" }], "2026-01-01T00:00:00.000Z"); // 云端仍留着 s1
    const r = await store.pullIfSafe(true);
    await flush();

    expect(r).toBe("pushed");
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    // 推上去的载荷里会话已被删空：删除意图同步到云端
    expect(pushes[0].payload.sessions).toEqual([]);
    // 本地不被云端旧快照回滚
    expect(store.state.sessions).toEqual([]);
    // 落地后脏标记清掉
    expect(storage.get(DIRTY_KEY)).toBeUndefined();
  });

  it("缓存缺失 + 遗留脏标记（内存态不可信）：仍走 adoptCloud，不自动推空快照盖云端", async () => {
    // 新进程：只有跨进程的脏标记，本机缓存不存在
    vi.clearAllTimers();
    storage.clear();
    storage.set(DIRTY_KEY, true);
    store = loadStore();
    cloudToReturn = cloudWith([{ id: "cloud-s" }], "2026-02-01T00:00:00.000Z");

    const r = await store.onLogin("u1");
    await flush();

    // 云端有数据 → adoptCloud 收口；绝不把空内存态整包推上去
    expect(r).toBe("pulled");
    expect(pushes).toHaveLength(0);
    expect(store.state.sessions.map((s: any) => s.id)).toEqual(["cloud-s"]);
  });
});
