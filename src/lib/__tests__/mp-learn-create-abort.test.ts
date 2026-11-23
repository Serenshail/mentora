import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序学习页：建档流的取消句柄与跨 tab toast ============
 * 事故链（pages/learn/learn.js create → generate）：
 *   reading-plan 生成 10-30s，旧实现 streamChat 没传 register。learn 是 tab 页，
 *   切 tab 只触发 onHide、不卸载页面，所以流不会被中止；但生成完成时弹的是
 *   **全局** toast——用户此时停在别的 tab 上，看不到「已建好阅读路线」，回来只见
 *   表单已关，容易再建一本同书名的重复书（createBookFromPlan 无同名去重）。
 * 修法：register 存取消句柄（onUnload 时取消）；结果 toast 只在本页可见时弹。
 * 书本身照常建好，回到本页 render 会列出来。
 *
 * 本测试真执行 learn.js（注入 require/wx/Page），流用 deferred 控制时序。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

let toasts: string[];
let streamOpts: any;
let created: any[];
let pageCfg: any;
let resolveStream: ((v: string) => void) | null;
let rejectStream: ((e: Error) => void) | null;
let streamShouldReject: boolean;

function loadLearn() {
  const utils = join(ROOT, "miniprogram/utils");
  const cache = requireCjs.cache as unknown as Record<string, unknown>;
  toasts = [];
  streamOpts = null;
  created = [];
  resolveStream = null;
  rejectStream = null;
  streamShouldReject = false;

  const store = {
    state: { userId: "u1", goals: [], books: [] },
    onLogin: () => Promise.resolve("pulled"),
    pullIfSafe: () => Promise.resolve("skip"),
    seedSampleGoal: () => {},
    createBookFromPlan: (...args: any[]) => {
      created.push(args);
      return "b1";
    },
  };
  cache[join(utils, "store.js")] = { id: "store", filename: "store", loaded: true, exports: store } as unknown;
  cache[join(utils, "api.js")] = {
    id: "api",
    filename: "api",
    loaded: true,
    exports: {
      hasSession: () => true,
      me: () => Promise.resolve({ user: { userId: "u1" } }),
      clearSession: () => {},
      // 可信书目来源 + 标题含书名（与 learn.js isCredibleSource/标题判据对齐）
      searchBooks: () =>
        Promise.resolve({
          results: [{ url: "https://book.douban.com/subject/1", title: "思考快与慢 书评" }],
        }),
    },
  } as unknown;
  cache[join(utils, "chat.js")] = {
    id: "chat",
    filename: "chat",
    loaded: true,
    exports: {
      streamChat: (o: any) => {
        streamOpts = o;
        return new Promise<string>((resolve, reject) => {
          resolveStream = resolve;
          rejectStream = reject;
        });
      },
      extractJson: (t: string) => JSON.parse(t),
    },
  } as unknown;

  const g = globalThis as unknown as Dict;
  g.wx = {
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: (o: { title: string }) => toasts.push(o.title),
    showModal: () => {},
    reLaunch: () => {},
    navigateTo: () => {},
    stopPullDownRefresh: () => {},
  };

  const pagePath = join(ROOT, "miniprogram/pages/learn/learn.js");
  delete cache[pagePath];
  let captured: any = null;
  (globalThis as unknown as Dict).Page = (cfg: any) => {
    captured = cfg;
  };
  requireCjs(pagePath);
  if (!captured) throw new Error("learn.js 未调用 Page()");
  pageCfg = captured;
}

function makePage(): any {
  const page = Object.assign({}, pageCfg);
  page.data = JSON.parse(JSON.stringify(pageCfg.data));
  page.setData = function (patch: Dict) {
    Object.assign(this.data, patch);
  };
  return page;
}

const settle = async (n = 40) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** 走到「生成流已在途」的状态（searchBooks 已核实通过） */
async function startCreate(page: any) {
  page.onShow();
  page.setData({ title: "思考快与慢" });
  page.create();
  await settle();
}

const OK_PLAN = JSON.stringify({ chapters: [{ title: "第一章" }] });

beforeEach(() => {
  loadLearn();
});

describe("mp-learn-create: 建档流的取消句柄 + toast 只在本页可见时弹", () => {
  it("streamChat 传入 register；页面可见时正常提示", async () => {
    const page = makePage();
    await startCreate(page);
    expect(streamOpts).toBeTruthy();
    expect(typeof streamOpts.register).toBe("function");

    resolveStream!(OK_PLAN);
    await settle();
    expect(created.length).toBe(1);
    expect(toasts).toContain("已建好阅读路线");
  });

  it("生成期间切走 tab（onHide）：书照常建好，但 toast 不弹在别的页面上", async () => {
    const page = makePage();
    await startCreate(page);
    page.onHide(); // 用户切到别的 tab
    resolveStream!(OK_PLAN);
    await settle();

    expect(created.length).toBe(1); // 书必须照常建好
    expect(toasts).not.toContain("已建好阅读路线");
  });

  it("页面销毁（onUnload）调用取消句柄；之后流结束也不再对死页 setData/toast", async () => {
    const page = makePage();
    await startCreate(page);
    let cancelled = false;
    streamOpts.register(() => {
      cancelled = true;
    });
    page.onUnload();
    expect(cancelled).toBe(true);

    // 流在取消后仍可能落地（cancel 与完成赛跑）：不得写死页
    resolveStream!(OK_PLAN);
    await settle();
    expect(toasts).not.toContain("已建好阅读路线");
  });

  it("失败路径同样只在可见时提示", async () => {
    const page = makePage();
    await startCreate(page);
    page.onHide();
    rejectStream!(new Error("生成失败"));
    await settle();
    expect(toasts).not.toContain("生成失败");
  });

  it("可见时失败要提示（守卫没有误伤正常失败反馈）", async () => {
    const page = makePage();
    await startCreate(page);
    rejectStream!(new Error("生成失败"));
    await settle();
    expect(toasts).toContain("生成失败");
  });
});
