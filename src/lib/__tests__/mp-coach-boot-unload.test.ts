import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import { join } from "path";

/* ============ 学习教练页：初始化崩溃 / 卸载纪律 / 定时器 / 快照上限（回归锁） ============
 * 事故链（miniprogram/pages/coach/coach.js 修复前）：
 *  1. this.messages 从未初始化（data.messages 是另一份视图数据，微信框架不会把
 *     data 镜像到实例上），onLoad 首句 appendAssistant → undefined.concat 抛
 *     TypeError——send/confirmCard 同样依赖它，引导→目标卡→总纲要整条链路崩溃。
 *  2. 流式回调缺 _unloaded 卸载纪律（review.js:99-122 早已建立）：AI 流在途时离开
 *     页面，catch 仍对已销毁页面 appendAssistant（setData），并把「生成已停止」
 *     toast 弹到用户刚到达的目标页面。
 *  3. 总纲要成功后 600ms 的 wx.redirectTo 定时器不随页面卸载取消——窗口内按返回
 *     的用户会被强拉回 goal 页。
 *  4. goal.intakeTranscript 无上限写入：goal 随 serialize() 进云端全量快照
 *     （服务端 4.2MB 硬拒）与 setStorageSync 单 key 缓存（1MB 上限）——重蹈
 *     quizLog/消息数组已修过的「快照超限 → 静默停写」覆辙。
 * 本测试真执行页面模块（require-cache 注入桩），按行为断言。 */

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

const flush = () => new Promise((r) => setTimeout(r, 0));

type PlanShape = { phases: { title: string; outcome: string }[]; summary: string };

let streamBehavior: { kind: "resolve"; value: string } | { kind: "reject"; error: Error };
let toasts: string[];
let redirects: string[];

function loadCoach() {
  const storage: Dict = {};
  const g = globalThis as unknown as Dict;
  toasts = [];
  redirects = [];

  g.wx = {
    getStorageSync: (k: string) => storage[k],
    setStorageSync: (k: string, v: unknown) => {
      storage[k] = v;
    },
    removeStorageSync: (k: string) => {
      delete storage[k];
    },
    nextTick: (fn: () => void) => fn(),
    showToast: (o: { title: string }) => toasts.push(o.title),
    redirectTo: (o: { url: string }) => redirects.push(o.url),
    navigateBack: () => {},
  };
  g.getApp = () => ({ globalData: { user: { userId: "u1", name: "学员" } } });

  const utils = join(ROOT, "miniprogram/utils");
  const cache = require_.cache as unknown as Record<string, unknown>;
  for (const f of ["store.js", "util.js", "api.js"]) delete cache[join(utils, f)];

  const store = require_(join(utils, "store.js")) as any;
  cache[join(utils, "md.js")] = {
    id: "md",
    filename: "md",
    loaded: true,
    exports: {
      parse: (s: string) => ({ blocks: [{ t: "p", text: s }], links: [] }),
      plain: (s: string) => s,
    },
  } as unknown;
  cache[join(utils, "chat.js")] = {
    id: "chat",
    filename: "chat",
    loaded: true,
    exports: {
      streamChat: (opts: { register: (cancel: () => void) => void }) => {
        opts.register(() => {});
        if (streamBehavior.kind === "resolve") return Promise.resolve(streamBehavior.value);
        return Promise.reject(streamBehavior.error);
      },
      extractJson: () => ({}),
    },
  } as unknown;
  cache[join(utils, "stream-view.js")] = {
    id: "sv",
    filename: "sv",
    loaded: true,
    exports: {
      createStreamRenderer: () => ({ push: () => {}, flush: () => {}, cancel: () => {} }),
    },
  } as unknown;
  cache[join(utils, "schema.js")] = {
    id: "schema",
    filename: "schema",
    loaded: true,
    exports: {
      splitGoalReply: (content: string) =>
        content.indexOf("【目标卡】") >= 0
          ? { card: { topic: "话题" }, prose: "目标已经清楚了。" }
          : { card: null },
      masterDraftToPlan: (): PlanShape => ({
        phases: [{ title: "阶段一", outcome: "产出" }],
        summary: "总纲",
      }),
    },
  } as unknown;

  let captured: unknown = null;
  g.Page = (cfg: unknown) => {
    captured = cfg;
  };
  const pagePath = join(ROOT, "miniprogram/pages/coach/coach.js");
  delete cache[pagePath];
  require_(pagePath);

  const cfg = captured as { data: Dict } & Dict;
  const page: any = Object.assign({}, cfg);
  page.data = JSON.parse(JSON.stringify(cfg.data));
  page.setData = (patch: Dict) => {
    Object.assign(page.data, patch);
  };
  return { page, store };
}

