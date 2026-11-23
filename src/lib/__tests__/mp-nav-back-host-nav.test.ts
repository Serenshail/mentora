import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

/* ============ tab 页内部视图的返回必须能回本页列表（回归锁） ============
 * 事故链：
 *  1. nav-bar.onBack 无条件导航：栈长>1 走 navigateBack，否则 switchTab 到 overview。
 *     council 是 tab 页，getCurrentPages() 栈长恒为 1——「找谁」视图与会话视图的
 *     nav-bar 均为 home=false（渲染返回箭头），点返回 100% 触发 switchTab 兜底，
 *     用户被甩到「今天」tab；council 页实例的 view 保持 'chat'/'pick'，
 *     会话列表（含历史回看/删除会话入口）在本次运行内不可达，只能杀进程恢复。
 *  2. council.js 的 back() 处理函数存在但从未被任何元素绑定（死代码）。
 * 修法：nav-bar 新增 host-nav 属性（宿主绑定 back 后组件不再自己导航，导航权
 * 交宿主页）；council 两个内部视图的 nav-bar 声明 host-nav 并绑定 back/onNavBack，
 * onNavBack 先中止在途长任务（圆桌多席串行、计费）再切回列表视图。
 * 本测试真执行 nav-bar 组件与 council 页面模块（vm/require 注入）；wxml 绑定
 * 无法执行，以源码文本断言兜底。 */

type NavBarCalls = { back: number; navigateBack: number; switchTab: string[] };

function loadNavBar(opts: { hostNav?: boolean; stackLength?: number }) {
  const src = readFileSync(
    join(process.cwd(), "miniprogram/components/nav-bar/nav-bar.js"),
    "utf8"
  );
  const calls: NavBarCalls = { back: 0, navigateBack: 0, switchTab: [] };
  const g = globalThis as unknown as Record<string, unknown>;
  const pages = new Array(opts.stackLength ?? 1).fill(null);
  g.getCurrentPages = () => pages;
  const wxAny = {
    navigateBack: () => {
      calls.navigateBack += 1;
    },
    switchTab: (o: { url: string }) => calls.switchTab.push(o.url),
  };
  let cfg: any = null;
  const fn = new Function("Component", "getCurrentPages", "wx", src);
  fn((c: unknown) => {
    cfg = c;
  }, () => pages, wxAny);

  const comp: any = Object.assign({}, cfg);
  comp.data = JSON.parse(JSON.stringify(cfg.data));
  comp.setData = (patch: Record<string, unknown>) => Object.assign(comp.data, patch);
  comp.triggerEvent = () => {
    calls.back += 1;
  };
  // Component 的方法挂在 methods 命名空间下，拍平到实例方便直调
  comp.onBack = cfg.methods.onBack;
  comp.setData({ hostNav: opts.hostNav === true });
  return { comp, calls };
}

describe("nav-bar onBack：host-nav 把导航权交宿主页", () => {
  it("host-nav=true：只通知宿主，不再自己 navigateBack/switchTab", () => {
    const { comp, calls } = loadNavBar({ hostNav: true, stackLength: 1 });
    comp.onBack();
    expect(calls.back).toBe(1);
    expect(calls.navigateBack).toBe(0);
    expect(calls.switchTab).toEqual([]); // 旧实现这里必然 switchTab 到 overview
  });

  it("host-nav=false（详情页默认）：保持原行为——无上一页时 switchTab 兜底", () => {
    const { comp, calls } = loadNavBar({ hostNav: false, stackLength: 1 });
    comp.onBack();
    expect(calls.back).toBe(1);
    expect(calls.switchTab).toEqual(["/pages/overview/overview"]);
  });

  it("host-nav=false 且栈长>1：navigateBack", () => {
    const { comp, calls } = loadNavBar({ hostNav: false, stackLength: 2 });
    comp.onBack();
    expect(calls.navigateBack).toBe(1);
    expect(calls.switchTab).toEqual([]);
  });
});

type Dict = Record<string, unknown>;
type StreamOpts = { args: { mode: string } };

function loadCouncil() {
  const require_ = createRequire(import.meta.url);
  const ROOT = process.cwd();
  const storage: Dict = {};
  const g = globalThis as unknown as Record<string, unknown>;
  const cancelCalls = { single: 0 };
  g.wx = {
    getStorageSync: (k: string) => storage[k],
    setStorageSync: (k: string, v: unknown) => {
      storage[k] = v;
    },
    removeStorageSync: (k: string) => {
      delete storage[k];
    },
    showToast: () => {},
    setClipboardData: () => {},
    showModal: () => {},
    reLaunch: () => {},
  };
  g.getApp = () => ({ globalData: { user: { userId: "u1" } } });

  let captured: unknown = null;
  g.Page = (cfg: unknown) => {
    captured = cfg;
  };

  const storePath = join(ROOT, "miniprogram/utils/store.js");
  const chatPath = join(ROOT, "miniprogram/utils/chat.js");
  const seatsPath = join(ROOT, "miniprogram/utils/seats.js");
  const sessionPath = join(ROOT, "miniprogram/utils/session.js");
  const utilPath = join(ROOT, "miniprogram/utils/util.js");
  const pagePath = join(ROOT, "miniprogram/pages/council/council.js");
  for (const p of [storePath, pagePath, seatsPath, sessionPath, utilPath]) {
    delete require_.cache[p];
  }
  require_.cache[chatPath] = {
    id: chatPath,
    filename: chatPath,
    loaded: true,
    exports: { streamChat: () => Promise.resolve("发言"), extractJson: () => ({}) },
  } as unknown as NodeModule;

  require_(pagePath);
  const store = require_(storePath) as any;
  const cfg = captured as { data: Dict } & Dict;
  const page: any = Object.assign({}, cfg);
  page.data = JSON.parse(JSON.stringify(cfg.data));
  const setPath = (obj: Dict, path: string, value: unknown) => {
    const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
    let cur: any = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]!] === undefined || cur[parts[i]!] === null) cur[parts[i]!] = {};
      cur = cur[parts[i]!];
    }
    cur[parts[parts.length - 1]!] = value;
  };
  page.setData = (patch: Dict) => {
    for (const k of Object.keys(patch)) setPath(page.data, k, patch[k]);
  };
  page._cancelSingle = () => {
    cancelCalls.single += 1;
  };
  return { page, store, cancelCalls };
}

describe("council 内部视图返回：回本页列表而不是被甩去别的 tab", () => {
  it("会话视图 onNavBack：中止在途调用并切回列表视图", () => {
    const { page, cancelCalls } = loadCouncil();
    page.setData({ view: "chat", busy: true, rtPhase: "takes" });
    page.onNavBack();

    expect(cancelCalls.single).toBe(1); // 在途单聊流被取消
    expect(page.data.busy).toBe(false);
    expect(page.data.rtPhase).toBe("");
    expect(page.data.view).toBe("list"); // 旧实现这里不变，列表永远回不去
  });

  it("选择器视图 back：直接切回列表视图", () => {
    const { page } = loadCouncil();
    page.setData({ view: "pick" });
    page.back();
    expect(page.data.view).toBe("list");
  });

  it("wxml：两个内部视图的 nav-bar 都声明 host-nav 并绑定 back（静态兜底断言）", () => {
    const wxml = readFileSync(
      join(process.cwd(), "miniprogram/pages/council/council.wxml"),
      "utf8"
    );
    expect(wxml).toContain('<nav-bar title="找谁" bind:back="back" host-nav="{{true}}" />');
    expect(wxml).toContain("bind:back=\"onNavBack\" host-nav=\"{{true}}\"");
  });
});
