import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序目标页：render 不得重置用户手动展开/收起的阶段 ============
 * 事故链（pages/goal/goal.js render）：
 *   render 每次 onShow（含从 day 页返回）与 genCatalog 完成后都会重跑，旧实现
 *   每次都从头推导「首个未完成阶段展开」并把结果写进新的 phases 数组；
 *   而 togglePhase 只改页面 data、不进 store。可观察行为：展开阶段 3 → 点进
 *   某天学习 → 返回 → 阶段 3 又被收起、默认阶段重新弹开；生成目录后所有手动
 *   折叠状态同样归零。
 * 修法：重建 phases 时按 phase id 沿用既有 open 值，只有新出现的阶段才做默认展开。
 *
 * 本测试真执行 goal.js（stub wx/Page + store.state）。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

let store: any;
let pageCfg: any;

function installWxStub() {
  const g = globalThis as unknown as Dict;
  g.wx = {
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: () => {},
    navigateTo: () => {},
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
  };
}

function loadGoalPage() {
  const utils = join(ROOT, "miniprogram/utils");
  const cache = requireCjs.cache as unknown as Record<string, unknown>;
  for (const f of ["store.js", "util.js", "api.js", "mastery.js"]) delete cache[join(utils, f)];
  store = requireCjs(join(utils, "store.js"));
  cache[join(utils, "chat.js")] = {
    id: "chat",
    filename: "chat",
    loaded: true,
    exports: { streamChat: () => Promise.resolve(""), extractJson: () => ({}) },
  } as unknown;
  cache[join(utils, "schema.js")] = {
    id: "schema",
    filename: "schema",
    loaded: true,
    exports: { buildPhaseCtx: () => ({ ctx: "", maxDays: 3 }) },
  } as unknown;

  const pagePath = join(ROOT, "miniprogram/pages/goal/goal.js");
  delete cache[pagePath];
  let captured: any = null;
  (globalThis as unknown as Dict).Page = (cfg: any) => {
    captured = cfg;
  };
  requireCjs(pagePath);
  if (!captured) throw new Error("goal.js 未调用 Page()");
  pageCfg = captured;
}

function makePage(): any {
  const page = Object.assign({}, pageCfg);
  page.data = JSON.parse(JSON.stringify(pageCfg.data));
  // 支持 setData 的路径写法 phases[0].open（togglePhase 用的就是它）
  page.setData = function (patch: Dict) {
    for (const k of Object.keys(patch)) {
      const m = /^phases\[(\d+)\]\.(\w+)$/.exec(k);
      if (m) this.data.phases[Number(m[1])][m[2]] = patch[k];
      else this.data[k] = patch[k];
    }
  };
  return page;
}

function seedGoal() {
  store.state.goals = [
    {
      id: "g1",
      topic: "测试目标",
      status: "active",
      plan: {
        summary: "",
        phases: [
          { id: "p1", title: "P1", status: "passed", dayIds: ["d1"] },
          { id: "p2", title: "P2", status: "active", dayIds: ["d2"] },
          { id: "p3", title: "P3", status: "locked", dayIds: ["d3"] },
        ],
        days: {
          d1: { id: "d1", title: "D1", status: "passed", knowledgePoints: [] },
          d2: { id: "d2", title: "D2", status: "active", knowledgePoints: [] },
          d3: { id: "d3", title: "D3", status: "locked", knowledgePoints: [] },
        },
      },
    },
  ];
}

const openMap = (page: any) =>
  Object.fromEntries(page.data.phases.map((p: any) => [p.id, Boolean(p.open)]));

beforeEach(() => {
  installWxStub();
  loadGoalPage();
  seedGoal();
});

describe("mp-goal-collapse: 折叠态跨 render 保留", () => {
  it("首次进入：首个未完成阶段（p2）默认展开", () => {
    const page = makePage();
    page.onLoad({ goalId: "g1" });
    page.onShow();
    expect(openMap(page)).toEqual({ p1: false, p2: true, p3: false });
  });

  it("手动展开 p3 后再次 onShow（从 day 页返回）：p3 仍展开、p2 不再被重新弹开", () => {
    const page = makePage();
    page.onLoad({ goalId: "g1" });
    page.onShow();

    page.togglePhase({ currentTarget: { dataset: { idx: 2 } } }); // 展开 p3
    page.togglePhase({ currentTarget: { dataset: { idx: 1 } } }); // 收起 p2
    expect(openMap(page)).toEqual({ p1: false, p2: false, p3: true });

    page.onShow(); // 从 day 页返回
    expect(openMap(page)).toEqual({ p1: false, p2: false, p3: true });
  });

  it("全部收起后再次 onShow：仍保持全部收起（不被默认展开推导覆盖）", () => {
    const page = makePage();
    page.onLoad({ goalId: "g1" });
    page.onShow();
    page.togglePhase({ currentTarget: { dataset: { idx: 1 } } });
    expect(openMap(page)).toEqual({ p1: false, p2: false, p3: false });

    page.onShow();
    expect(openMap(page)).toEqual({ p1: false, p2: false, p3: false });
  });
});
