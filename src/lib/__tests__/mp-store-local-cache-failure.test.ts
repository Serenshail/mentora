import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 store：本机缓存读不出必须可见，不能渲染成「还没有数据」 ============
 * 旧实现 loadLocal 的 catch 对 wx.getStorageSync 异常与 JSON.parse 失败一律静默
 * return false，不 emitStatus、不留痕。本机缓存正是未推送数据的唯一副本（260-263 行
 * 注释的设计目标就是靠它 + 脏标记跨进程救援）：缓存损坏（弱网/进程被杀导致半截写入）
 * 时救援链静默断裂——「云端为空 + 缓存损坏 + 脏标记残留」下页面呈现裸空态，与
 * 「从未产生数据」不可区分，用户看不到任何失败提示。
 * 修复：记录 localLoadFailed 并 emitStatus("error")；pullIfSafe 在「云端为空且本机
 * 也没有数据」时据此返回 "error"（而不是 "none"），页面 toast 与同步徽章都可见。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();
const STORE_PATH = join(ROOT, "miniprogram/utils/store.js");
const API_PATH = join(ROOT, "miniprogram/utils/api.js");

let storage: Map<string, unknown>;
let statuses: string[];
let cloudToReturn: any;
let store: any;

function installWxStub() {
  storage = new Map();
  statuses = [];
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
  api.pushCloud = () => Promise.resolve({ updatedAt: "2026-01-01T00:00:00.000Z" });
  api.pullCloud = () => Promise.resolve(cloudToReturn);
  mod.onSyncStatus((s: string) => statuses.push(s));
  return mod;
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(() => {
  installWxStub();
  store = loadStore();
});

describe("mp-store 本机缓存损坏的可见性", () => {
  it("缓存 JSON 损坏 + 云端为空：pull 返回 error（不是 none），且同步状态转 error", async () => {
    storage.set("mentora-mp-store-u1", '{"goals":[{"id":"half'); // 半截写入
    cloudToReturn = null; // 云端没有快照

    const r = await store.onLogin("u1");
    await flush();

    expect(r).toBe("error"); // 旧实现这里回 "none"，页面渲染成空态
    expect(statuses).toContain("error");
  });

  it("缓存损坏但云端有数据：照常采用云端，并清掉错误状态", async () => {
    storage.set("mentora-mp-store-u1", "not-json");
    cloudToReturn = {
      data: { goals: [{ id: "cloud-goal" }], knowledge: [], books: [], sessions: [], customPersonas: [] },
      updatedAt: "2026-02-01T00:00:00.000Z",
    };

    const r = await store.onLogin("u1");
    await flush();

    expect(r).toBe("pulled");
    expect(store.state.goals.map((g: any) => g.id)).toEqual(["cloud-goal"]);
  });

  it("没有缓存（首次登录）不算失败：云端为空时返回 none", async () => {
    cloudToReturn = null;
    const r = await store.onLogin("u1");
    await flush();
    expect(r).toBe("none");
    expect(statuses).not.toContain("error");
  });
});
