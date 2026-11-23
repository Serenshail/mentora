import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 首页进度不得统计孤儿天（回归锁） ============
 * 事故链（miniprogram/pages/overview/overview.js render 修复前）：
 *  进度用 Object.keys(plan.days) 全量统计分母；而 goal.js render 与 Web 学习页
 *  （learn/[id]）只统计 phase 目录/dayIds 引用到的天。Web 端阶段重排的纪律是
 *  「旧天对象绝不删除」（phase-regen.ts 头注释），重排后未被新目录沿用的旧天
 *  仍留在 plan.days 里成为孤儿天，云端快照同步后这些天（含其 passed/skipped
 *  状态）会被 overview 计入——首页进度百分比与目标详情页对不上。
 *
 * 修复：进度统计与 active 天查找都改走 util.phaseDayIds 的唯一判定
 * （catalog 优先、老目标回落 dayIds）——这同时收掉了「直接读 ph.dayIds」
 * 的第 4 份口径变体（util.js:141 注释记载的三份副本之外的新增份）。
 *
 * 本测试 stub store（真实 util.js 参与判定），真执行 overview.js 页面模块。 */

const requireCjs = createRequire(import.meta.url);
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

function dayOf(id: string, status: string): Dict {
  return { id, phaseId: "p1", title: "天" + id, status, knowledgePoints: [], qa: [] };
}

function loadOverview(goal: Dict) {
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: () => {},
    showModal: () => {},
  };
  g.getApp = () => ({ globalData: { user: { userId: "u1", name: "测试" } } });

  const utils = join(ROOT, "miniprogram/utils");
  const cache = requireCjs.cache as unknown as Record<string, unknown>;
  const put = (file: string, exports: unknown) => {
    const p = join(utils, file);
    cache[p] = { id: p, filename: p, loaded: true, exports } as unknown;
  };
  // store stub：render 只读 state/activeGoal/dueReviews；util 必须是真实实现
  // （口径判定 util.phaseDayIds 正是本次修复的对象）。
  const store = {
    state: { userId: "u1", goals: [goal], knowledge: [], books: [] },
    activeGoal: () => goal,
    dueReviews: () => [],
    onSyncStatus: () => () => {},
  };
  put("store.js", store);
  put("api.js", { hasSession: () => true, me: () => Promise.resolve({ user: null }) });

  const pagePath = join(ROOT, "miniprogram/pages/overview/overview.js");
  delete cache[pagePath];
  delete cache[join(utils, "session.js")];
  let captured: any = null;
  g.Page = (cfg: unknown) => {
    captured = cfg;
  };
  requireCjs(pagePath);
  if (!captured) throw new Error("overview.js 未调用 Page()");

  const page: any = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data));
  page.setData = (patch: Dict) => {
    for (const k of Object.keys(patch)) setPath(page.data, k, patch[k]);
  };
  page.onLoad();
  return page;
}

let page: any;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("overview 进度口径：孤儿天不进分母", () => {
  it("plan.days 里的孤儿天不计入 total/done，进度与目标详情页一致", () => {
    const goal = {
      id: "g1",
      topic: "测试目标",
      direction: "",
      status: "active",
      plan: {
        phases: [
          {
            id: "p1",
            status: "active",
            // 目录只沿用 d1/d2：d3 是重排前的旧天（Web 端重排绝不删除旧天对象）
            dayIds: ["d1", "d2"],
            catalog: [
              { id: "d1", title: "天d1", knowledgePoints: [] },
              { id: "d2", title: "天d2", knowledgePoints: [] },
            ],
          },
        ],
        days: {
          d1: dayOf("d1", "passed"),
          d2: dayOf("d2", "active"),
          d3: dayOf("d3", "skipped"), // 孤儿天：旧实现会把它计入 total 并把 skipped 计入 done
        },
      },
    };
    page = loadOverview(goal);
    page.render();

    expect(page.data.goal.total).toBe(2); // 不是 3
    expect(page.data.goal.done).toBe(1); // skipped 孤儿天不计入
    expect(page.data.goal.progress).toBe(50); // 不是 2/3≈67
  });

  it("active 天查找同样走 util.phaseDayIds：catalog 与 dayIds 分叉时以 catalog 为准", () => {
    const goal = {
      id: "g1",
      topic: "测试目标",
      direction: "",
      status: "active",
      plan: {
        phases: [
          {
            id: "p1",
            status: "active",
            // 假想的分叉：catalog 只保留 d1，dayIds 还残留 d2（旧实现直接读 dayIds
            // 会把只在 dayIds 里的 d2 当作 active 天，与 goal.js 的渲染口径分裂）
            dayIds: ["d1", "d2"],
            catalog: [{ id: "d1", title: "天d1", knowledgePoints: [] }],
          },
        ],
        days: {
          d1: dayOf("d1", "active"),
          d2: dayOf("d2", "active"),
        },
      },
    };
    page = loadOverview(goal);
    page.render();

    // 目录里的 d1 才是主任务卡指向的那一天（与目标页渲染口径一致）
    expect(page.data.goal.dayId).toBe("d1");
    expect(page.data.goal.total).toBe(1);
  });

  it("老目标没有 catalog：回落 dayIds，行为与旧实现一致（不回退）", () => {
    const goal = {
      id: "g1",
      topic: "测试目标",
      direction: "",
      status: "active",
      plan: {
        phases: [{ id: "p1", status: "active", dayIds: ["d1", "d2"] }],
        days: {
          d1: dayOf("d1", "passed"),
          d2: dayOf("d2", "skipped"),
        },
      },
    };
    page = loadOverview(goal);
    page.render();

    expect(page.data.goal.total).toBe(2);
    expect(page.data.goal.done).toBe(2);
    expect(page.data.goal.progress).toBe(100);
    expect(page.data.goal.dayId).toBe(""); // 没有 active 天
  });
});
