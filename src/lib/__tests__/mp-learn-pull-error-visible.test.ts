import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序学习页：云端对齐失败必须可见 ============
 * 事故链（pages/learn/learn.js onShow）：
 *   `store.pullIfSafe(false).then(function () { that.render(); })` 直接丢掉返回值。
 *   pullIfSafe 的契约是 "pulled"/"pushed"/"none"/"skip"/"error"，而 day.js:62-63、
 *   app.js、overview、brain 都判 r === "error" 并提示「云端对齐失败」。
 *   learn 保持旧行为时，用户在过期列表上继续编辑 → markDirty → pushNow 会以本机
 *   旧快照整体覆盖云端，抹掉他端改动。
 * 修法：判 r === "error" 并 toast，与其余四页同口径。
 *
 * 本测试真执行 learn.js（注入 require/wx/Page），断言 toast 行为。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

let toasts: string[];
let pullResult: string;
let pageCfg: any;

function loadLearn() {
  const utils = join(ROOT, "miniprogram/utils");
  const cache = requireCjs.cache as unknown as Record<string, unknown>;
  toasts = [];

  const store = {
    state: { userId: "u1", goals: [], books: [] },
    onLogin: () => Promise.resolve("pulled"),
    pullIfSafe: () => Promise.resolve(pullResult),
    seedSampleGoal: () => {},
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
      searchBooks: () => Promise.resolve({ results: [] }),
    },
  } as unknown;
  cache[join(utils, "chat.js")] = {
    id: "chat",
    filename: "chat",
    loaded: true,
    exports: { streamChat: () => Promise.resolve(""), extractJson: () => ({}) },
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

const settle = async (n = 30) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

beforeEach(() => {
  loadLearn();
});

describe("mp-learn-pull-error: 云端对齐失败可见", () => {
  it("pullIfSafe 返回 error：提示「云端对齐失败」", async () => {
    pullResult = "error";
    const page = makePage();
    page.onShow();
    await settle();
    expect(toasts.some((t) => t.indexOf("云端对齐失败") >= 0)).toBe(true);
  });

  it.each(["pulled", "pushed", "none", "skip"])("正常返回 %s：不打扰用户", async (r) => {
    pullResult = r;
    const page = makePage();
    page.onShow();
    await settle();
    expect(toasts).toEqual([]);
  });
});
