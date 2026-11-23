import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 store：在途推送不得清掉后一次编辑的脏标记 ============
 * 事故链（miniprogram/utils/store.js:213-215 与 :290）：
 *   T0 markDirty → 2.5s 后推送#1 发出（在途，pushCloud 未返回）
 *   T1 用户又编辑 → markDirty 再次置 dirtyPending、写回持久脏标记，
 *      并重排 2.5s 防抖推送#2
 *   T2 推送#1 先完成 → 旧实现无条件 `dirtyPending = false` +
 *      `writeFlag(dirtyKey(), "")` + emitStatus("saved")
 *   于是 T2 到 T1+2.5s 之间三个守卫（dirtyPending/pushing/syncStatus）全假，
 *   pullIfSafe 会 adoptCloud 用**不含 T1 编辑**的云端快照整体替换 state 并
 *   saveLocal 覆盖本机缓存；进程在此窗口被杀，下次登录 force-pull 同样丢。
 *
 * 修法：markDirty 自增 editSeq，pushNow 记下本次上传的 editSeq；成功回调发现
 * 代数已前进就保留脏标记并立即补推最新快照，由内层真正落地后再清。
 * 本测试真执行 store.js（stub wx 存储 + api.pushCloud/pullCloud），断言窗口内
 * 脏标记仍在、pullIfSafe 不采用云端、且补推载荷包含最新编辑。 */

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

const dirtyKey = () => "mentora-mp-dirty-u1";

beforeEach(async () => {
  vi.useFakeTimers();
  installWxStub();
  store = loadStore();
  cloudToReturn = { data: { goals: [], knowledge: [], books: [], sessions: [], customPersonas: [] }, updatedAt: "2026-01-01T00:00:00.000Z" };
  await store.onLogin("u1");
  await flush();
  store.state.goals = [{ id: "g1" }];
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("mp-store 在途推送 × 后续编辑", () => {
  it("推送#1 成功时若已有新编辑：不清脏标记、不 adoptCloud、立即补推最新快照", async () => {
    // T0：第一次编辑 → 2.5s 后发出推送#1
    store.markDirtyPublic();
    await vi.advanceTimersByTimeAsync(2500);
    expect(pushes).toHaveLength(1);
    expect(statuses[statuses.length - 1]).toBe("saving");

    // T1：推送#1 在途时用户再次编辑（重排防抖，推送#2 尚未发出）
    store.state.goals.push({ id: "g2" });
    store.markDirtyPublic();
    expect(storage.get(dirtyKey())).toBe(true);

    // T2：推送#1 先完成 —— 它带的是不含 g2 的旧快照
    pushes[0].d.resolve({ updatedAt: "2026-01-01T00:00:01.000Z" });
    await flush();

    // 核心断言：脏标记必须还在（旧实现在这里已 writeFlag(dirtyKey(),"")）
    expect(storage.get(dirtyKey())).toBe(true);
    // 且补推已立即发出，载荷包含最新编辑
    expect(pushes).toHaveLength(2);
    expect(pushes[1].payload.goals.map((g: any) => g.id)).toEqual(["g1", "g2"]);
    // 状态不能是 saved（否则 pullIfSafe 的 syncStatus 守卫也会失效）
    expect(statuses[statuses.length - 1]).toBe("saving");

    // 云端此时返回一份不含 g2 的快照：守卫必须拒绝覆盖
    cloudToReturn = {
      data: { goals: [{ id: "cloud-only" }], knowledge: [], books: [], sessions: [], customPersonas: [] },
      updatedAt: "2026-01-01T00:00:02.000Z",
    };
    /* pushCloud 在本 stub 里永不自行 resolve，pullIfSafe 会挂起（真实环境会返回），
     * 所以不 await 整条链，只断言它没有走到 adoptCloud。 */
    void store.pullIfSafe(true);
    await flush();
    expect(store.state.goals.map((g: any) => g.id)).toEqual(["g1", "g2"]);

    // 逐个排空后续推送（补推 + pullIfSafe 排队的）
    for (let i = 0; i < 6; i++) {
      const last = pushes[pushes.length - 1];
      last.d.resolve({ updatedAt: "2026-01-01T00:00:1" + i + ".000Z" });
      await flush();
      if (statuses[statuses.length - 1] === "saved") break;
    }

    // 真正落地后才清脏标记、才转 saved；本地编辑全程没被云端覆盖
    expect(storage.get(dirtyKey())).toBeUndefined();
    expect(statuses[statuses.length - 1]).toBe("saved");
    expect(store.state.goals.map((g: any) => g.id)).toEqual(["g1", "g2"]);
  });

  it("在途期间没有新编辑时：照常清脏标记并转 saved（不误伤正常路径）", async () => {
    store.markDirtyPublic();
    await vi.advanceTimersByTimeAsync(2500);
    expect(pushes).toHaveLength(1);

    pushes[0].d.resolve({ updatedAt: "2026-01-01T00:00:01.000Z" });
    await flush();

    expect(pushes).toHaveLength(1); // 没有多余的补推
    expect(storage.get(dirtyKey())).toBeUndefined();
    expect(statuses[statuses.length - 1]).toBe("saved");
  });

  it("持久脏标记跨进程可用：在途编辑后即使进程被杀，重启仍会补推", async () => {
    store.markDirtyPublic();
    await vi.advanceTimersByTimeAsync(2500);
    store.state.goals.push({ id: "g2" });
    store.markDirtyPublic();
    pushes[0].d.resolve({ updatedAt: "2026-01-01T00:00:01.000Z" });
    await flush();

    // 模拟进程被杀：不再排空推送，直接以同一份存储重新加载 store
    const persisted = storage.get(dirtyKey());
    expect(persisted).toBe(true);
    // 本机缓存写盘是 800ms 防抖（store.js:90-96），让它落盘再"重启"
    await vi.advanceTimersByTimeAsync(800);

    vi.clearAllTimers();
    store = loadStore(); // 新进程，storage 保留
    /* onLogin 内部会 pullIfSafe→pushNow，而 pushCloud 在这个 stub 里永不自行
     * resolve：不要 await 整条链，只等它发出推送即可。 */
    void store.onLogin("u1");
    await flush();
    // 登录后的 force-pull 必须让位给未推送的本地改动（走 pushNow 而不是 adoptCloud）
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    expect(pushes[0].payload.goals.map((g: any) => g.id)).toEqual(["g1", "g2"]);
    // 补推落地后脏标记才清掉
    pushes[0].d.resolve({ updatedAt: "2026-01-01T00:00:09.000Z" });
    await flush();
    expect(storage.get(dirtyKey())).toBeUndefined();
  });
});
