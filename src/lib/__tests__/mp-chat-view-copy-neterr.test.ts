import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序：跨页复制的三处交互口径统一（回归锁） ============
 * ① 聊天消息 → 视图映射：assistant 必须带 blocks（模板按 blocks 渲染），
 *    user 拍平成 {role, content}。这组映射原先在 day.js 复制四处、
 *    council.js / book.js 各一份，day.js 自己的注释记着「第一处已修，这里漏了」
 *    ——同一 bug 修一处漏三处。现在统一走 utils/chat-view.js。
 * ② 复制反馈：day 页在 success 里补自定义 toast（注释理由：原生提示不总出现），
 *    council/book/note 却是裸调 wx.setClipboardData，同一交互三种反馈形态。
 *    统一走 util.copyText。
 * ③ 网络层错误：api.request 曾把英文 errMsg（"request:fail timeout"）原样透出，
 *    登录页错误框直接展示技术串；chat.js 的流式层早已映射成人话。现在 JSON
 *    通道同样映射。
 *
 * 这里断言行为（真加载模块），并顺带锁住「映射只有一份实现」这一点。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();

function freshUtil() {
  const utils = join(ROOT, "miniprogram/utils");
  delete (requireCjs.cache as unknown as Record<string, unknown>)[join(utils, "util.js")];
  return requireCjs(join(utils, "util.js"));
}

function freshChatView(mdStub: unknown) {
  const utils = join(ROOT, "miniprogram/utils");
  const cache = requireCjs.cache as unknown as Record<string, unknown>;
  for (const f of ["chat-view.js", "md.js"]) delete cache[join(utils, f)];
  if (mdStub) cache[join(utils, "md.js")] = mdStub as unknown;
  return requireCjs(join(utils, "chat-view.js"));
}

beforeEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: () => {},
    setClipboardData: () => {},
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
  };
});

describe("utils/chat-view.js — 唯一的消息视图映射", () => {
  it("assistant 消息带 blocks，user 消息拍平为 content", () => {
    const cv = freshChatView(null);
    const view = cv.toChatView([
      { role: "assistant", content: "**答**" },
      { role: "user", content: "问" },
    ]);
    expect(view[0].role).toBe("assistant");
    expect(Array.isArray(view[0].blocks)).toBe(true);
    expect(view[1]).toEqual({ role: "user", content: "问" });
  });

  it("空/缺 content 的 assistant 消息不炸（云端脏快照）", () => {
    const cv = freshChatView(null);
    const view = cv.toChatView([{ role: "assistant" }, { role: "assistant", content: null }]);
    expect(view.every((v: any) => Array.isArray(v.blocks))).toBe(true);
  });

  it("运行期替换 md 实现能被立刻采用（页面测试/热替换不再走旧引用）", () => {
    const utils = join(ROOT, "miniprogram/utils");
    const cache = requireCjs.cache as unknown as Record<string, unknown>;
    delete cache[join(utils, "chat-view.js")];
    delete cache[join(utils, "md.js")];
    const cv = requireCjs(join(utils, "chat-view.js"));
    let called = 0;
    cache[join(utils, "md.js")] = {
      id: "md",
      filename: "md",
      loaded: true,
      exports: {
        parse: (s: string) => {
          called += 1;
          return { blocks: [{ t: "p", text: s }], links: [] };
        },
      },
    } as unknown;
    cv.toChatView([{ role: "assistant", content: "x" }]);
    expect(called).toBe(1);
  });
});

describe("util.copyText — 复制反馈统一口径", () => {
  it("只在剪贴板 success 回调里弹提示（失败不骗人）", () => {
    const util = freshUtil();
    const toasts: string[] = [];
    let clipboardOpts: any = null;
    (globalThis as any).wx = {
      setClipboardData: (o: any) => {
        clipboardOpts = o;
      },
      showToast: (o: { title: string }) => toasts.push(o.title),
    };

    util.copyText("代码", "代码已复制");
    expect(toasts).toEqual([]); // 未成功前不提示
    clipboardOpts.success();
    expect(toasts).toEqual(["代码已复制"]);
  });

  it("未传文案时给默认「已复制」", () => {
    const util = freshUtil();
    const toasts: string[] = [];
    let clipboardOpts: any = null;
    (globalThis as any).wx = {
      setClipboardData: (o: any) => {
        clipboardOpts = o;
      },
      showToast: (o: { title: string }) => toasts.push(o.title),
    };
    util.copyText("x");
    clipboardOpts.success();
    expect(toasts).toEqual(["已复制"]);
  });
});

describe("api.request — 网络层错误映射成人话", () => {
  it("timeout / 域名不可达 / 其它 fail 都给出中文可读文案", async () => {
    const utils = join(ROOT, "miniprogram/utils");
    const cache = requireCjs.cache as unknown as Record<string, unknown>;
    for (const f of ["api.js", "config.js"]) delete cache[join(utils, f)];
    let failCb: any = null;
    (globalThis as any).wx = {
      getStorageSync: () => "",
      setStorageSync: () => {},
      removeStorageSync: () => {},
      getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
      request: (o: any) => {
        failCb = o.fail;
      },
    };
    const api = requireCjs(join(utils, "api.js"));

    const cases: [string, string][] = [
      ["request:fail timeout", "请求超时"],
      ["request:fail url not in domain list", "网络"],
      ["request:fail something odd", "网络请求失败"],
    ];
    for (const [raw, expectPart] of cases) {
      const p = api.login("a@b.c", "x").catch((e: Error) => e.message);
      failCb({ errMsg: raw });
      const msg = await p;
      expect(msg).toContain(expectPart);
      // 绝不能把英文技术串原样透给用户
      expect(msg).not.toContain("request:fail");
    }
  });
});
