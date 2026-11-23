import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

/* ============ 会话被服务端吊销必须自愈；pull 失败必须可见（回归锁） ============
 * 事故链：
 *  1. 服务端 verifySession 在改密/重置密码 bump sv（auth.ts:117/133）、30 天会话过期、
 *     账号注销时吊销会话。/api/auth/me 对失效会话回 200+{user:null}，但 /api/sync
 *     回 401（src/app/api/sync/route.ts）——两套语义。
 *  2. 小程序本机备份的 cookie 串永不过期（api.js savedCookie 只在覆盖时清除）。
 *     用户在 Web 端改密后，小程序进程仍存活、store.state.userId 已置位：此后每次
 *     回前台 App.onShow 的 else 分支 pullIfSafe(false) 拿到 401 → 旧 store 报 "error"
 *     → 弹「云端对齐失败，请检查网络」，误导且永不自愈。
 *  3. me() 成功但 /api/sync 失败（全量快照 MB 级 + 60s 超时，弱网现实可发生）时，
 *     onLogin 的返回值被丢弃——本机无缓存的直达页停在「书不存在」假空态，无重试入口。
 * 修法：store.pullIfSafe 对 401 返回 "unauthorized" 哨兵；app.js 两条分支与
 * session.js probeOnce 都处理它（清会话回登录页自愈）；pull "error" 走与 me() 失败
 * 同一张重试模态；防重入标志经 globalData 两边互认（不叠两张）。
 * 本测试真执行 miniprogram/app.js 与 miniprogram/utils/session.js（vm/require 注入）。 */

const flush = () => new Promise((r) => setTimeout(r, 0));

type AppCalls = {
  reLaunch: string[];
  toast: string[];
  modal: number;
  onLogin: number;
  clearSession: number;
  renders: number;
};

function loadApp(opts: {
  storeUserId?: string | null;
  pullResult?: string;
  loginResult?: string;
  meRejects?: boolean;
  withModal?: boolean;
  sharedFlag?: boolean;
  pages?: unknown[];
}) {
  const src = readFileSync(join(process.cwd(), "miniprogram/app.js"), "utf8");
  const calls: AppCalls = {
    reLaunch: [],
    toast: [],
    modal: 0,
    onLogin: 0,
    clearSession: 0,
    renders: 0,
  };
  const store: any = {
    state: { userId: opts.storeUserId ?? null, goals: [] as any[] },
    onLogin(_userId: string) {
      calls.onLogin += 1;
      store.state.userId = _userId;
      return Promise.resolve(opts.loginResult ?? "pulled");
    },
    pullIfSafe: () => Promise.resolve(opts.pullResult ?? "pulled"),
    flushPush: () => {},
  };
  const api = {
    hasSession: () => true,
    me: () =>
      opts.meRejects
        ? Promise.reject(new Error("network"))
        : Promise.resolve({ user: { userId: "u1", name: "回访用户" } }),
    clearSession: () => {
      calls.clearSession += 1;
    },
  };
  const wxAny: any = {
    reLaunch: (o: { url: string }) => calls.reLaunch.push(o.url),
    showToast: (o: { title: string }) => calls.toast.push(o.title),
  };
  if (opts.withModal !== false) wxAny.showModal = () => {
    calls.modal += 1;
  };

  let appConfig: any = null;
  const App = (cfg: any) => {
    appConfig = cfg;
  };
  const mod = { exports: {} };
  const fn = new Function(
    "require",
    "wx",
    "App",
    "getCurrentPages",
    "module",
    "exports",
    "console",
    src
  );
  fn(
    (p: string) => {
      if (p === "./utils/store.js") return store;
      if (p === "./utils/api.js") return api;
      throw new Error("unexpected require: " + p);
    },
    wxAny,
    App,
    () => opts.pages ?? [{ render: () => void calls.renders++ }],
    mod,
    mod.exports,
    { error: () => {}, log: () => {}, warn: () => {} }
  );
  if (opts.sharedFlag) appConfig.globalData.sessionFailModalOpen = true;
  return { appConfig, calls };
}

type SessionCalls = {
  me: number;
  clearSession: number;
  reLaunch: string[];
  modal: number;
  onLogin: number;
};

