import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import { join } from "path";

/* ============ 五个 tab 页的登录守卫必须同语义（回归锁） ============
 * 修复前同一问题五种行为：
 *  · council.js:76 `!userId && !globalData.user` → 冷启动直达时 me() 探测还没返回
 *    就 reLaunch 登录页，把 cookie 其实有效的用户踢走（login 页也不会自动跳回）；
 *  · brain.js:19 / profile.js:25 `!userId && !hasSession()` → 有 cookie 就既不探测
 *    也不跳转，store 未 loadLocal 全空、pullIfSafe 恒 skip，停在「第二大脑还是空的」
 *    误导性空态且不自愈；
 *  · learn.js/overview.js 各自实现探测（语义正确，但重复）。
 * 修法：utils/session.js 统一守卫 —— userId 已恢复直接渲染；没 cookie 回登录页；
 * 有 cookie 先 me() 探测，成功 → onLogin 后渲染，服务端回 user:null → 清会话回登录页，
 * 网络失败 → 保留会话 + 「重试/暂不」模态（不踢人）。
 * 本测试真执行页面与守卫模块（注入 require/wx/Page），按行为断言。 */

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

type Harness = {
  page: any;
  calls: { reLaunch: string[]; me: number; clearSession: number; onLogin: number; modal: number };
  store: any;
};

function setPath(obj: Dict, path: string, value: unknown) {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const nextIsIndex = /^\d+$/.test(parts[i + 1]!);
    if (cur[k] === undefined || cur[k] === null) cur[k] = nextIsIndex ? [] : {};
    cur = cur[k] as Dict;
  }
  cur[parts[parts.length - 1]!] = value;
}

