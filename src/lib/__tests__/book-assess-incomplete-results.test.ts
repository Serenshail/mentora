import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import { join } from "path";

/* ============ 小程序验收：判分结果少于题数 → 不许标「已掌握」（回归锁） ============
 * 事故链（miniprogram/pages/book/book.js:415-435）：
 *  normAssessGrade 只保证 results 非空（schema.js:277），不校验条数与 qa 一致；
 *  页面侧 `results = g.results.slice(0, qa.length)` 只截长不校验短，
 *  随后 `results.every(r => r.level === "mastered")` 只对返回的子集判定。
 *  3 题只判回 1 题且该题 mastered → markChapterMastered 写 done + masteredAt（持久化），
 *  少落的题还不进 assessments 弱点档案。修法：条数不等于题数时整批判分作废，
 *  不落档案、不写 masteredAt，答案保留可重交。
 *
 * 本锁用真实 wx/Page stub 把页面跑起来（同 council-roundtable-session-gone.test.ts 的做法），
 * 只替换 chat.streamChat 的返回，按行为断言，不锁行号/注释。 */

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;
type GradeResult = { kind: string; level: string; evidence: string; feedback: string };

type BookPage = {
  data: Dict & {
    assessBusy: boolean;
    assessResult: Dict | null;
    assessQuestions: { kind: string; question: string }[];
    assessAnswers: string[];
  };
  bookId: string;
  setData: (patch: Dict) => void;
  onLoad: (query: Dict) => void;
  submitAssess: () => void;
};

type StoreLike = {
  state: { books: Dict[] };
  bookById: (id: string) => Dict | null;
};

function makePage(cfg: unknown): BookPage {
  const source = cfg as { data: Dict } & Dict;
  const page = Object.assign({}, source) as unknown as BookPage;
  page.data = JSON.parse(JSON.stringify(source.data)) as BookPage["data"];
  page.setData = (patch: Dict) => {
    Object.assign(page.data, patch);
  };
  return page;
}

const QUESTIONS = [
  { kind: "explain", question: "核心主张是什么？" },
  { kind: "connect", question: "和前面读过的内容是什么关系？" },
  { kind: "apply", question: "你工作里哪件事用得上？" },
];

/** 加载真实 store 与 book 页面；streamChat 返回一段判分 JSON（含 ```json 围栏）。 */
function loadBook(gradeResults: GradeResult[], toasts: string[]) {
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
    showToast: (o: { title?: string }) => toasts.push(String(o && o.title)),
    nextTick: (fn: () => void) => fn(),
    setNavigationBarTitle: () => {},
  };

  let captured: unknown = null;
  g.Page = (cfg: unknown) => {
    captured = cfg;
  };

  const storePath = join(ROOT, "miniprogram/utils/store.js");
  const chatPath = join(ROOT, "miniprogram/utils/chat.js");
  const pagePath = join(ROOT, "miniprogram/pages/book/book.js");
  for (const p of [storePath, pagePath]) delete require_.cache[p];

  /* 只替换流式实现；extractJson 用同语义的最小实现（剥围栏 + JSON.parse）。 */
  require_.cache[chatPath] = {
    id: chatPath,
    filename: chatPath,
    loaded: true,
    exports: {
      streamChat: () =>
        Promise.resolve("```json\n" + JSON.stringify({ results: gradeResults, suggestion: "补答第一题" }) + "\n```"),
      extractJson: (text: string) => {
        const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
        return JSON.parse((fenced ? fenced[1]! : text).trim());
      },
    },
  } as unknown as NodeModule;

  require_(pagePath);
  const store = require_(storePath) as StoreLike;
  return { page: makePage(captured), store };
}

function seedBook(store: StoreLike) {
  store.state.books = [
    {
      id: "b1",
      title: "被讨厌的勇气",
      status: "reading",
      chatMode: "socratic",
      chat: [],
      chapters: [
        { id: "c1", title: "课题分离", status: "reading", knowledgeType: "concept", keyConcepts: [] },
        { id: "c2", title: "共同体感觉", status: "todo", knowledgeType: "concept", keyConcepts: [] },
      ],
      assessments: [],
      deposits: [],
    },
  ];
  return store.bookById("b1")!;
}

