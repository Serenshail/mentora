import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import { join } from "path";

/* ============ 小程序复习页：判卷流必须有取消句柄，离开页面即中止（回归锁） ============
 * 背景（review.js 修复前）：askNext 的 review-ask 流特意传了 register 并注释了理由
 * （"否则流跑到完成或 180s 超时……失败 toast 还会弹在用户已经离开的界面里"），
 * 但 submit 的 review-grade 流完全没传 register：review 页是 navigateTo 子页，
 * 用户提交答案后返回，onUnload 无法取消这条流——评分请求继续占用连接直到完成/超时，
 * 失败 toast「评分服务暂不可用」弹在用户已离开的界面上；更糟的是流恰好正常跑完时
 * 成功路径仍会对已卸载页面 setData 并 recordReview（一次没答完的复习被记进排期，
 * 后续间隔全被带偏）。Web 端 /brain 早有同纪律（gen 失效 + abort，见
 * brain-review-unmount-abort.test.ts）。
 *
 * 修法：submit 传 register 存 that._gradeCancel；onUnload 取消它；并加 _unloaded
 * 守卫，拦住「cancel 时流已正常结束」的竞态——此时不再写界面、不再 recordReview、
 * 不弹 toast。本测试真执行 review.js（Page/wx stub），只替换 store 与 streamChat。 */

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

type Captured = {
  opts: {
    task: string;
    register?: (cancel: () => void) => void;
  };
  resolve: (v: string) => void;
  reject: (e: unknown) => void;
  cancelled: boolean;
};

/** 与 chat.js 同语义的流桩：register 拿到的 cancel 会以 reject("生成已停止") 收口。 */
function makeChat() {
  const calls: Captured[] = [];
  const streamChat = (opts: Captured["opts"]) =>
    new Promise<string>((resolve, reject) => {
      const c: Captured = { opts, resolve, reject, cancelled: false };
      calls.push(c);
      if (typeof opts.register === "function") {
        opts.register(() => {
          c.cancelled = true;
          reject(new Error("生成已停止"));
        });
      }
    });
  return { calls, streamChat, extractJson: (t: string) => JSON.parse(t) };
}

const ITEM = { id: "k1", title: "闭包", body: "闭包捕获词法作用域", domain: "JS" };

type ReviewPage = Dict & {
  data: Dict;
  setDataCalls: number;
  setData: (patch: Dict) => void;
  onLoad: () => void;
  onUnload: () => void;
  start: () => void;
  submit: () => void;
};

function loadReview(chatStub: ReturnType<typeof makeChat>) {
  const toasts: string[] = [];
  const recordReview = vi.fn();
  const g = globalThis as unknown as Dict;
  g.wx = {
    showToast: (o: { title: string }) => toasts.push(o.title),
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
  };
  g.getApp = () => ({ globalData: { user: { userId: "u1" } } });

  let captured: unknown = null;
  g.Page = (cfg: unknown) => {
    captured = cfg;
  };

  const storePath = join(ROOT, "miniprogram/utils/store.js");
  const chatPath = join(ROOT, "miniprogram/utils/chat.js");
  const pagePath = join(ROOT, "miniprogram/pages/review/review.js");
  for (const p of [pagePath]) delete require_.cache[p];

  const storeStub = {
    state: { knowledge: [ITEM] },
    dueReviews: () => [{ id: ITEM.id }],
    knowledgeById: (id: string) => (id === ITEM.id ? ITEM : null),
    recordReview,
  };
  require_.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: storeStub,
  } as unknown as NodeModule;
  require_.cache[chatPath] = {
    id: chatPath,
    filename: chatPath,
    loaded: true,
    exports: chatStub,
  } as unknown as NodeModule;

  require_(pagePath);
  const source = captured as { data: Dict } & Dict;
  const page = Object.assign({}, source) as ReviewPage;
  page.data = JSON.parse(JSON.stringify(source.data)) as Dict;
  page.setDataCalls = 0;
  page.setData = (patch: Dict) => {
    page.setDataCalls += 1;
    for (const k of Object.keys(patch)) page.data[k] = patch[k];
  };
  return { page, toasts, recordReview };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("review.js：判卷流离开页面必须中止且不落库", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submit 的 review-grade 流注册 cancel；onUnload 会调用它，且不弹失败 toast", async () => {
    const chatStub = makeChat();
    const { page, toasts, recordReview } = loadReview(chatStub);
    page.onLoad();
    page.setData({ answer: "闭包就是函数记住定义时的作用域" });
    page.submit();

    expect(chatStub.calls).toHaveLength(1);
    expect(chatStub.calls[0]!.opts.task).toBe("review-grade");
    expect(typeof chatStub.calls[0]!.opts.register).toBe("function");

    page.onUnload();
    await flush();

    expect(chatStub.calls[0]!.cancelled).toBe(true); // 连接被掐断，不会跑到 180s 超时
    expect(toasts).toEqual([]); // 「评分服务暂不可用」不弹在已离开的界面上
    expect(recordReview).not.toHaveBeenCalled();
  });

  it("离开页面后流恰好正常跑完：不写界面、不 recordReview（竞态兜底）", async () => {
    const chatStub = makeChat();
    const { page, recordReview } = loadReview(chatStub);
    page.onLoad();
    page.setData({ answer: "闭包" });
    page.submit();

    // 流先完成，随后（微任务落地前）页面卸载——cancel 对已 settle 的 promise 无效
    chatStub.calls[0]!.resolve('{"verdict":"pass","evidence":"捕获词法作用域","feedback":"好"}');
    page.onUnload();
    await flush();

    expect(recordReview).not.toHaveBeenCalled(); // 没做完的复习不得写进排期
    expect(page.data.verdict).toBeNull();
    expect(page.data.phase).not.toBe("graded");
  });

  it("未离开页面时行为不变：正常判分并 recordReview", async () => {
    const chatStub = makeChat();
    const { page, recordReview } = loadReview(chatStub);
    page.onLoad();
    page.setData({ answer: "闭包" });
    page.submit();

    chatStub.calls[0]!.resolve('{"verdict":"pass","evidence":"捕获词法作用域","feedback":"好"}');
    await flush();

    expect(recordReview).toHaveBeenCalledWith("k1", true);
    expect(page.data.phase).toBe("graded");
    expect(page.data.gradeBusy).toBe(false);
  });

  it("出题流（review-ask）的既有取消行为不回归", async () => {
    const chatStub = makeChat();
    const { page, toasts } = loadReview(chatStub);
    page.onLoad();
    page.start();

    expect(chatStub.calls[0]!.opts.task).toBe("review-ask");
    page.onUnload();
    await flush();

    expect(chatStub.calls[0]!.cancelled).toBe(true);
    expect(toasts).toEqual([]);
  });
});
