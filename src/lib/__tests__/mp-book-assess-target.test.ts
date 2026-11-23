import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import { join } from "path";

/* ============ 验收提交必须落到被验收章 + 一次提交一次深拷贝（回归锁） ============
 * 事故链（miniprogram/pages/book/book.js 修复前）：
 *  1. 从目录弹层对非当前章点「验收」（book.wxml 传 data-id）时，openAssess 只更新
 *     currentChapterId 而不更新 data.chapter——面板标题显示所选章 X，submitAssess
 *     却按 data.chapter（仍是旧展示章 Y）解析章节：判分请求 args.chapter 传 Y 的
 *     上下文、逐题档案记到 Y 名下、三题全过时 masteredAt 写的是 Y——X 永远没被掌握。
 *     错误档案随全量快照同步到云端并影响 Web 端与 chapterWeakPoints 注入。
 *  2. submitAssess 在 results.forEach 里逐条 store.addChapterAssessment，每条整本
 *     深拷贝 + markDirty；三题全过再补一次 markChapterMastered 又一轮 clone——
 *     一次提交 3-4 次串行 MB 级 JSON 往返（applyQuizPass 注释点名的同型反模式）。
 *  3. 直达页会话恢复期间渲染「书不存在」假空态（无 booting 守卫）。
 * 修法：openAssess 把被验收章记到 this.assessChapterId，submitAssess 优先用它；
 * store 新增 addChapterAssessments 合并写全（单次 clone + 单次 markDirty，
 * misconception 单次提交只补一条）；data.booting + wxml 恢复态分支。
 * 本测试真执行页面模块与真实 store.js（require-cache 注入桩）。 */

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

const flush = () => new Promise((r) => setTimeout(r, 0));

type GenResult = { questions: Dict[] };
type GradeResult = { results: Dict[]; misconception: Dict | null };

let genResult: GenResult;
let gradeResult: GradeResult;
let cloneCalls: number;