/** 把页面推进到「三题已作答、等待判分」的状态并提交。 */
function submitWithAnswers(page: BookPage, store: StoreLike, answers: string[]) {
  const book = seedBook(store);
  page.onLoad({ bookId: "b1" });
  page.setData({
    chapter: { id: "c1", title: "课题分离", status: "reading", knowledgeType: "concept" },
    assessOpen: true,
    assessQuestions: QUESTIONS,
    assessAnswers: answers,
    assessResult: null,
  });
  page.submitAssess();
  return book;
}

const mastered = (i: number): GradeResult => ({
  kind: QUESTIONS[i]!.kind,
  level: "mastered",
  evidence: "你说「课题是对方的」",
  feedback: "要害命中",
});

describe("小程序验收判分条数不足：不许误标「已掌握」", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("3 题只判回 1 题且该题 mastered → 不写 masteredAt、不落 assessments、提示重交", async () => {
    const toasts: string[] = [];
    const { page, store } = loadBook([mastered(0)], toasts);
    submitWithAnswers(page, store, ["我的答案一", "我的答案二", "我的答案三"]);

    await vi.waitFor(() => expect(page.data.assessBusy).toBe(false), { timeout: 3000 });

    const book = store.bookById("b1")!;
    const chapter = (book.chapters as Dict[]).find((c) => c.id === "c1")!;
    expect(chapter.masteredAt).toBeUndefined();
    expect(chapter.status).toBe("reading");
    expect((book.assessments as Dict[]).length).toBe(0);
    expect(page.data.assessResult).toBeNull();
    expect(toasts.join(" ")).toContain("判分");
  });

  it("3 题只判回 2 题（全 mastered）→ 同样不放行", async () => {
    const toasts: string[] = [];
    const { page, store } = loadBook([mastered(0), mastered(1)], toasts);
    submitWithAnswers(page, store, ["答案一", "答案二", "答案三"]);

    await vi.waitFor(() => expect(page.data.assessBusy).toBe(false), { timeout: 3000 });

    const book = store.bookById("b1")!;
    const chapter = (book.chapters as Dict[]).find((c) => c.id === "c1")!;
    expect(chapter.masteredAt).toBeUndefined();
    expect((book.assessments as Dict[]).length).toBe(0);
  });

  it("对照：3 题全判 mastered → 正常写 masteredAt 与三条档案", async () => {
    const toasts: string[] = [];
    const { page, store } = loadBook([mastered(0), mastered(1), mastered(2)], toasts);
    submitWithAnswers(page, store, ["答案一", "答案二", "答案三"]);

    await vi.waitFor(() => expect(page.data.assessBusy).toBe(false), { timeout: 3000 });

    const book = store.bookById("b1")!;
    const chapter = (book.chapters as Dict[]).find((c) => c.id === "c1")!;
    expect(typeof chapter.masteredAt).toBe("string");
    expect(chapter.status).toBe("done");
    expect((book.assessments as Dict[]).length).toBe(3);
    expect((page.data.assessResult as Dict).allMastered).toBe(true);
  });

  it("对照：3 题全判回但有一题 partial → 不标掌握，但三条档案都落", async () => {
    const toasts: string[] = [];
    const partial: GradeResult = {
      kind: "apply",
      level: "partial",
      evidence: "你说「用在开会」",
      feedback: "缺具体做法",
    };
    const { page, store } = loadBook([mastered(0), mastered(1), partial], toasts);
    submitWithAnswers(page, store, ["答案一", "答案二", "答案三"]);

    await vi.waitFor(() => expect(page.data.assessBusy).toBe(false), { timeout: 3000 });

    const book = store.bookById("b1")!;
    const chapter = (book.chapters as Dict[]).find((c) => c.id === "c1")!;
    expect(chapter.masteredAt).toBeUndefined();
    expect((book.assessments as Dict[]).length).toBe(3);
    expect((page.data.assessResult as Dict).allMastered).toBe(false);
  });
});
