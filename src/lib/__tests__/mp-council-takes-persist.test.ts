import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import { join } from "path";

/* ============ 主持人失败时圆桌各席发言必须落库（回归锁） ============
 * 事故链（miniprogram/pages/council/council.js 修复前）：
 *  runSequential 只把 take 写进闭包 takes 与 rtSeats 视图数据，整条链全程无
 *  addSessionMsg——落库的只有用户提问、主持人纪要（成功）或提示语（失败）。
 *  主持人失败文案向用户承诺「各席发言已完整保留，可重新发送问题重试」，但用户
 *  退出会话再进入（openSession 用 toChatView(s.messages) 重建视图、rtSeats 清空）
 *  后各席发言永久丢失，且「重新发送」是整链重跑、全部席位重新计费——文案与
 *  数据事实不符，误导用户以为无需重跑席位。
 * 修法：主持人失败分支把各席有效发言按席逐条落库（带席位名前缀，格式同纪要的
 *  takesText），文案承诺在其出现的地方成立。成功路径库里 user+纪要 的既有语义
 *  由 council-roundtable-session-gone 回归锁钉住，保持不回退。
 * 本测试真执行页面模块与真实 store.js（require-cache 注入桩）。 */

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;
type StreamOpts = { args: { mode: string } };

function loadCouncil(streamChat: (opts: StreamOpts) => Promise<string>) {
  const storage: Dict = {};
  const g = globalThis as unknown as Record<string, unknown>;
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
  const store = require_(storePath) as any;
  const cfg = captured as { data: Dict } & Dict;
  const page: any = Object.assign({}, cfg);
  page.data = JSON.parse(JSON.stringify(cfg.data));
  const setPath = (obj: Dict, path: string, value: unknown) => {
    const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
    let cur: any = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]!] === undefined || cur[parts[i]!] === null) cur[parts[i]!] = {};
      cur = cur[parts[i]!];
    }
    cur[parts[parts.length - 1]!] = value;
  };
  page.setData = (patch: Dict) => {
    for (const k of Object.keys(patch)) setPath(page.data, k, patch[k]);
  };
  return { page, store };
}

function openRoundtable(store: any, page: any) {
  const sess = {
    id: "s_rt_persist",
    personaId: "roundtable",
    participants: ["naval", "jobs"],
    title: "圆桌(2人)",
    messages: [],
    createdAt: new Date().toISOString(),
  };
  store.addSession(sess);
  page.openSession(sess.id);
  return sess;
}

describe("圆桌主持人失败：各席发言落库（「已完整保留」承诺与数据事实一致）", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("主持人失败：两席发言（带席位名前缀）+ 失败提示都进会话消息，重进可见", async () => {
    const { page, store } = loadCouncil(async (opts: StreamOpts) => {
      if (opts.args.mode === "take") return "发言内容";
      throw new Error("主持人生成失败");
    });
    const sess = openRoundtable(store, page);
    page.setData({ input: "要不要换工作" });
    page.send();
    await vi.waitFor(() => expect(page.data.busy).toBe(false), { timeout: 3000 });

    const s = store.sessionById(sess.id);
    const contents = (s.messages as Dict[]).map((m) => String(m.content));
    // 修复前这里只有 user + 失败提示——承诺「已完整保留」但发言全丢
    expect(contents).toContain("【Naval Ravikant】发言内容");
    expect(contents).toContain("【Steve Jobs】发言内容");
    expect(contents.some((c) => c.indexOf("主持人纪要生成失败") >= 0)).toBe(true);

    // 退出再进入：openSession 按 s.messages 重建视图，各席发言完整可见
    page.openSession(sess.id);
    const view = JSON.stringify(page.data.chatView);
    expect(view).toContain("【Naval Ravikant】发言内容");
    expect(view).toContain("【Steve Jobs】发言内容");
  });

  it("主持人成功路径不回退：库里仍是 user + 纪要（与既有契约一致）", async () => {
    const { page, store } = loadCouncil(async (opts: StreamOpts) => {
      if (opts.args.mode === "take") return "发言内容";
      return "主持人纪要正文";
    });
    const sess = openRoundtable(store, page);
    page.setData({ input: "要不要换工作" });
    page.send();
    await vi.waitFor(() => expect(page.data.busy).toBe(false), { timeout: 3000 });

    const s = store.sessionById(sess.id);
    const roles = (s.messages as Dict[]).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(JSON.stringify(s.messages[1])).toContain("圆桌纪要");
  });
});
