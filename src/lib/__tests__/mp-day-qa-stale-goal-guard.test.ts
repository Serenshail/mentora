import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 day 页「答疑」目标被删后的收口回归锁 ============
 * 事故链（FIX heavy-f81-dayjs-1）：sendQa 的完成回调里重取 goal 后直接
 * `util.clone(g2.plan)`。答疑流 10-60s+，期间他端删除目标 → adoptCloud 整体
 * 替换 goals → goalById 返回 null → TypeError。异常被链尾 catch 吞成 qaFail，
 * 而 qaFail 开头 `if (!g || ...) return;` 直接返回——用户消息已在发送时入库，
 * 回复却既没落库也没有任何 toast，用户视角是"提问后永远没有回答"。
 * 同类守卫在 council.js sendSingle 与 day.js saveLesson 都有，这里是漏网。
 *
 * 修复：完成回调写前重取并判空（显式 toast）；qaFail 的早退分支同样给出可见交代。
 *
 * 这里不写源码扫描，而是把真实 CommonJS 页面模块加载进来跑：stub 掉 wx /
 * Page / chat.streamChat，用 store.state 直接构造"流中他端删目标"的场景。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();

interface QaMsg {
  id: string;
  role: string;
  content: string;
  failed?: boolean;
  at: string;
}

interface MpDay {
  id: string;
  phaseId: string;
  title: string;
  status: string;
  knowledgePoints: { text: string }[];
  qa: QaMsg[];
}

interface MpGoal {
  id: string;
  topic: string;
  status: string;
  learnerProfile: unknown[];
  plan: {
    phases: { id: string; dayIds: string[] }[];
    days: Record<string, MpDay>;
  };
}

interface StoreMod {
  state: { goals: MpGoal[] };
}

interface ChatMod {
  streamChat: (opts: unknown) => Promise<string>;
}

interface PageCtx {
  data: Record<string, unknown> & { goalId?: string; dayId?: string; qaInput?: string };
  setData: (patch: Record<string, unknown>) => void;
  sendQa: () => void;
}

type PageConfig = PageCtx & Record<string, unknown>;

let toasts: string[] = [];
let pageCfg: PageConfig;
let store: StoreMod;
let chat: ChatMod;

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
  // day.js 每次重新加载以拿到干净的 Page 配置与页面级缓存。
  if (!store) store = requireCjs(join(ROOT, "miniprogram/utils/store.js")) as StoreMod;
  if (!chat) chat = requireCjs(join(ROOT, "miniprogram/utils/chat.js")) as ChatMod;
  const dayPath = requireCjs.resolve(join(ROOT, "miniprogram/pages/day/day.js"));
  delete requireCjs.cache[dayPath];
  let captured: PageConfig | null = null;
  (globalThis as unknown as Record<string, unknown>).Page = (cfg: PageConfig) => {
    captured = cfg;
  };
  requireCjs(dayPath);
  if (!captured) throw new Error("day.js 未调用 Page()");
  pageCfg = captured;
}

/** 建一个最小可用的目标：一个 phase、一天 d1（默认 active）。 */
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
            qa: [],
          },
        },
      },
    },
  ];
}

function day0(): MpDay {
  return store.state.goals[0].plan.days.d1;
}

function makePage(): PageCtx {
  const page = Object.assign({}, pageCfg) as PageCtx;
  page.data = JSON.parse(JSON.stringify(pageCfg.data)) as PageCtx["data"];
  page.setData = function (patch: Record<string, unknown>) {
    Object.assign(this.data, patch);
  };
  page.data.goalId = "g1";
  page.data.dayId = "d1";
  page.data.qaInput = "这个概念为什么成立？";
  return page;
}

/** 只跑微任务，不用真实定时器（store 的写盘/推送防抖在这里无关）。 */
async function settle(times = 12) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

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

describe("mp-day-qa-stale-goal: 答疑流中途目标被删", () => {
  it("成功路径：目标还在时回答照常入库并渲染（守卫没有误伤正常流程）", async () => {
    chat.streamChat = () => Promise.resolve("这是回答");
    const page = makePage();
    page.sendQa();
    await settle();

    const day = day0();
    expect(day.qa.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(day.qa[1].content).toBe("这是回答");
    expect(page.data.qaBusy).toBe(false);
    expect(page.data.qaStreamBlocks).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it("目标在流中被他端删除：不抛异常、不静默，给出可见提示并复位状态", async () => {
    chat.streamChat = () => {
      // 模拟答疑流跑着跑着，他端删目标后 adoptCloud 整体替换 goals
      store.state.goals = [];
      return Promise.resolve("这段回答已经无处可落");
    };
    const page = makePage();
    page.sendQa();
    await settle();

    expect(page.data.qaBusy).toBe(false);
    expect(page.data.qaStreamBlocks).toEqual([]);
    // 关键断言：用户必须看到"没保存"的交代，而不是永远等一个不会来的回答
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain("已被删除");
  });

  it("目标还在但学习日被删（days 缺键）：同样走可见提示，不落进 qaFail 静默 return", async () => {
    chat.streamChat = () => {
      store.state.goals[0].plan.days = {};
      return Promise.resolve("回答");
    };
    const page = makePage();
    page.sendQa();
    await settle();

    expect(page.data.qaBusy).toBe(false);
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain("已被删除");
  });

  it("流失败且目标已删：qaFail 不得静默 return，失败也要可见", async () => {
    chat.streamChat = () => {
      store.state.goals = [];
      return Promise.reject(new Error("网络中断"));
    };
    const page = makePage();
    page.sendQa();
    await settle();

    expect(page.data.qaBusy).toBe(false);
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain("已被删除");
  });

  it("流失败但目标还在：仍按原逻辑落一条 failed 标记（失败分支未被削弱）", async () => {
    chat.streamChat = () => Promise.reject(new Error("网络中断"));
    const page = makePage();
    page.sendQa();
    await settle();

    const qa = day0().qa;
    expect(qa.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(qa[1].failed).toBe(true);
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain("网络中断");
  });
});