describe("onLoad 初始化（此前 undefined.concat 直接崩溃）", () => {
  beforeEach(() => {
    vi.useRealTimers();
    streamBehavior = { kind: "resolve", value: "开场回复" };
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("onLoad 不抛 TypeError，首问进入实例 messages 与视图", () => {
    const { page } = loadCoach();
    expect(() => page.onLoad()).not.toThrow();
    expect(Array.isArray(page.messages)).toBe(true);
    expect(page.messages.length).toBe(1);
    expect(page.messages[0].role).toBe("assistant");
    expect(page.data.messages.length).toBe(1);
    // send 的 concat 也不再崩
    page.setData({ input: "想学系统设计" });
    expect(() => page.send()).not.toThrow();
    expect(page.messages[page.messages.length - 1].content).toBe("想学系统设计");
  });
});

describe("卸载纪律：离开页面后不再 setData / 不把 toast 弹到别的界面", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("intake 流在途离开：cancel 后 reject，不追加消息、不弹「生成已停止」", async () => {
    streamBehavior = { kind: "reject", error: new Error("生成已停止") };
    const { page } = loadCoach();
    page.onLoad();
    page.setData({ input: "想学系统设计" });
    page.send();
    page.onUnload(); // 离开页面：置 _unloaded + 取消（catch 同步排在微任务之前）
    await flush();
    await flush();

    expect(page._unloaded).toBe(true);
    expect(toasts).toEqual([]); // 旧实现会把「生成已停止」弹到用户到达的新页面
  });

  it("confirmCard 失败发生在离开之后：「可再试一次」不再弹在别的界面", async () => {
    streamBehavior = { kind: "reject", error: new Error("网络中断") };
    const { page, store } = loadCoach();
    page.onLoad();
    page._cardRaw = { topic: "话题" };
    page.confirmCard();
    page.onUnload(); // 流在途时离开
    await flush();
    await flush();

    expect(page._unloaded).toBe(true);
    expect(toasts).toEqual([]); // 旧实现弹「目标已保存，可再试一次」
    // 目标本体已同步落库（成功/失败都不丢目标）
    expect(store.state.goals.length).toBe(1);
  });
});

describe("总纲要成功后的跳转定时器", () => {
  beforeEach(() => {
    vi.useRealTimers();
    streamBehavior = { kind: "resolve", value: "plan-json" };
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未离开：600ms 后跳 goal 页一次", async () => {
    const { page, store } = loadCoach();
    page.onLoad();
    page._cardRaw = { topic: "话题" };
    page.confirmCard();
    await flush();
    expect(page._redirectTimer).toBeTruthy();
    await new Promise((r) => setTimeout(r, 700));
    expect(redirects).toHaveLength(1);
    expect(redirects[0]).toBe("/pages/goal/goal?goalId=" + store.state.goals[0].id);
    expect(toasts.some((t) => t.indexOf("计划已生成") >= 0)).toBe(true);
  }, 5000);

  it("600ms 窗口内离开：onUnload 取消定时器，不强拉回 goal 页", async () => {
    const { page, store } = loadCoach();
    page.onLoad();
    page._cardRaw = { topic: "话题" };
    page.confirmCard();
    await flush();
    page.onUnload();
    await new Promise((r) => setTimeout(r, 700));
    expect(redirects).toEqual([]);
    // 计划是已计费的产出：离开也照常落库
    expect(store.state.goals[0].plan).toBeTruthy();
  }, 5000);
});

describe("goal.intakeTranscript 上限（快照 4.2MB / 单 key 1MB 闸门）", () => {
  beforeEach(() => {
    vi.useRealTimers();
    streamBehavior = { kind: "resolve", value: "plan-json" };
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("轮数与单条长度都被截断（留最近 40 轮、单条 4000 字）", async () => {
    const { page, store } = loadCoach();
    page.onLoad();
    page.onUnload(); // 只验证落库形状，不验证 UI：提前置卸载，避免定时器挂尾
    // 模拟多轮长引导对话（60 条 × 5000 字）
    page.messages = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(5000) + "#" + i,
    }));
    page._cardRaw = { topic: "话题" };
    page.confirmCard();
    await flush();

    const goal = store.state.goals[0];
    expect(goal.intakeTranscript.length).toBe(40);
    // 保留的是最近 40 条（#20..#59）：i=20 为偶数（user）、i=59 为奇数（assistant）
    expect(goal.intakeTranscript[0].role).toBe("user");
    expect(goal.intakeTranscript[39].role).toBe("assistant");
    for (const m of goal.intakeTranscript) {
      // capMessages：单条截 4000 字 + 截断提示后缀（原尾部 #i 已被截掉）
      expect(m.content.length).toBeLessThanOrEqual(4200);
      expect(m.content.indexOf("已截断保存")).toBeGreaterThanOrEqual(0);
    }
  });
});
