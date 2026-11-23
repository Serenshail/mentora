import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import { join } from "path";

/* ============ day 页直达（收藏/分享/历史路径）必须有会话恢复守卫（回归锁） ============
 * 事故链（miniprogram/pages/day/day.js onShow 修复前）：
 *  book.js / council.js 的 onShow 都走 sessionGuard.ensure（注释明说「收藏/分享
 *  直达时 store 还没恢复」），app.js 也把 day 列入恢复后补刷的页面，唯独 day 页
 *  onShow 直接 render()。冷启动直达 day 页时 store.userId 尚未恢复，currentDay()
 *  返回 null，立即弹出「内容不存在——目标或学习日可能已被删除」的 wx.showModal：
 *  用户面对的其实是恢复中的 loading 态却被要求在「返回/留在此页」间做决定，
 *  探测成功前还停留在无数据的假错误页。
 *
 * 修复：与 book/council 同一守卫——恢复成功后再 render；探测失败由 session.js
 * 的「重试/暂不」模态兜底，不再误报「内容不存在」。
 * 本测试真执行页面与守卫模块（注入 require/wx/Page，store/api 打桩）。 */

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

function setPath(obj: Dict, path: string, value: unknown) {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur: Dict = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const nextIsIndex = /^\d+$/.test(parts[i + 1]!);
    if (cur[k] === undefined || cur[k] === null) cur[k] = nextIsIndex ? [] : {};
    cur = cur[k] as Dict;
  }
  cur[parts[parts.length - 1]!] = value;
}

function seedGoal() {
  return {
    id: "g1",
    topic: "测试目标",
    status: "active",
    plan: {
      phases: [{ id: "p1", dayIds: ["d1"] }],
      days: {
        d1: {
          id: "d1",
          phaseId: "p1",
          title: "第一天",
          status: "active",
          attempts: 0,
          stub: false,
          pendingUnlock: false,
          knowledgePoints: [],
          resources: [],
          acceptance: [],
          qa: [],
        },
      },
    },
  };
}

function loadDay(opts: { hasSession: boolean; userId?: string | null; goal?: Dict | null }) {
  const calls = { reLaunch: [] as string[], me: 0, modal: 0, onLogin: 0 };

  const store: any = {
    state: {
      userId: opts.userId ?? null,
      // userId 预置（从列表页正常进入）时本地缓存已加载，目标直接可见
      goals: opts.userId
        ? [opts.goal === undefined ? seedGoal() : opts.goal].filter(Boolean)
        : [],
      sessions: [],
      knowledge: [],
      books: [],
    },
    goalById(id: string) {
      return store.state.goals.find((g: Dict) => g.id === id) || null;
    },
    onLogin(userId: string) {
      calls.onLogin += 1;
      store.state.userId = userId;
      // 真实 store 在这里 loadLocal：恢复后应有数据
      store.state.goals = [opts.goal === undefined ? seedGoal() : opts.goal].filter(Boolean);
      return Promise.resolve("pulled");
    },
    pullIfSafe: () => Promise.resolve("skip"),
  };

  const api = {
    hasSession: () => opts.hasSession,
    me: () => {
      calls.me += 1;
      return Promise.resolve({ user: { userId: "u1", name: "回访用户" } });
    },
    clearSession: () => {},
  };

  const g = globalThis as unknown as Dict;
  g.wx = {
    reLaunch: (o: { url: string }) => calls.reLaunch.push(o.url),
    showModal: (o: any) => {
      calls.modal += 1;
      // 记录模态标题，回归锁要区分「内容不存在」误报与 session.js 的失败模态
      (calls as any).modalTitle = o && o.title;
    },
    showToast: () => {},
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    navigateBack: () => {},
    setClipboardData: () => {},
    createSelectorQuery: () => {
      throw new Error("not needed in this test");
    },
    pageScrollTo: () => {},
  };
  g.getApp = () => ({ globalData: { user: null } });

  const utils = join(ROOT, "miniprogram/utils");
  const cache = require_.cache as unknown as Record<string, unknown>;
  const put = (file: string, exports: unknown) => {
    const p = join(utils, file);
    cache[p] = { id: p, filename: p, loaded: true, exports } as unknown;
  };
  put("store.js", store);
  put("api.js", api);
  // day.js 只用到这几个 util 面；schema/grade/mastery 保持真实（render 不触网）

  const pagePath = join(ROOT, "miniprogram/pages/day/day.js");
  delete cache[pagePath];
  delete cache[join(utils, "session.js")]; // 探测去重状态是模块级的，每个用例重置
  let captured: unknown = null;
  g.Page = (cfg: unknown) => {
    captured = cfg;
  };
  require_(pagePath);
  if (!captured) throw new Error("day.js 未调用 Page()");

  const page: any = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify((captured as any).data));
  page.setData = (patch: Dict) => {
    for (const k of Object.keys(patch)) setPath(page.data, k, patch[k]);
  };
  page.data.goalId = "g1";
  page.data.dayId = "d1";
  return { page, calls, store };
}

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mp-day-session-guard: 直达 day 页不得把恢复中误报成「内容不存在」", () => {
  it("冷启动直达（有 cookie、userId 未恢复）：探测完成前不弹「内容不存在」，恢复后照常渲染", async () => {
    const { page, calls } = loadDay({ hasSession: true });

    // onShow 立即返回（探测在途）——旧实现在这里同步 render 并弹「内容不存在」
    page.onShow();
    expect(calls.modal).toBe(0); // 恢复中不许误报
    expect(page.data.day).toBeNull();

    await flush();

    expect(calls.me).toBe(1);
    expect(calls.onLogin).toBe(1);
    expect(calls.modal).toBe(0); // 探测成功后也不弹
    expect((page.data.day as Dict).title).toBe("第一天"); // 恢复后的数据已渲染
    expect(calls.reLaunch).toEqual([]); // cookie 有效时不许踢去登录页
  });

  it("userId 已恢复（从列表页正常进入）：同步渲染，行为不回退", () => {
    const { page, calls } = loadDay({ hasSession: true, userId: "u1" });

    page.onShow();
    expect(calls.me).toBe(0); // 不白发探测
    expect((page.data.day as Dict).title).toBe("第一天");
    expect(calls.modal).toBe(0);
  });

  it("目标真的不存在（恢复完成、目标已删）：仍弹「内容不存在」模态（兜底未被削弱）", async () => {
    const { page, calls } = loadDay({ hasSession: true, goal: null });

    page.onShow();
    await flush();

    expect(calls.onLogin).toBe(1);
    expect(calls.modal).toBe(1);
    expect((calls as any).modalTitle).toBe("内容不存在");
    expect(page.data.day).toBeNull();
  });

  it("没有 cookie：明确未登录，回登录页（与其他页同一守卫语义）", () => {
    const { page, calls } = loadDay({ hasSession: false });

    page.onShow();
    expect(calls.reLaunch).toEqual(["/pages/login/login"]);
    expect(calls.me).toBe(0);
  });
});