function loadBook() {
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

  const realUtil = require_(join(utils, "util.js")) as Record<string, unknown>;
  cloneCalls = 0;
  cache[join(utils, "util.js")] = {
    id: "util",
    filename: "util",
    loaded: true,
    exports: Object.assign({}, realUtil, {
      clone: (o: unknown) => {
        cloneCalls += 1;
        return JSON.parse(JSON.stringify(o));
      },
    }),
  } as unknown;

  const store = require_(join(utils, "store.js")) as any;
  // 会话守卫立即放行（等价于「会话已恢复」，守卫本体由 mp-tab-session-guard 覆盖）
  cache[join(utils, "session.js")] = {
    id: "session",
    filename: "session",
    loaded: true,
    exports: {
      ensure: (fn?: () => void) => {
        if (fn) fn();
        return Promise.resolve(true);
      },
    },
  } as unknown;
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
      streamChat: (opts: { task: string }) => {
        if (opts.task === "reading-assess-gen") return Promise.resolve("gen");
        if (opts.task === "reading-assess-grade") return Promise.resolve("grade");
        return Promise.resolve("");
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
      DEPOSIT_TYPES: [],
      READ_STATUS_LABELS: {},
      READING_GOAL_LABELS: {},
      ASSESS_KIND_LABELS: { explain: "理解", connect: "结构", transfer: "迁移" },
      normAssessGen: (): GenResult => JSON.parse(JSON.stringify(genResult)),
      normAssessGrade: (): GradeResult => JSON.parse(JSON.stringify(gradeResult)),
      normReadingGoal: () => ({}),
      chapterJson: (c: unknown) => c,
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

function makeBook(store: any) {
  return store.createBookFromPlan(
    "书",
    "作者",
    "",
    {
      chapters: [{ title: "第一章", knowledgeType: "concept" }, { title: "第二章", knowledgeType: "concept" }],
    },
    "verified"
  );
}

const QUESTION = (i: number) => ({ kind: "explain", question: "第" + i + "题" });
const MASTERED = { kind: "explain", level: "mastered", evidence: "依据", feedback: "过了" };

describe("submitAssess 定位被验收章（不再读当前展示章）", () => {
  it("从目录对非当前章（第二章）发起验收：档案与 masteredAt 都落在第二章", async () => {
    genResult = { questions: [QUESTION(1), QUESTION(2), QUESTION(3)] };
    gradeResult = {
      results: [MASTERED, MASTERED, MASTERED],
      misconception: null,
    };
    const { page, store } = loadBook();
    const id = makeBook(store);
    page.onLoad({ bookId: id });
    page.onShow();
    const chapters = store.bookById(id).chapters;

    // 当前展示章是第一章（render 默认选第一个 todo 章），对第二章发起验收
    page.openAssess({ currentTarget: { dataset: { id: chapters[1].id } } });
    expect(page.data.assessChapterTitle).toBe("第二章");
    await flush();
    page.setData({ assessAnswers: ["答一", "答二", "答三"] });

    const clonesBefore = cloneCalls;
    page.submitAssess();
    await flush();
    await flush();

    const b = store.bookById(id);
    // 逐题档案全在第二章名下（旧实现落在第一章）
    expect(b.assessments.length).toBe(3);
    expect(b.assessments.every((a: Dict) => a.chapterId === chapters[1].id)).toBe(true);
    // 掌握标记也写第二章（旧实现写第一章，第二章永远没被掌握）
    const ch2 = b.chapters.find((c: Dict) => c.id === chapters[1].id);
    const ch1 = b.chapters.find((c: Dict) => c.id === chapters[0].id);
    expect(ch2.masteredAt).toBeTruthy();
    expect(ch2.status).toBe("done");
    expect(ch1.masteredAt).toBeFalsy();
    // 合并写全：整本深拷贝恰好一次（旧实现 3 次逐题 + 1 次掌握 = 4 次）
    expect(cloneCalls - clonesBefore).toBe(1);
  });

  it("判分含非掌握题：misconception 只补一条（旧逐条写法每条非掌握题各补一次）", async () => {
    genResult = { questions: [QUESTION(1), QUESTION(2), QUESTION(3)] };
    gradeResult = {
      results: [
        MASTERED,
        { kind: "connect", level: "partial", evidence: "", feedback: "差一点" },
        { kind: "transfer", level: "not", evidence: "", feedback: "没过" },
      ],
      misconception: { concept: "迁移错位", note: "把 A 用到了 B" },
    };
    const { page, store } = loadBook();
    const id = makeBook(store);
    page.onLoad({ bookId: id });
    page.onShow();
    const chapters = store.bookById(id).chapters;
    page.openAssess({ currentTarget: { dataset: { id: chapters[0].id } } });
    await flush();
    page.setData({ assessAnswers: ["答一", "答二", "答三"] });
    page.submitAssess();
    await flush();
    await flush();

    const b = store.bookById(id);
    expect(b.learning.misconceptions.length).toBe(1);
    expect(b.chapters.find((c: Dict) => c.id === chapters[0].id).masteredAt).toBeFalsy();
    expect(b.assessments.length).toBe(3);
  });
});

describe("直达页恢复期不渲染「书不存在」假空态（booting 守卫）", () => {
  it("onShow 恢复后 render 才撤 booting；书真的不存在时空态才出现", () => {
    const { page, store } = loadBook();
    const id = makeBook(store);
    expect(page.data.booting).toBe(true); // 初始：恢复中，不是空态
    page.onLoad({ bookId: id });
    page.onShow();
    expect(page.data.booting).toBe(false);
    expect(page.data.book).toBeTruthy();

    // 另一个实例直达一本不存在的书：恢复完（session 立即放行）后才是真「书不存在」
    const { page: p2 } = loadBook();
    p2.onLoad({ bookId: "b-gone" });
    p2.onShow();
    expect(p2.data.booting).toBe(false);
    expect(p2.data.book).toBe(null);
    void store;
  });
});
