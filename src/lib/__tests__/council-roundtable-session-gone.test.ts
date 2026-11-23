import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import { join } from "path";

/* ============ 圆桌流程中会话被云端 adoptCloud 换掉：不许 TypeError 锁死 busy ============
 * 背景（council.js 修复前）：sendRoundtable 只在入口守了 sessionById 为空，流程中段
 * 三处收尾（有效发言不足 / 主持人成功 / 主持人失败）都裸写
 *   toChatView(store.sessionById(that.sessionId).messages || [])
 * ——参数表达式在 setData 之前求值，sessionById 返回 null 时先抛 TypeError，busy:false
 * 根本执行不到。而圆桌 = 多席串行流式 + 主持人，可持续数分钟；期间他端删会话、
 * pullIfSafe → adoptCloud 整体替换 sessions（store.js:176-187、app.js:49 的常态路径），
 * 这条 promise 链又没有外层 catch → send() 已置的 busy:true 永不复位，composer 永久禁用。
 *
 * 本锁用真实 wx/Page stub 把页面跑起来（同 scripts/smoke-mp-core.cjs 的做法），
 * 只替换 chat.streamChat 的流式实现，逐条断言三条收尾路径都会把 busy 复位、
 * 且用户已看到的内容不被抹掉。按行为断言，不锁行号/注释。 */

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;
type Msg = { role: string; blocks?: unknown; content?: string };
type StreamOpts = { args: { mode: string } };

type CouncilPage = {
  data: Dict & { chatView: Msg[]; busy: boolean; rtPhase: string; rtSeats: unknown[] };
  setData: (patch: Dict) => void;
  openSession: (id: string) => void;
  send: () => void;
};

type StoreLike = {
  state: { sessions: unknown[] };
  addSession: (s: Dict) => void;
  sessionById: (id: string) => { messages: Dict[] } | null;
};

/** setData 的路径写入（"rtSeats[0].status" / "a.b"），够本页用。 */
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

/** 加载一次真实 store 与页面，chat.streamChat 由调用方提供。 */
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
  };
  g.getApp = () => ({ globalData: { user: { userId: "u1" } } });

  let captured: unknown = null;
  g.Page = (cfg: unknown) => {
    captured = cfg;
  };

  // store 是单例（模块级 state）：每次重新加载，避免用例间串数据。
  const storePath = join(ROOT, "miniprogram/utils/store.js");
  const chatPath = join(ROOT, "miniprogram/utils/chat.js");
  const seatsPath = join(ROOT, "miniprogram/utils/seats.js");
  const pagePath = join(ROOT, "miniprogram/pages/council/council.js");
  for (const p of [storePath, pagePath, seatsPath]) {
    delete require_.cache[p];
  }
  // 只替换流式实现；extractJson 等保持真实模块语义（本页不用）。
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

/** 建一个 3 席圆桌并进入会话。 */
function openRoundtable(store: StoreLike, page: CouncilPage) {
  const sess = {
    id: "s_rt_1",
    personaId: "roundtable",
    participants: ["naval", "jobs", "taleb"],
    title: "圆桌(3人)",
    messages: [],
    createdAt: new Date().toISOString(),
  };
  store.addSession(sess);
  page.openSession(sess.id);
  return sess;
}

/** 模拟 adoptCloud 的常态路径：整体替换 sessions（他端删除该会话）。 */
function dropAllSessions(store: StoreLike) {
  store.state.sessions = [];
}

describe("council.js 圆桌：会话在流程中段消失也不能锁死 busy", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("有效发言不足 2 席：会话已被替换 → busy 复位且补上提示（不抛 TypeError）", async () => {
    let calls = 0;
    const { page, store } = loadCouncil(async () => {
      calls++;
      // 最后一席返回前删会话：此后 addSessionMsg 是空操作，sessionById 返回 null。
      if (calls === 3) dropAllSessions(store);
      return ""; // 全部空发言 → 走 validIds.length < 2 分支
    });
    openRoundtable(store, page);

    page.setData({ input: "该不该辞职" });
    page.send();
    expect(page.data.busy).toBe(true);

    await vi.waitFor(() => expect(page.data.busy).toBe(false), { timeout: 3000 });

    const last = page.data.chatView[page.data.chatView.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(JSON.stringify(last.blocks)).toContain("有效发言不足");
    expect(page.data.rtPhase).toBe("");
  });

  it("主持人成功：会话已被替换 → busy 复位，纪要仍追加到当前视图", async () => {
    let calls = 0;
    const { page, store } = loadCouncil(async (opts: StreamOpts) => {
      calls++;
      if (opts.args.mode === "host") {
        dropAllSessions(store); // 主持人在途时他端删除
        return "各席分歧在风险偏好";
      }
      return "席位发言" + calls;
    });
    openRoundtable(store, page);

    page.setData({ input: "要不要换工作" });
    page.send();

    await vi.waitFor(() => expect(page.data.busy).toBe(false), { timeout: 3000 });

    const last = page.data.chatView[page.data.chatView.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(JSON.stringify(last.blocks)).toContain("圆桌纪要");
    expect(JSON.stringify(last.blocks)).toContain("各席分歧在风险偏好");
    expect(page.data.rtPhase).toBe("");
    expect(page.data.rtSeats).toEqual([]);
  });

  it("主持人失败：会话已被替换 → busy 复位，失败提示仍可见", async () => {
    let calls = 0;
    const { page, store } = loadCouncil(async (opts: StreamOpts) => {
      calls++;
      if (opts.args.mode === "host") {
        dropAllSessions(store);
        throw new Error("网络请求失败");
      }
      return "席位发言" + calls;
    });
    openRoundtable(store, page);

    page.setData({ input: "要不要换工作" });
    page.send();

    await vi.waitFor(() => expect(page.data.busy).toBe(false), { timeout: 3000 });

    const last = page.data.chatView[page.data.chatView.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(JSON.stringify(last.blocks)).toContain("主持人纪要生成失败");
    expect(page.data.rtPhase).toBe("");
  });

  it("会话仍在时：收尾视图按库内消息重建（原有语义不回退）", async () => {
    let calls = 0;
    const { page, store } = loadCouncil(async (opts: StreamOpts) => {
      calls++;
      return opts.args.mode === "host" ? "纪要正文" : "席位发言" + calls;
    });
    const sess = openRoundtable(store, page);

    page.setData({ input: "要不要换工作" });
    page.send();

    await vi.waitFor(() => expect(page.data.busy).toBe(false), { timeout: 3000 });

    const live = store.sessionById(sess.id);
    expect(live).not.toBeNull();
    // 库里：1 条用户问题 + 1 条纪要（席位发言只在内存 takes，不落库）
    const roles = live!.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(page.data.chatView.length).toBe(2);
    expect(page.data.chatView[0]!.role).toBe("user");
    expect(page.data.chatView[1]!.role).toBe("assistant");
  });
});
