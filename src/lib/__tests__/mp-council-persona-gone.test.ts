import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import { join } from "path";

/* ============ 圆桌中自定义席被删也不能抛 TypeError / 锁死 busy（回归锁） ============
 * 事故链（miniprogram/pages/council/council.js 修复前）：
 *  seatState 构建时的 filter(Boolean) 只保证「发送时刻」有效；每席串行流式间隔
 *  10-60s，轮到第 2..N 席时该席的自定义 persona 可能已被他端删除
 *  （pullIfSafe → adoptCloud 整体替换 customPersonas），resolvePersona 返回 null，
 *  streamChat args 裸取 p.name 抛 TypeError——异常发生在前席 promise 的
 *  .then(runSequential(i+1)) 里，链上无 catch，send() 置的 busy 永不复位。
 * 修法：每席执行前重取 resolvePersona，取不到就把该席标 failed 并续跑后续席位；
 *  整条链外层再加兜底 catch（复位 busy + 可见提示）。
 * 本测试真执行页面模块（注入 require/wx/Page），按席位状态与 busy 断言。 */

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;
type StreamOpts = { args: { mode: string } };

type CouncilPage = {
  data: Dict & { busy: boolean; rtPhase: string; rtSeats: Array<Dict> };
  setData: (patch: Dict) => void;
  openSession: (id: string) => void;
  send: () => void;
};

type StoreLike = {
  state: { sessions: unknown[]; customPersonas: Dict[] };
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
    id: "s_rt_persona",
    personaId: "roundtable",
    participants: ["naval", "custom-1"],
    title: "圆桌(2人)",
    messages: [],
    createdAt: new Date().toISOString(),
  };
  store.addSession(sess);
  page.openSession(sess.id);
}

describe("council.js 圆桌：第 2+ 席的自定义 persona 中途被删", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("自定义席在流中被 adoptCloud 删掉：该席标 failed、链续跑、busy 复位，不抛 TypeError", async () => {
    const modes: string[] = [];
    const { page, store } = loadCouncil(async (opts: StreamOpts) => {
      modes.push(opts.args.mode);
      if (opts.args.mode === "take" && modes.length === 1) {
        // 第一席（naval）流式期间，他端推送到达：customPersonas 被整体替换，
        // 自定义席 custom-1 消失——轮到第 2 席时 resolvePersona 返回 null。
        store.state.customPersonas = [];
      }
      return "席位发言";
    });
    store.state.customPersonas = [
      { id: "custom-1", name: "张三", tag: "自定义席", system: "测试用" },
    ];
    openRoundtable(store, page);

    page.setData({ input: "要不要换工作" });
    page.send();

    await vi.waitFor(() => expect(page.data.busy).toBe(false), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 20));

    // 第 2 席不再发起计费调用（已被判 failed 跳过）；只剩 1 条有效发言 → 不进主持人
    expect(modes).toEqual(["take"]);
    expect(page.data.rtSeats[0]!.status).toBe("done");
    expect(page.data.rtSeats[1]!.status).toBe("failed");
    expect(page.data.rtPhase).toBe("");
    const chat = page.data.chatView as Dict[];
    expect(JSON.stringify(chat[chat.length - 1])).toContain("有效发言不足");
  });

  it("对照：自定义席还在时照常跑完 2 席 + 主持人（守卫不误伤正常流程）", async () => {
    const modes: string[] = [];
    const { page, store } = loadCouncil(async (opts: StreamOpts) => {
      modes.push(opts.args.mode);
      return opts.args.mode === "host" ? "纪要正文" : "席位发言";
    });
    store.state.customPersonas = [
      { id: "custom-1", name: "张三", tag: "自定义席", system: "测试用" },
    ];
    openRoundtable(store, page);

    page.setData({ input: "要不要换工作" });
    page.send();

    await vi.waitFor(() => expect(page.data.busy).toBe(false), { timeout: 3000 });

    expect(modes).toEqual(["take", "take", "host"]);
    const chat = page.data.chatView as Dict[];
    expect(JSON.stringify(chat[chat.length - 1])).toContain("圆桌纪要");
  });
});
