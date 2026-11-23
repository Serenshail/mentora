import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import { join } from "path";

/* ============ 读书页三处修复的回归锁 ============
 * ① book.js send：书被删后 render 置 book/mode 为 null，但 setData 与事件排队之间的
 *    毫秒窗口里 tap 仍会进来。旧实现先 setData({busy:true}) 再裸读 that.data.book
 *    → TypeError 让复位语句永远执行不到 → composer 永久锁死（council.sendSingle 同型）。
 * ② render 每次点击都对整段聊天历史做全量 md.parse（day.js/brain.js 早有缓存纪律）；
 *    改为按内容签名缓存，内容没变不重解析。
 * ③ openAssess 不清 assessQuestions/assessChapterTitle：二次验收时等待期仍显示上一章的
 *    题目与标题，且没有「正在出题」提示。
 * 本测试真执行页面模块（注入 require/wx/Page），按行为断言。 */

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

function loadBook(opts: { parseCalls?: { n: number } } = {}) {
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
    setNavigationBarTitle: () => {},
    nextTick: (fn: () => void) => fn(),
    showModal: () => {},
    navigateBack: () => {},
  };
  g.getApp = () => ({ globalData: { user: { userId: "u1" } } });

  const utils = join(ROOT, "miniprogram/utils");
  const cache = require_.cache as unknown as Record<string, unknown>;
  for (const f of ["store.js", "util.js", "api.js", "mastery.js"]) delete cache[join(utils, f)];
  const store = require_(join(utils, "store.js"));
  // 会话守卫在 mp-tab-session-guard.test.ts 里单独覆盖；本锁只关心读书页自身，
  // 因此让 ensure 立即放行（等价于「会话已恢复」）。
  cache[join(utils, "session.js")] = {
    id: "session",
    filename: "session",
    loaded: true,
    exports: { ensure: (fn: () => void) => (fn ? (fn(), Promise.resolve(true)) : Promise.resolve(true)) },
  } as unknown;

  const counter = opts.parseCalls;
  cache[join(utils, "md.js")] = {
    id: "md",
    filename: "md",
    loaded: true,
    exports: {
      parse: (s: string) => {
        if (counter) counter.n += 1;
        return { blocks: [{ t: "p", text: s }], links: [] };
      },
    },
  } as unknown;
  cache[join(utils, "chat.js")] = {
    id: "chat",
    filename: "chat",
    loaded: true,
    exports: { streamChat: () => Promise.resolve("回答"), extractJson: () => ({}) },
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
      DEPOSIT_TYPES: [],
      READ_STATUS_LABELS: {},
      READING_GOAL_LABELS: {},
      ASSESS_KIND_LABELS: {},
      normAssessGen: () => ({ questions: [] }),
      normAssessGrade: () => ({ results: [] }),
      normReadingGoal: () => ({}),
      chapterJson: () => ({}),
      goalText: () => "",
      fallbackAssessQuestions: () => [],
    },
  } as unknown;

  let captured: unknown = null;
  g.Page = (cfg: unknown) => {
    captured = cfg;
  };
  const pagePath = join(ROOT, "miniprogram/pages/book/book.js");
  delete cache[pagePath];
  require_(pagePath);

  const cfg = captured as { data: Dict } & Dict;
  const page: any = Object.assign({}, cfg);
  page.data = JSON.parse(JSON.stringify(cfg.data));
  page.setData = (patch: Dict) => {
    for (const k of Object.keys(patch)) {
      if (k.indexOf(".") < 0 && !k.includes("[")) page.data[k] = patch[k];
    }
  };
  return { page, store };
}

function makeBook(store: any, chat: Dict[] = []) {
  const id = store.createBookFromPlan(
    "书",
    "作者",
    "",
    {
      chapters: [
        { title: "第一章", knowledgeType: "concept" },
        { title: "第二章", knowledgeType: "concept" },
      ],
    },
    "verified"
  );
  store.updateBook(id, { chat });
  return id;
}

describe("读书页：发送守卫 / 解析缓存 / 验收层清空", () => {
  it("书已被删除（book/mode 为 null）时 send 不抛错、不锁死 busy", () => {
    const { page, store } = loadBook();
    const id = makeBook(store);
    page.onLoad({ bookId: id });
    page.onShow();
    expect(page.data.book).toBeTruthy();

    // 模拟 adoptCloud 删书后 render 已置空，但 tap 事件仍排在队列里
    page.data.book = null;
    page.data.mode = null;
    page.setData({ input: "问题" });

    expect(() => page.send()).not.toThrow();
    expect(page.data.busy).toBe(false);
  });

  it("聊天内容不变时 render 复用解析结果，不重复 md.parse", () => {
    const counter = { n: 0 };
    const { page, store } = loadBook({ parseCalls: counter });
    const id = makeBook(store, [
      { id: "m1", role: "assistant", content: "**第一条**", at: "2026-01-01" },
      { id: "m2", role: "user", content: "追问", at: "2026-01-01" },
      { id: "m3", role: "assistant", content: "第二条", at: "2026-01-01" },
    ]);
    page.onLoad({ bookId: id });
    page.onShow();
    const first = counter.n;
    expect(first).toBe(2); // 两条 assistant 消息各解析一次

    page.onShow();
    page.onShow();
    expect(counter.n).toBe(first); // 内容没变 → 不重解析

    store.addBookMsg(id, { id: "m4", role: "assistant", content: "新回答", at: "2026-01-01" });
    page.onShow();
    // 内容变了才重建视图：3 条 assistant 消息各解析一次（旧实现每次 render 都这样）
    expect(counter.n).toBe(first + 3);
  });

  it("打开另一章验收时清空上一章的题目与标题（等待期不展示旧内容）", () => {
    const { page, store } = loadBook();
    const id = makeBook(store);
    page.onLoad({ bookId: id });
    page.onShow();

    const chapters = store.bookById(id).chapters;
    // 先验收第一章：出题成功后 data 里有标题与题目
    page.openAssess({ currentTarget: { dataset: { id: chapters[0].id } } });
    page.setData({
      assessBusy: false,
      assessChapterTitle: "第一章",
      assessQuestions: [{ kind: "explain", question: "第一章的题" }],
      assessAnswers: [""],
    });

    // 再打开第二章：等待期不得残留第一章的内容
    page.openAssess({ currentTarget: { dataset: { id: chapters[1].id } } });
    expect(page.data.assessBusy).toBe(true);
    expect(page.data.assessQuestions).toEqual([]);
    expect(page.data.assessAnswers).toEqual([]);
    expect(page.data.assessChapterTitle).toBe("第二章");

    // 关闭后再开也不带上一章残留
    page.setData({ assessBusy: false });
    page.closeAssess();
    expect(page.data.assessQuestions).toEqual([]);
    expect(page.data.assessChapterTitle).toBe("");
  });
});
