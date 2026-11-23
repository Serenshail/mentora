import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ store 层单日写路径的布尔返回值契约（回归锁） ============
 * 事故链（miniprogram/pages/day/day.js 修复前）：
 *  sendQa（用户消息/成功回答/失败标记三处）、saveLesson 各自手写
 *  util.clone(goal.plan)→改→goal.plan=plan→markDirtyPublic 的旁路写法——
 *  「写路径归数据层」的纪律在页面复制三份后开始漏改（expandDetail 报成功前
 *  不核验写入），且旁路永远拿不到写入失败信号，只能靠每个调用点自觉重查
 *  goalById（sendQa 成功路径的收口正是为此补的）。
 *
 * 修复：新增 store.setDayQa / store.saveDayLesson（与 setDayStatus /
 * completeTransfer 同一签名纪律：落点缺失时静默空操作并返回 false），
 * day.js 三处旁路写全部收口。setDayDetail 同时补上布尔返回值。
 * 本测试钉住数据层契约本身；页面层的可见反馈由 mp-day-*-stale-goal 系列锁住。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();

let store: any;

function installWxStub() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: () => {},
    showModal: () => {},
    setClipboardData: () => {},
    request: () => {
      throw new Error("network disabled in test");
    },
  };
}

function seedGoal() {
  store.state.goals = [
    {
      id: "g1",
      topic: "测试目标",
      status: "active",
      learnerProfile: [],
      plan: {
        phases: [{ id: "p1", dayIds: ["d1"], estDays: 1 }],
        days: {
          d1: {
            id: "d1",
            phaseId: "p1",
            title: "第一天",
            stub: true,
            status: "active",
            attempts: 0,
            knowledgePoints: [{ id: "kp1", text: "kp1" }],
            resources: [],
            acceptance: [],
            qa: [{ id: "m0", role: "user", content: "已有提问" }],
          },
        },
      },
    },
  ];
}

beforeEach(() => {
  vi.useFakeTimers();
  installWxStub();
  if (!store) {
    store = requireCjs(join(ROOT, "miniprogram/utils/store.js"));
  }
  seedGoal();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  if (store) store.state.goals = [];
});

describe("store.setDayQa：答疑整体落库的布尔契约", () => {
  it("目标与学习日都在：写入整组 qa 并返回 true", () => {
    const qa = [
      { id: "m0", role: "user", content: "已有提问" },
      { id: "m1", role: "assistant", content: "回答" },
    ];
    expect(store.setDayQa("g1", "d1", qa)).toBe(true);
    expect(store.state.goals[0].plan.days.d1.qa).toEqual(qa);
  });

  it("学习日被删（days 缺键）：静默空操作并返回 false，不抛异常", () => {
    store.state.goals[0].plan.days = {};
    expect(store.setDayQa("g1", "d1", [])).toBe(false);
  });

  it("目标被整体替换/删除：返回 false", () => {
    store.state.goals = [];
    expect(store.setDayQa("g1", "d1", [])).toBe(false);
  });

  it("目标 id 不存在：返回 false", () => {
    expect(store.setDayQa("gx", "d1", [])).toBe(false);
  });
});

describe("store.saveDayLesson：讲义落库的布尔契约", () => {
  it("落点都在：写入讲义并返回 true", () => {
    expect(store.saveDayLesson("g1", "d1", "# 讲义正文")).toBe(true);
    expect(store.state.goals[0].plan.days.d1.lesson).toBe("# 讲义正文");
  });

  it("落点消失（goal 缺失 / day 缺键）：返回 false", () => {
    expect(store.saveDayLesson("gx", "d1", "x")).toBe(false);
    store.state.goals[0].plan.days = {};
    expect(store.saveDayLesson("g1", "d1", "x")).toBe(false);
  });
});

describe("store.setDayDetail：补齐「是否真的写入」返回值", () => {
  it("落点都在：覆盖细节、解除 stub、保留运行态，返回 true", () => {
    const detail = {
      title: "第一天（展开）",
      knowledgePoints: [{ text: "kp-展开" }],
      resources: [],
      method: "费曼法",
      acceptance: [{ kind: "explain", question: "解释 kp-展开" }],
    };
    const day = store.state.goals[0].plan.days.d1;
    day.lesson = "已有讲义";
    expect(store.setDayDetail("g1", "p1", "d1", detail)).toBe(true);
    const after = store.state.goals[0].plan.days.d1;
    expect(after.stub).toBe(false);
    expect(after.title).toBe("第一天（展开）");
    expect(after.lesson).toBe("已有讲义"); // 运行态原样保留
    expect(after.status).toBe("active");
  });

  it("phase/day 找不到：返回 false（此前是裸 return，调用方无从核验）", () => {
    expect(store.setDayDetail("g1", "px", "d1", {})).toBe(false);
    expect(store.setDayDetail("g1", "p1", "dx", {})).toBe(false);
    store.state.goals = [];
    expect(store.setDayDetail("g1", "p1", "d1", {})).toBe(false);
  });
});
