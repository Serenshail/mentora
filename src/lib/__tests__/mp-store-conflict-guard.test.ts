import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 store：遗留脏标记不得整包覆盖他端已更新的云端快照 ============
 * 事故链（miniprogram/utils/store.js pullIfSafe 的「本地未推送改动优先」守卫）：
 *   dirtyPending 是跨进程持久化的（推送失败后一直留着）。旧实现命中该守卫就直接
 *   pushNow() 整包推本地快照，根本不走后面的 lastCloudAt 水位比对。多端场景下：
 *   设备 A 离线编辑未推成功 → 用户在 Web 端继续工作并推了新快照 → 回到 A 登录，
 *   onLogin→pullIfSafe(true) 因遗留脏标记把 A 的旧快照推上云，云端活跃快照被静默
 *   替换，B 端新工作从运行态消失（只能靠服务端 versions/ 回捞）。
 *
 * 修法：markDirty 由净转脏时把当时的云端水位记进 dirtyBaseCloudAt（持久化）。
 * pullIfSafe 在守卫内先比一次基准：云端当前 updatedAt 比基准新 → 两端已分叉，
 * 既不推也不 adopt，返回 "conflict" 并提示用户手动二选一，两端数据原样保留。
 * 本锁同时钉住「没有分叉时行为不变」（照常推送），避免把正常补推也拦掉。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();
const STORE_PATH = join(ROOT, "miniprogram/utils/store.js");
const API_PATH = join(ROOT, "miniprogram/utils/api.js");

let storage: Map<string, unknown>;
let pushes: { payload: any }[];
let cloudToReturn: any;
let toasts: string[];
let store: any;

function installWxStub() {
  storage = new Map();
  toasts = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: (k: string) => (storage.has(k) ? storage.get(k) : ""),
    setStorageSync: (k: string, v: unknown) => void storage.set(k, v),
    removeStorageSync: (k: string) => void storage.delete(k),
    showToast: (o: { title: string }) => void toasts.push(o.title),
  };
}

function loadStore() {
  for (const p of [STORE_PATH, API_PATH]) delete requireCjs.cache[p];
  const mod = requireCjs(STORE_PATH);
  const api = requireCjs(API_PATH);
  pushes = [];
  api.pushCloud = (payload: any) => {
    pushes.push({ payload });
    return Promise.resolve({ updatedAt: "2026-03-01T00:00:00.000Z" });
  };
  api.pullCloud = () => Promise.resolve(cloudToReturn);
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
  vi.useRealTimers();
  installWxStub();
  store = loadStore();
});

describe("mp-store 遗留脏标记 × 他端已更新云端", () => {
  it("本机改动所基于的云端版本比云端旧 → 不推不覆盖，返回 conflict 且提示用户", async () => {
    storage.set(CACHE_KEY, localSnapshot());
    storage.set(DIRTY_KEY, true);
    storage.set(BASE_KEY, "2026-01-01T00:00:00.000Z"); // 本机改动基于旧版云端
    cloudToReturn = cloudSnapshot("2026-02-01T00:00:00.000Z"); // Web 端此后推过新快照

    const r = await store.onLogin("u1");
    await flush();

    expect(r).toBe("conflict");
    // 绝不整包覆盖云端
    expect(pushes).toHaveLength(0);
    // 也绝不 adoptCloud 覆盖本机（两端数据都保留）
    expect(store.state.goals.map((g: any) => g.id)).toEqual(["local-goal"]);
    // 用户必须知道发生了什么、去哪里手动选择
    expect(toasts.join("")).toContain("云端已有他端更新");
    // 脏标记与基准都还在：用户手动选择前不当作已同步
    expect(storage.get(DIRTY_KEY)).toBe(true);
    expect(storage.get(BASE_KEY)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("没有他端更新（云端版本不比基准新）→ 照常补推本机改动（不误伤正常路径）", async () => {
    storage.set(CACHE_KEY, localSnapshot());
    storage.set(DIRTY_KEY, true);
    storage.set(BASE_KEY, "2026-02-01T00:00:00.000Z");
    cloudToReturn = cloudSnapshot("2026-01-15T00:00:00.000Z"); // 云端不比基准新

    const r = await store.onLogin("u1");
    await flush();

    expect(r).toBe("pushed");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].payload.goals.map((g: any) => g.id)).toEqual(["local-goal"]);
    // 推送落地后脏标记清掉、基准推进到落地版本
    expect(storage.get(DIRTY_KEY)).toBeUndefined();
    expect(storage.get(BASE_KEY)).toBe("2026-03-01T00:00:00.000Z");
  });

  it("markDirty 只在由净转脏时记基准：同批后续编辑不覆盖它（否则分叉守卫会失效）", async () => {
    cloudToReturn = cloudSnapshot("2026-01-01T00:00:00.000Z");
    await store.onLogin("u1");
    await flush();
    store.state.goals = [{ id: "g1" }];

    store.markDirtyPublic();
    expect(storage.get(BASE_KEY)).toBe("2026-01-01T00:00:00.000Z");

    // 模拟他端在两次编辑之间推了新快照（本端水位被 pull 推进）
    cloudToReturn = cloudSnapshot("2026-02-01T00:00:00.000Z");
    store.markDirtyPublic(); // 同批第二次编辑
    expect(storage.get(BASE_KEY)).toBe("2026-01-01T00:00:00.000Z");
  });
});
