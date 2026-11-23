import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import { join } from "path";

/* ============ 圆桌串行链必须能被真正中止（回归锁） ============
 * 事故链（miniprogram/pages/council/council.js 修复前）：
 *  runSequential 每席的链是 `.catch(失败也继续).then(() => runSequential(i+1))`，
 *  没有任何「已中止」标志；onUnload 注册的 _cancelTake 只覆盖最后注册的当前在途席位。
 *  于是 ① 即使走 reLaunch 触发 onUnload，也只中止当前一席，后续席位与主持人纪要
 *  仍会逐个发起——每次都是真实计费的 AI 调用；
 *  ② 更常见的中止手势（聊天态左上角返回箭头）走 nav-bar 的 wx.switchTab，
 *  tab 页切换不触发 onUnload，整轮照跑。
 * 修法：置 _rtAborted 标志，runSequential 每步与「主持人阶段」入口自检；
 *  nav-bar 返回前 triggerEvent("back")，council 在导航前先中止。
 * 本测试真执行页面模块（注入 require/wx/Page），按调用次数与 busy 状态断言。 */

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;
type StreamOpts = { args: { mode: string } };

type CouncilPage = {
  data: Dict & { busy: boolean; rtPhase: string; rtSeats: unknown[] };
  setData: (patch: Dict) => void;
  openSession: (id: string) => void;
  send: () => void;
  onUnload: () => void;
  onNavBack: () => void;
};

type StoreLike = {
  state: { sessions: unknown[] };
  addSession: (s: Dict) => void;
  sessionById: (id: string) => { messages: Dict[] } | null;
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

function makePage(cfg: unknown): CouncilPage {
  const source = cfg as { data: Dict } & Dict;
  const page = Object.assign({}, source) as unknown as CouncilPage;
  page.data = JSON.parse(JSON.stringify(source.data)) as CouncilPage["data"];
  page.setData = (patch: Dict) => {
    for (const k of Object.keys(patch)) setPath(page.data, k, patch[k]);
  };
  return page;
}

function loadCouncil(streamChat: (opts: StreamOpts) => Promise<string>) {
  const storage: Dict = {};
  const g = globalThis as unknown as Dict;
  g.wx = {
    getStorageSync: (k: string) => storage[k],
    setStorageSync: (k: string, v: unknown) => {
      storage[k] = v;
    },
    removeStorageSync: (k: string) => {
      delete storage[k];
    },
    showToast: () => {},
    setClipboardData: () => {},
    showModal: () => {},
    reLaunch: () => {},
  };
  g.getApp = () => ({ globalData: { user: { userId: "u1" } } });

  let captured: unknown = null;
  g.Page = (cfg: unknown) => {
    captured = cfg;
  };

  const storePath = join(ROOT, "miniprogram/utils/store.js");
  const chatPath = join(ROOT, "miniprogram/utils/chat.js");
  const seatsPath = join(ROOT, "miniprogram/utils/seats.js");
  const sessionPath = join(ROOT, "miniprogram/utils/session.js");
  const pagePath = join(ROOT, "miniprogram/pages/council/council.js");
  for (const p of [storePath, pagePath, seatsPath, sessionPath]) {
    delete require_.cache[p];
  }
  require_.cache[chatPath] = {
    id: chatPath,
    filename: chatPath,
    loaded: true,
    exports: { streamChat, extractJson: () => ({}) },
  } as unknown as NodeModule;

  require_(pagePath);
  const store = require_(storePath) as StoreLike;
  return { page: makePage(captured), store };
}

function openRoundtable(store: StoreLike, page: CouncilPage) {
  const sess = {
    id: "s_rt_abort",
    personaId: "roundtable",
    participants: ["naval", "jobs", "taleb"],
    title: "圆桌(3人)",
    messages: [],
    createdAt: new Date().toISOString(),
  };
  store.addSession(sess);
  page.openSession(sess.id);
}

describe("council.js 圆桌：中止必须能停掉整条串行链", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("onUnload（离开页面）后不再发起后续席位与主持人", async () => {
    const modes: string[] = [];
    const { page, store } = loadCouncil(async (opts: StreamOpts) => {
      modes.push(opts.args.mode);
      if (opts.args.mode === "take" && modes.length === 1) {
        // 第一席在途时页面被销毁（登出/切后端 reLaunch 触发 onUnload）
        page.onUnload();
        throw new Error("生成已停止");
      }
      return "席位发言";
    });
    openRoundtable(store, page);

    page.setData({ input: "要不要换工作" });
    page.send();

    await vi.waitFor(() => expect(page.data.busy).toBe(false), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 20));

    // 只剩第一席那一次调用：后续 2 席与 host 都没发起
    expect(modes).toEqual(["take"]);
    expect(page.data.rtPhase).toBe("");
  });

  it("返回箭头（tab 页 switchTab，不触发 onUnload）同样中止整条链", async () => {
    const modes: string[] = [];
    const { page, store } = loadCouncil(async (opts: StreamOpts) => {
      modes.push(opts.args.mode);
      if (opts.args.mode === "take" && modes.length === 1) {
        // 用户点左上角返回：nav-bar 先 triggerEvent("back") 再 switchTab
        page.onNavBack();
        throw new Error("生成已停止");
      }
      return "席位发言";
    });
    openRoundtable(store, page);

    page.setData({ input: "要不要换工作" });
    page.send();

    await vi.waitFor(() => expect(page.data.busy).toBe(false), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 20));

    expect(modes).toEqual(["take"]);
    expect(page.data.busy).toBe(false);
  });

  it("未中止时照常跑完 3 席 + 主持人（回归：标志不能误伤正常流程）", async () => {
    const modes: string[] = [];
    const { page, store } = loadCouncil(async (opts: StreamOpts) => {
      modes.push(opts.args.mode);
      return opts.args.mode === "host" ? "纪要正文" : "席位发言";
    });
    openRoundtable(store, page);

    page.setData({ input: "要不要换工作" });
    page.send();

    await vi.waitFor(() => expect(page.data.busy).toBe(false), { timeout: 3000 });

    expect(modes).toEqual(["take", "take", "take", "host"]);
    const last = (page.data as Dict).chatView as Dict[];
    expect(JSON.stringify(last[last.length - 1])).toContain("圆桌纪要");
  });
});
