import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 学习页会话探测失败必须可见（回归锁） ============
 * 事故链（miniprogram/pages/learn/learn.js）：
 *  1. 冷启动 store.userId 为 null 但 cookie 还在 → onShow 走 me() 探测分支；
 *  2. 弱网/服务不可达时 me() reject，旧实现的 catch 是空函数，随后 return
 *     直接跳过 render() → data.loading 停在初始 true；
 *  3. learn.wxml 两处空态卡都被 `!loading` 守卫，于是页面只剩头部和按钮：
 *     无列表、无空态、无错误、无重试。
 * 修法：catch 里落 loadError，模板给「连接失败 + 重试」；retry/下拉刷新重新探测。
 * 本测试真执行 learn.js（注入 require/wx/Page），不是扫源码文本。 */

function loadLearn(opts: { meRejects: boolean; userId?: string | null }) {
  const src = readFileSync(
    join(process.cwd(), "miniprogram/pages/learn/learn.js"),
    "utf8"
  );
  const calls = { reLaunch: [] as string[], me: 0, clearSession: 0, onLogin: 0 };

  const store: any = {
    state: { userId: opts.userId ?? null, goals: [], books: [] },
    onLogin(userId: string) {
      calls.onLogin += 1;
      store.state.userId = userId;
      return Promise.resolve("pulled");
    },
    pullIfSafe: () => Promise.resolve("skip"),
    seedSampleGoal: () => {},
  };

  const api = {
    hasSession: () => true,
    me: () => {
      calls.me += 1;
      return opts.meRejects
        ? Promise.reject(new Error("network"))
        : Promise.resolve({ user: { userId: "u1", name: "回访用户" } });
    },
    clearSession: () => {
      calls.clearSession += 1;
    },
    searchBooks: () => Promise.resolve({ results: [] }),
  };

  const wx = {
    reLaunch: (o: { url: string }) => calls.reLaunch.push(o.url),
    showModal: () => {},
    stopPullDownRefresh: () => {},
    navigateTo: () => {},
  };

  let pageConfig: any = null;
  const Page = (cfg: any) => {
    pageConfig = cfg;
  };

  const mod = { exports: {} };
  const fn = new Function(
    "require",
    "wx",
    "Page",
    "getApp",
    "module",
    "exports",
    src
  );
  fn(
    (p: string) => {
      if (p === "../../utils/store.js") return store;
      if (p === "../../utils/api.js") return api;
      if (p === "../../utils/chat.js") return { streamChat: () => Promise.resolve(""), extractJson: () => null };
      if (p === "../../utils/util.js") return { toast: () => {} };
      throw new Error("unexpected require: " + p);
    },
    wx,
    Page,
    () => ({ globalData: {} }),
    mod,
    mod.exports
  );

  const page: any = Object.assign({}, pageConfig);
  page.data = Object.assign({}, pageConfig.data);
  page.setData = (patch: any) => {
    Object.assign(page.data, patch);
  };
  return { page, calls, store };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("学习页：me() 探测失败不再静默吞掉", () => {
  it("弱网探测失败：loading 结束、置 loadError（空态/错误/重试可见）", async () => {
    const { page, calls } = loadLearn({ meRejects: true });
    page.onShow();
    await flush();
    await flush();

    expect(page.data.loadError).toBe(true);
    expect(page.data.loading).toBe(false); // 旧实现停在 true
    expect(calls.reLaunch).toHaveLength(0); // 网络失败 ≠ 未登录
    expect(calls.clearSession).toBe(0);
  });

  it("探测成功：走 onLogin 并 render，loadError 清掉", async () => {
    const { page, calls, store } = loadLearn({ meRejects: false });
    page.onShow();
    await flush();
    await flush();

    expect(calls.onLogin).toBe(1);
    expect(page.data.loadError).toBe(false);
    expect(page.data.loading).toBe(false);
    expect(store.state.userId).toBe("u1");
  });

  it("retry：失败后重新探测，成功即清 loadError 并渲染列表", async () => {
    const { page, calls } = loadLearn({ meRejects: false });
    // 先摆出失败态（模拟上一次探测失败留下的状态）
    page.data.loading = false;
    page.data.loadError = true;

    page.retry();
    await flush();
    await flush();

    expect(calls.me).toBe(1);
    expect(calls.onLogin).toBe(1);
    expect(page.data.loadError).toBe(false);
    expect(page.data.loading).toBe(false);
  });

  it("会话未确认时下拉刷新重新探测，而不是 render 出错误的「还没有学习目标」", async () => {
    const { page, calls } = loadLearn({ meRejects: false });
    page.onPullDownRefresh();
    await flush();
    await flush();

    expect(calls.me).toBe(1);
    expect(calls.onLogin).toBe(1); // 探测成功后才渲染，而不是直接 render 空 store
  });
});
