import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 store：「从云端恢复」× 在途推送竞态 + 水位相等短路（回归锁） ============
 * 事故链（miniprogram/utils/store.js adoptCloud 修复前）：adoptCloud 对已在途的
 * pushNow 没有任何围栏（只取消防抖，不 bump editSeq）。
 *   T0 markDirty → 2.5s 防抖推送#1 发起（serialize() 取恢复前的本地快照 S1）
 *   T1 用户在「我的→数据」点「从云端恢复」→ pullIfSafe(restore) adoptCloud(C1)
 *   T2 推送#1 落地：sameSession 且 editSeq 仍等于 pushedSeq（adoptCloud 没动它）
 *      → 成功路径照常推进 lastCloudAt 并清脏 → 云端被 S1 覆盖；
 *      下次拉取 cloud.updatedAt === lastCloudAt，水位守卫放行 adoptCloud(S1)，
 *      用户显式的恢复被静默撤销。
 * 修复：adoptCloud 自增 editSeq——在途推送落地时发现代数已前进，走既有的
 * 「保留脏标记 + 立即补推」路径把恢复版重新推上云，两端收敛到恢复版。
 * 水位相等短路（修复二）：cloud.updatedAt === lastCloudAt 且本机缓存读取成功时
 * 直接 "none"，不再整份 adoptCloud（30s 热路径上重复 MB 级 stringify + 全量
 * state 替换）；localLoadFailed 时不短路（adoptCloud 是坏缓存自愈的唯一通道）。 */

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
let statuses: string[];
let pushes: { payload: any; d: Deferred<any> }[];
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
    const d = deferred<any>();
    pushes.push({ payload, d });
    return d.promise;
  };
  api.pullCloud = () => Promise.resolve(cloudToReturn);
  statuses = [];
  mod.onSyncStatus((s: string) => statuses.push(s));
  return mod;
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const DIRTY_KEY = "mentora-mp-dirty-u1";

beforeEach(async () => {
  vi.useFakeTimers();
  installWxStub();
  store = loadStore();
  // 基线：云端有一版 C0（goal "base"），登录后 adopt
  cloudToReturn = {
    data: { goals: [{ id: "base" }], knowledge: [], books: [], sessions: [], customPersonas: [] },
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await store.onLogin("u1");
  await flush();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("mp-store 从云端恢复 × 在途推送", () => {
  it("恢复后有在途推送落地：不清脏收场，立即补推恢复版快照（云端不被 S1 盖回）", async () => {
    // T0：本地编辑 → 2.5s 后推送#1 带着恢复前的快照 S1 起飞
    store.state.goals = [{ id: "base" }, { id: "local-edit" }];
    store.markDirtyPublic();
    await vi.advanceTimersByTimeAsync(2500);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].payload.goals.map((g: any) => g.id)).toEqual(["base", "local-edit"]);

    // T1：用户显式从云端恢复（云端是另一版 C1）
    cloudToReturn = {
      data: { goals: [{ id: "cloud-restored" }], knowledge: [], books: [], sessions: [], customPersonas: [] },
      updatedAt: "2026-01-01T00:00:05.000Z",
    };
    const r = await store.pullIfSafe(true, { restore: true });
    expect(r).toBe("pulled");
    expect(store.state.goals.map((g: any) => g.id)).toEqual(["cloud-restored"]);

    // T2：推送#1（S1）落地——修复点：adoptCloud 已 bump editSeq，落地回调发现
    // 代数前进，不走「推进水位 + 清脏」，而是立即补推当前（恢复版）快照
    pushes[0].d.resolve({ updatedAt: "2026-01-01T00:00:09.000Z" });
    await flush();
    expect(pushes).toHaveLength(2);
    expect(pushes[1].payload.goals.map((g: any) => g.id)).toEqual(["cloud-restored"]);

    // 补推落地：脏标记清掉、状态 saved
    pushes[1].d.resolve({ updatedAt: "2026-01-01T00:00:10.000Z" });
    await flush();
    expect(storage.get(DIRTY_KEY)).toBeUndefined();
    expect(statuses[statuses.length - 1]).toBe("saved");

    // T3：下次拉取，云端已是恢复版且水位与本机一致 → 短路 "none"，不再整份 adopt
    cloudToReturn = {
      data: { goals: [{ id: "cloud-restored" }], knowledge: [], books: [], sessions: [], customPersonas: [] },
      updatedAt: "2026-01-01T00:00:10.000Z",
    };
    const r2 = await store.pullIfSafe(true);
    expect(r2).toBe("none");
    expect(store.state.goals.map((g: any) => g.id)).toEqual(["cloud-restored"]);
  });

  it("水位相等但本机缓存损坏：不短路，登录拉取照常 adoptCloud 自愈", async () => {
    // 新进程：缓存半截损坏，但水位标记已经是云端这一版（上次推送成功后写的）
    vi.clearAllTimers();
    storage.clear();
    storage.set("mentora-mp-store-u1", '{"goals":[{"id":"half');
    storage.set("mentora-mp-cloud-at-u1", "2026-01-01T00:00:01.000Z");
    store = loadStore();
    cloudToReturn = {
      data: { goals: [{ id: "selfheal" }], knowledge: [], books: [], sessions: [], customPersonas: [] },
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    const r = await store.onLogin("u1");
    await flush();
    expect(r).toBe("pulled");
    expect(store.state.goals.map((g: any) => g.id)).toEqual(["selfheal"]);
  });
});
