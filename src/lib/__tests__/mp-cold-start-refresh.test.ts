import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 冷启动会话恢复后必须通知当前页重渲染（回归锁） ============
 * 事故链（miniprogram/app.js:33-58）：
 *  1. 带有效 cookie 冷启动，各页 onShow 先跑。overview.js:54 看到 hasSession() 为真
 *     就跳过自身 probe，render() 立刻以空 store 收尾（loading:false、goal:null），
 *     wxml 呈现「还没有进行中的目标」引导卡；book 直达页则整页空白。
 *  2. app.js onShow 走 me()→onLogin→pullIfSafe(true)，adoptCloud 只写 state +
 *     saveLocal，全程不 emitStatus（store.js 的 emitStatus 只在 saving/saved/error
 *     三条路径上调用），因此没有任何监听器被触发。
 *  3. 数据落地后链路就结束了 → 页面停在误导性空态，必须切 tab/下拉刷新才恢复。
 * 修法：onLogin 的 promise 落地后刷新栈顶页面（render / renderList）。
 * 本测试真执行 app.js（vm 式注入 require/wx/App），而不是扫源码文本。 */

type Page = { render?: () => void; renderList?: () => void };

function loadApp(opts: {
  pages: Page[];
  storeUserId?: string | null;
  loginResult?: string;
  meRejects?: boolean;
}) {
  const src = readFileSync(join(process.cwd(), "miniprogram/app.js"), "utf8");
  const calls = {
    reLaunch: [] as string[],
    toast: [] as string[],
    onLogin: 0,
    clearSession: 0,
  };

  const store: any = {
    state: { userId: opts.storeUserId ?? null, goals: [] as any[] },
    onLogin(userId: string) {
      calls.onLogin += 1;
      // 真实 store 在这里 loadLocal + pullIfSafe→adoptCloud，只改 state
      store.state.userId = userId;
      store.state.goals = [{ id: "g1", status: "active", topic: "真实目标" }];
      return Promise.resolve(opts.loginResult ?? "pulled");
    },
    pullIfSafe: () => Promise.resolve("skip"),
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

  const wx = {
    reLaunch: (o: { url: string }) => calls.reLaunch.push(o.url),
    showToast: (o: { title: string }) => calls.toast.push(o.title),
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
    wx,
    App,
    () => opts.pages,
    mod,
    mod.exports,
    { error: () => {}, log: () => {}, warn: () => {} }
  );

  return { appConfig, calls, store };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("小程序冷启动：会话恢复后刷新当前页", () => {
  it("overview 冷启动（store 空 + 有 cookie）：me()/onLogin 落地后调用当前页 render", async () => {
    let renderedGoals: number | null = null;
    const page: Page = {
      render() {
        // 页面此刻看到的 store 必须已经是恢复后的数据
        renderedGoals = (globalThis as any).__mpStore.state.goals.length;
      },
    };
    const { appConfig, store, calls } = loadApp({ pages: [page] });
    (globalThis as any).__mpStore = store;

    appConfig.onShow.call(appConfig);
    await flush();
    await flush();

    expect(calls.onLogin).toBe(1);
    expect(renderedGoals).toBe(1); // 空态不会停留：render 在数据落地后被再次调用
    expect(calls.reLaunch).toHaveLength(0);
  });

  it("拉取失败（只剩本地缓存）也要重渲染：数据同样变了", async () => {
    let renders = 0;
    const { appConfig } = loadApp({
      pages: [{ render: () => void (renders += 1) }],
      loginResult: "error",
    });
    appConfig.onShow.call(appConfig);
    await flush();
    await flush();
    expect(renders).toBe(1);
  });

  it("栈顶页没有 render 时安全跳过（不抛错、不影响其它页）", async () => {
    const { appConfig, calls } = loadApp({ pages: [{}] });
    expect(() => appConfig.onShow.call(appConfig)).not.toThrow();
    await flush();
    await flush();
    expect(calls.onLogin).toBe(1); // 恢复照常完成，只是没有页面需要刷新
  });

  it("me() 失败（弱网）不清会话、不重渲染，下次 onShow 重试", async () => {
    let renders = 0;
    const { appConfig, calls } = loadApp({
      pages: [{ render: () => void (renders += 1) }],
      meRejects: true,
    });
    appConfig.onShow.call(appConfig);
    await flush();
    await flush();
    expect(renders).toBe(0);
    expect(calls.clearSession).toBe(0);
    expect(calls.reLaunch).toHaveLength(0);
  });

  it("已有 userId 的回前台路径不受影响（只做 pullIfSafe，不误触重渲染）", async () => {
    let renders = 0;
    const { appConfig, calls } = loadApp({
      pages: [{ render: () => void (renders += 1) }],
      storeUserId: "u1",
    });
    appConfig.onShow.call(appConfig);
    await flush();
    expect(calls.onLogin).toBe(0);
    expect(renders).toBe(0);
  });
});