function loadSession(opts: { loginResult?: string; sharedFlag?: boolean }) {
  const require_ = createRequire(import.meta.url);
  const utils = join(process.cwd(), "miniprogram/utils");
  const cache = require_.cache as unknown as Record<string, unknown>;
  const calls: SessionCalls = { me: 0, clearSession: 0, reLaunch: [], modal: 0, onLogin: 0 };
  const store = {
    state: { userId: null as string | null },
    onLogin() {
      calls.onLogin += 1;
      store.state.userId = "u1";
      return Promise.resolve(opts.loginResult ?? "pulled");
    },
  };
  const api = {
    hasSession: () => true,
    me: () => {
      calls.me += 1;
      return Promise.resolve({ user: { userId: "u1" } });
    },
    clearSession: () => {
      calls.clearSession += 1;
    },
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    reLaunch: (o: { url: string }) => calls.reLaunch.push(o.url),
    showModal: () => {
      calls.modal += 1;
    },
    showToast: () => {},
  };
  const globalData: Record<string, unknown> = { user: null };
  if (opts.sharedFlag) globalData.sessionFailModalOpen = true;
  g.getApp = () => ({ globalData });
  cache[join(utils, "store.js")] = {
    id: "store",
    filename: "store",
    loaded: true,
    exports: store,
  };
  cache[join(utils, "api.js")] = { id: "api", filename: "api", loaded: true, exports: api };
  const sessionPath = join(utils, "session.js");
  delete cache[sessionPath];
  const sessionGuard = require_(sessionPath) as { ensure: (fn?: () => void) => Promise<boolean> };
  return { sessionGuard, calls, globalData };
}

describe("会话吊销自愈（App.onShow 回前台对齐分支）", () => {
  it("userId 已置位时 /api/sync 401（unauthorized）：清 cookie 回登录页，不再误报网络故障", async () => {
    const { appConfig, calls } = loadApp({ storeUserId: "u1", pullResult: "unauthorized" });
    appConfig.onShow.call(appConfig);
    await flush();
    await flush();

    expect(calls.clearSession).toBe(1);
    expect(calls.reLaunch).toEqual(["/pages/login/login"]);
    expect(calls.toast).toEqual([]); // 旧实现这里弹「云端对齐失败，请检查网络」
  });

  it("userId 已置位时真正的网络失败（error）：仍弹提示、不清会话", async () => {
    const { appConfig, calls } = loadApp({ storeUserId: "u1", pullResult: "error" });
    appConfig.onShow.call(appConfig);
    await flush();

    expect(calls.toast.some((t) => t.indexOf("云端对齐失败") >= 0)).toBe(true);
    expect(calls.clearSession).toBe(0);
    expect(calls.reLaunch).toEqual([]);
  });

  it("恢复路径中 me() 过了但快照拉取被吊销（unauthorized）：与 user:null 同一自愈", async () => {
    const { appConfig, calls } = loadApp({ storeUserId: null, loginResult: "unauthorized" });
    appConfig.onShow.call(appConfig);
    await flush();
    await flush();

    expect(calls.clearSession).toBe(1);
    expect(calls.reLaunch).toEqual(["/pages/login/login"]);
  });
});

describe("pull 失败可见（me() 成功但全量快照没拉下来）", () => {
  it("App 冷启动恢复：onLogin 返回 error 时弹重试模态，页面仍补渲染", async () => {
    const { appConfig, calls } = loadApp({ storeUserId: null, loginResult: "error" });
    appConfig.onShow.call(appConfig);
    await flush();
    await flush();

    expect(calls.modal).toBe(1); // 旧实现把 r 扔掉，静默停在假空态
    expect(calls.reLaunch).toEqual([]);
    expect(calls.renders).toBe(1);
  });

  it("session.js probeOnce：onLogin 返回 error 时弹同一张重试模态", async () => {
    const { sessionGuard, calls } = loadSession({ loginResult: "error" });
    sessionGuard.ensure(() => {});
    await flush();
    await flush();

    expect(calls.me).toBe(1);
    expect(calls.onLogin).toBe(1);
    expect(calls.modal).toBe(1);
    expect(calls.reLaunch).toEqual([]);
    expect(calls.clearSession).toBe(0);
  });

  it("session.js probeOnce：onLogin 返回 unauthorized 时清会话回登录页", async () => {
    const { sessionGuard, calls } = loadSession({ loginResult: "unauthorized" });
    sessionGuard.ensure(() => {});
    await flush();
    await flush();

    expect(calls.clearSession).toBe(1);
    expect(calls.reLaunch).toEqual(["/pages/login/login"]);
    expect(calls.modal).toBe(0);
  });
});

describe("失败模态防重入标志经 globalData 互认（app.js 与 session.js 不叠两张）", () => {
  it("session.js 的模态还开着（标志在 globalData）时，app.js 的探测再失败不再弹第二张", async () => {
    const { appConfig, calls } = loadApp({
      storeUserId: null,
      meRejects: true,
      sharedFlag: true,
    });
    appConfig.onShow.call(appConfig);
    await flush();
    await flush();

    expect(calls.modal).toBe(0);
    expect(calls.clearSession).toBe(0); // 网络失败不清会话
  });

  it("session.js 弹模态后把标志写进 globalData，app.js 可读到", async () => {
    const { sessionGuard, calls, globalData } = loadSession({ loginResult: "error" });
    sessionGuard.ensure(() => {});
    await flush();
    await flush();

    expect(calls.modal).toBe(1);
    expect((globalData as Record<string, unknown>).sessionFailModalOpen).toBe(true);
  });
});
