import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 day 页「讲义」落点消失后的收口回归锁 ============
 * 事故链（miniprogram/pages/day/day.js saveLesson 修复前）：
 *  生成讲义耗时 40-90s，期间 app.onShow→store.pullIfSafe→adoptCloud 会整体替换
 *  goals。saveLesson 的两个分支（goal/plan 缺失、plan.days 缺键）都静默 return：
 *  用户刚看着流式渲染完的讲义在成功回调后凭空消失（render 重读旧数据），既不保存
 *  也不提示。同一页 sendQa（「这条回答没能保存」）、qaFail、applyQuizResult 对
 *  完全相同的场景都有明确文案，唯独讲义路径漏掉；catch 分支「生成中断，已保留
 *  已生成的内容」还可能为一次实际未保留的结果误报。
 *
 * 修复：写路径收口在 store.saveDayLesson（返回「是否真的写入」），落点消失时
 * saveLesson 给可见交代并返回 false；doGenLesson 的 catch 只在真的保留了内容时
 * 才报「已保留」。
 *
 * 这里不写源码扫描，而是把真实 CommonJS 页面模块加载进来跑（stub wx / Page /
 * chat.streamChat，用 store.state 直接构造「流中他端删目标」的场景）。 */

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
  // store/chat 是模块级单例（内存 state），只在首个用例前加载一次；
  // day.js 每次重新加载以拿到干净的 Page 配置。
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

function seedGoal() {
  store.state.goals = [
    {
      id: "g1",
      topic: "测试目标",
      status: "active",
      learnerProfile: [],
      plan: {
        phases: [{ id: "p1", dayIds: ["d1"] }],
        days: {
          d1: {
            id: "d1",
            phaseId: "p1",
            title: "第一天",
            status: "active",
            knowledgePoints: [{ text: "kp1" }],
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

/** 只跑微任务，不依赖真实定时器（stream-view 的节流 setData 在这里无关）。 */
const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const LONG = "# 半截讲义\n\n".repeat(40); // > 200 字，doGenLesson catch 走「保留半截」分支

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

describe("mp-day-lesson-stale-goal: 讲义落点消失必须可见", () => {
  it("正常路径：讲义照常落库，不弹任何提示（修复没有误伤正常流程）", async () => {
    chat.streamChat = () => Promise.resolve("# 今天的讲义\n\n正文内容。");
    const page = makePage();
    page.doGenLesson();
    await settle();

    expect(store.state.goals[0].plan.days.d1.lesson).toContain("今天的讲义");
    expect(page.data.lessonBusy).toBe(false);
    expect(toasts).toEqual([]);
  });

  it("生成期间目标被删：讲义不落库，但必须给「没能保存」的可见交代", async () => {
    chat.streamChat = () => {
      // 模拟生成跑着跑着，他端删目标后 adoptCloud 整体替换 goals
      store.state.goals = [];
      return Promise.resolve("# 今天的讲义\n\n内容。");
    };
    const page = makePage();
    page.doGenLesson();
    await settle();

    expect(page.data.lessonBusy).toBe(false);
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain("没能保存");
  });

  it("生成中断且落点已消失：不得谎报「已保留已生成的内容」", async () => {
    chat.streamChat = (opts: any) => {
      store.state.goals = [];
      opts.onDelta(LONG);
      return Promise.reject(new Error("生成已停止"));
    };
    const page = makePage();
    page.doGenLesson();
    await settle();

    expect(toasts.some((t: string) => t.indexOf("已保留") >= 0)).toBe(false);
    expect(toasts[0]).toContain("没能保存");
    expect(page.data.lessonBusy).toBe(false);
  });

  it("生成中断但落点还在：半截内容照常保留并如实提示（原有行为不回退）", async () => {
    chat.streamChat = (opts: any) => {
      opts.onDelta(LONG);
      return Promise.reject(new Error("生成已停止"));
    };
    const page = makePage();
    page.doGenLesson();
    await settle();

    expect(store.state.goals[0].plan.days.d1.lesson).toContain("半截讲义");
    expect(toasts.some((t: string) => t.indexOf("已保留已生成的内容") >= 0)).toBe(true);
  });
});
