import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 day 页「展开细节」对空操作报成功的回归锁 ============
 * 事故链（miniprogram/pages/day/day.js expandDetail 修复前）：
 *  store.setDayDetail 在 goal/plan 缺失或 phase/day 找不到时静默 return（无返回值），
 *  expandDetail 的 then 里不核实写是否落地就 toast「今天的计划已就绪」。生成细节
 *  的 10-30s 期间目标被他端删除（adoptCloud 替换）时，用户先看到「已就绪」，
 *  紧接着 render 弹「内容不存在」模态，反馈自相矛盾。同页 commitTransfer/forceSkip
 *  已按 store 布尔返回值收口同类问题，expandDetail 是漏网的一处。
 *
 * 修复：store.setDayDetail 返回「是否真的写入」，expandDetail 写失败时给
 * 「没能保存」的可见交代、绝不报「已就绪」。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

let toasts: string[] = [];
let pageCfg: any;
let store: any;
let chat: any;

function installWxStub() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: (o: { title: string }) => {
      toasts.push(String(o.title));
    },
    showModal: () => {},
    setClipboardData: () => {},
    request: () => {
      throw new Error("network disabled in test");
    },
  };
}

function loadPageModules() {
  if (!store) store = requireCjs(join(ROOT, "miniprogram/utils/store.js"));
  if (!chat) chat = requireCjs(join(ROOT, "miniprogram/utils/chat.js"));
  const dayPath = requireCjs.resolve(join(ROOT, "miniprogram/pages/day/day.js"));
  delete requireCjs.cache[dayPath];
  let captured: any = null;
  (globalThis as unknown as Record<string, unknown>).Page = (cfg: any) => {
    captured = cfg;
  };
  requireCjs(dayPath);
  if (!captured) throw new Error("day.js 未调用 Page()");
  pageCfg = captured;
}

/** 目录占位天（stub: true）——expandDetail 只对 stub 天工作。 */
function seedGoal() {
  store.state.goals = [
    {
      id: "g1",
      topic: "测试目标",
      status: "active",
      learnerProfile: [],
      plan: {
        phases: [
          {
            id: "p1",
            dayIds: ["d1"],
            estDays: 1,
            boundary: "",
          },
        ],
        days: {
          d1: {
            id: "d1",
            phaseId: "p1",
            title: "第一天",
            stub: true,
            status: "active",
            knowledgePoints: [{ id: "kp1", text: "kp1" }],
            resources: [],
            acceptance: [],
            qa: [],
          },
        },
      },
    },
  ];
}

function makePage() {
  const page = Object.assign({}, pageCfg);
  page.data = JSON.parse(JSON.stringify(pageCfg.data));
  page.setData = function (patch: Dict) {
    Object.assign(this.data, patch);
  };
  page.data.goalId = "g1";
  page.data.dayId = "d1";
  return page;
}

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const DETAIL_JSON = JSON.stringify({
  days: [
    {
      title: "第一天（已展开）",
      knowledgePoints: [{ text: "kp-展开" }],
      method: "费曼法",
      acceptance: [{ kind: "explain", question: "用自己的话解释 kp-展开" }],
    },
  ],
});

beforeEach(() => {
  toasts = [];
  vi.useFakeTimers();
  installWxStub();
  loadPageModules();
  seedGoal();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  if (store) store.state.goals = [];
});

describe("mp-day-expand-detail-stale-goal: 写失败不得报「已就绪」", () => {
  it("正常路径：细节落库（stub 解除）+「已就绪」toast（修复没有误伤正常流程）", async () => {
    chat.streamChat = () => Promise.resolve(DETAIL_JSON);
    const page = makePage();
    page.expandDetail();
    await settle();

    const day = store.state.goals[0].plan.days.d1;
    expect(day.stub).toBe(false);
    expect(day.title).toBe("第一天（已展开）");
    expect(page.data.detailBusy).toBe(false);
    expect(toasts).toEqual(["今天的计划已就绪"]);
  });

  it("生成期间目标被删：绝不报「已就绪」，给「没能保存」的可见交代", async () => {
    chat.streamChat = () => {
      // 模拟展开的 10-30s 里 adoptCloud 整体替换/他端删除目标
      store.state.goals = [];
      return Promise.resolve(DETAIL_JSON);
    };
    const page = makePage();
    page.expandDetail();
    await settle();

    expect(page.data.detailBusy).toBe(false);
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain("没能保存");
    expect(toasts.some((t: string) => t.indexOf("已就绪") >= 0)).toBe(false);
  });

  it("目标还在但学习日被删（days 缺键）：同样不报成功", async () => {
    chat.streamChat = () => {
      store.state.goals[0].plan.days = {};
      return Promise.resolve(DETAIL_JSON);
    };
    const page = makePage();
    page.expandDetail();
    await settle();

    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain("没能保存");
  });
});