function loadPage(opts: {
  page: "council" | "brain" | "profile";
  hasSession: boolean;
  userId?: string | null;
  meRejects?: boolean;
  meUser?: { userId: string; name: string } | null;
}): Harness {
  const calls = { reLaunch: [] as string[], me: 0, clearSession: 0, onLogin: 0, modal: 0 };
  const store: any = {
    state: {
      userId: opts.userId ?? null,
      sessions: [] as Dict[],
      knowledge: [] as Dict[],
      goals: [] as Dict[],
      books: [] as Dict[],
    },
    onLogin(userId: string) {
      calls.onLogin += 1;
      store.state.userId = userId;
      // 真实 store 在这里 loadLocal：恢复后应有数据
      store.state.knowledge = [{ id: "k1", title: "真实笔记", body: "正文", domain: "x" }];
      return Promise.resolve("pulled");
    },
    pullIfSafe: () => Promise.resolve("skip"),
    onSyncStatus: () => () => {},
    dueReviews: () => [],
    sessionById: () => null,
    addSession: () => {},
    removeSession: () => {},
  };

  const api = {
    hasSession: () => opts.hasSession,
    me: () => {
      calls.me += 1;
      if (opts.meRejects) return Promise.reject(new Error("network"));
      const user = opts.meUser === undefined ? { userId: "u1", name: "回访用户" } : opts.meUser;
      return Promise.resolve({ user });
    },
    clearSession: () => {
      calls.clearSession += 1;
    },
  };

  const util = {
    toast: () => {},
    uid: () => "x",
    clone: (o: unknown) => JSON.parse(JSON.stringify(o)),
  };

  const g = globalThis as unknown as Dict;
  g.wx = {
    reLaunch: (o: { url: string }) => calls.reLaunch.push(o.url),
    showModal: () => {
      calls.modal += 1;
    },
    showToast: () => {},
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    setNavigationBarTitle: () => {},
    stopPullDownRefresh: () => {},
    navigateTo: () => {},
    switchTab: () => {},
    navigateBack: () => {},
  };
  g.getApp = () => ({ globalData: { user: null } });

  let captured: unknown = null;
  g.Page = (cfg: unknown) => {
    captured = cfg;
  };

  const utils = join(ROOT, "miniprogram/utils");
  const cache = require_.cache as unknown as Record<string, unknown>;
  const put = (file: string, exports: unknown) => {
    const p = join(utils, file);
    cache[p] = { id: p, filename: p, loaded: true, exports } as unknown;
  };
  put("store.js", store);
  put("api.js", api);
  put("util.js", util);
  put("md.js", { parse: (s: string) => ({ blocks: [{ t: "p", text: s }], links: [] }), plain: (s: string) => s });
  put("chat.js", { streamChat: () => Promise.resolve(""), extractJson: () => ({}) });
  put("seats.js", { byId: () => null, ALL: [] });
  put("stream-view.js", {
    createStreamRenderer: () => ({ push: () => {}, flush: () => {}, cancel: () => {} }),
  });
  put("schema.js", { DEPOSIT_TYPES: [], READ_STATUS_LABELS: {} });

  const pagePath = join(ROOT, `miniprogram/pages/${opts.page}/${opts.page}.js`);
  delete cache[pagePath];
  delete cache[join(utils, "session.js")];
  require_(pagePath);

  const cfg = captured as { data: Dict } & Dict;
  const page: any = Object.assign({}, cfg);
  page.data = JSON.parse(JSON.stringify(cfg.data));
  page.setData = (patch: Dict) => {
    for (const k of Object.keys(patch)) setPath(page.data, k, patch[k]);
  };
  return { page, calls, store };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("tab 页登录守卫：cookie 有效时不许被踢去登录页，也不许停在空态", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("council 冷启动直达（有 cookie、userId 未恢复）：探测后渲染，不 reLaunch 登录页", async () => {
    const { page, calls } = loadPage({ page: "council", hasSession: true });
    page.onShow();
    await flush();
    await flush();

    expect(calls.reLaunch).toEqual([]); // 旧实现这里会把已登录用户踢去登录页
    expect(calls.me).toBe(1);
    expect(calls.onLogin).toBe(1);
  });

  it("brain 冷启动（有 cookie）：先探测再渲染，空态只在真的没有笔记时出现", async () => {
    const { page, calls } = loadPage({ page: "brain", hasSession: true });
    page.onShow();
    await flush();
    await flush();

    expect(calls.me).toBe(1);
    expect(calls.onLogin).toBe(1);
    expect(page.data.loading).toBe(false);
    expect(page.data.total).toBe(1); // 恢复后的笔记已渲染，不是「第二大脑还是空的」
    expect(calls.reLaunch).toEqual([]);
  });

  it("profile 冷启动（有 cookie）：探测后再渲染，不会先显示「未登录」", async () => {
    const { page, calls } = loadPage({ page: "profile", hasSession: true });
    page.onShow();
    await flush();
    await flush();

    expect(calls.me).toBe(1);
    expect(page.data.counts.notes).toBe(1);
    expect(calls.reLaunch).toEqual([]);
  });

  it("没有 cookie：明确未登录，直接回登录页（不白发探测）", async () => {
    const { page, calls } = loadPage({ page: "council", hasSession: false });
    page.onShow();
    await flush();

    expect(calls.reLaunch).toEqual(["/pages/login/login"]);
    expect(calls.me).toBe(0);
  });

  it("服务端明确回 user:null（会话失效）：清 cookie 并回登录页", async () => {
    const { page, calls } = loadPage({ page: "brain", hasSession: true, meUser: null });
    page.onShow();
    await flush();
    await flush();

    expect(calls.clearSession).toBe(1);
    expect(calls.reLaunch).toEqual(["/pages/login/login"]);
  });

  it("网络失败：保留会话、给可见重试模态，不踢人", async () => {
    const { page, calls } = loadPage({ page: "council", hasSession: true, meRejects: true });
    page.onShow();
    await flush();
    await flush();

    expect(calls.clearSession).toBe(0);
    expect(calls.reLaunch).toEqual([]);
    expect(calls.modal).toBe(1);
  });

  it("userId 已恢复：直接渲染，不再探测", async () => {
    const { page, calls } = loadPage({ page: "brain", hasSession: true, userId: "u1" });
    page.onShow();
    await flush();
    await flush();

    expect(calls.me).toBe(0);
    expect(page.data.loading).toBe(false);
  });
});
