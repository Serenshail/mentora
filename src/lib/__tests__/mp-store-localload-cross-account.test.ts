import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 store：localLoadFailed 跨登出残留（回归锁） ============
 * 事故链（miniprogram/utils/store.js loadLocal 修复前）：本机无缓存的早退分支
 * （`if (!raw) return false;`）不重置 localLoadFailed，resetState/onLogin 也不清
 * 它。前一账号缓存损坏置 true 后登出/换账号登录：新账号无缓存 → 早退不清标记
 * → pullIfSafe 对云端为空、本机也无数据的全新空账号返回 "error"——新用户首次
 * 登录看到「云端对齐失败，请检查网络」的网络故障告警而非空态引导，且与真实
 * 故障不可区分。
 * 修复：无缓存 = 正常空态，早退时重置 localLoadFailed（并把徽章从残留的
 * error 拉回中性 idle）。 */

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
  cloudToReturn = null;
  api.pushCloud = () => Promise.resolve({ updatedAt: "2026-06-01T00:00:00.000Z" });
  api.pullCloud = () => Promise.resolve(cloudToReturn);
  statuses = [];
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

describe("mp-store localLoadFailed 跨账号", () => {
  it("账号A缓存损坏 → error；换账号B（无缓存、云端空）→ none 而非 error", async () => {
    // 账号 A：半截写入的缓存 + 云端为空 → 按设计报 error（既有口径不回归）
    storage.set("mentora-mp-store-u1", '{"goals":[{"id":"half');
    const r1 = await store.onLogin("u1");
    await flush();
    expect(r1).toBe("error");
    expect(statuses).toContain("error");

    // 账号 B：全新空账号（无缓存、云端空）→ 空态，不是网络故障
    cloudToReturn = null;
    const r2 = await store.onLogin("u2");
    await flush();
    expect(r2).toBe("none");
    // 同步徽章不再停留在账号 A 残留的 error
    expect(statuses[statuses.length - 1]).toBe("idle");
  });

  it("无缓存但云端有数据：照常采用云端（修复不误伤自愈路径）", async () => {
    cloudToReturn = {
      data: { goals: [{ id: "cloud-goal" }], knowledge: [], books: [], sessions: [], customPersonas: [] },
      updatedAt: "2026-06-02T00:00:00.000Z",
    };
    const r = await store.onLogin("u1");
    await flush();
    expect(r).toBe("pulled");
    expect(store.state.goals.map((g: any) => g.id)).toEqual(["cloud-goal"]);
  });
});
