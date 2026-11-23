import { beforeEach, describe, expect, it, vi } from "vitest";

/* 第二批 C（AG-05）阅读与笔记业务动作的执行器回归。
 * tool-executors 引用带 @/ 别名与浏览器 store 的模块，用工厂 mock 拦截
 * （同 fix-01-agent-pipeline.test.ts 先例），但 store 用可变状态对象注入真实业务数据。 */
vi.mock("@/lib/ai/client", () => ({
  /* reading-plan（rebuild_reading_route 校验期生成）返回固定合法 JSON，供预览路径测试 */
  streamChat: vi.fn(async ({ task }: { task?: string }) =>
    task === "reading-plan"
      ? JSON.stringify({
          planSummary: "重排后的路线摘要",
          chapters: [
            { title: "新节点 A", focusQuestion: "qA" },
            { title: "新节点 B", focusQuestion: "qB" },
          ],
        })
      : task === "persona-distill"
        ? JSON.stringify({
            name: "张居正", tag: "明代改革家", bio: "万历首辅，主政十年。",
            color: "violet",
            identityNote: "模拟视角：基于明代政治家张居正的公开事迹构建的分析人格，不代表其本人对现代问题的真实观点。",
            system: "你是张居正视角的分析者……",
          })
        : ""),
  extractJson: (t: string) => JSON.parse(t),
  readingPlanSchema: { parse: (x: unknown) => x },
  personaDistillSchema: { parse: (x: unknown) => x },
  phaseListSchema: {},
}));
/* 可变 store mock：beforeEach 注入书架/笔记，验证工具的真实读写 */
const mutableState: { books: unknown[]; knowledge: unknown[]; goals: unknown[]; sessions: unknown[]; settings: Record<string, unknown> } = {
  books: [], knowledge: [], goals: [], sessions: [], settings: {},
};
const applied: { fn: string; args: unknown[] }[] = [];
vi.mock("@/lib/store", () => ({
  useAppStore: {
    getState: () => ({
      ...mutableState,
      setBookGoal: (...a: unknown[]) => { applied.push({ fn: "setBookGoal", args: a }); },
      setChapterStatus: (...a: unknown[]) => { applied.push({ fn: "setChapterStatus", args: a }); },
      setBookReadStatus: (...a: unknown[]) => { applied.push({ fn: "setBookReadStatus", args: a }); },
      moveChapter: (...a: unknown[]) => { applied.push({ fn: "moveChapter", args: a }); },
      addBookDeposit: (...a: unknown[]) => { applied.push({ fn: "addBookDeposit", args: a }); },
      linkNotes: (...a: unknown[]) => { applied.push({ fn: "linkNotes", args: a }); },
      enableReview: (...a: unknown[]) => { applied.push({ fn: "enableReview", args: a }); },
      recordReview: (...a: unknown[]) => { applied.push({ fn: "recordReview", args: a }); },
      addChapterAssessment: (...a: unknown[]) => { applied.push({ fn: "addChapterAssessment", args: a }); },
      markChapterMastered: (...a: unknown[]) => { applied.push({ fn: "markChapterMastered", args: a }); },
      updateBook: (...a: unknown[]) => { applied.push({ fn: "updateBook", args: a }); },
      removeBook: (...a: unknown[]) => { applied.push({ fn: "removeBook", args: a }); },
      snapshotBookRoute: (...a: unknown[]) => { applied.push({ fn: "snapshotBookRoute", args: a }); },
      regenerateBookRoute: (...a: unknown[]) => { applied.push({ fn: "regenerateBookRoute", args: a }); },
      restoreBookRoute: (...a: unknown[]) => { applied.push({ fn: "restoreBookRoute", args: a }); },
      addSession: (...a: unknown[]) => { applied.push({ fn: "addSession", args: a }); },
      updateSession: (...a: unknown[]) => { applied.push({ fn: "updateSession", args: a }); },
      removeSession: (...a: unknown[]) => { applied.push({ fn: "removeSession", args: a }); },
      addCustomPersona: (...a: unknown[]) => { applied.push({ fn: "addCustomPersona", args: a }); },
    }),
    setState: () => {},
    subscribe: () => () => {},
  },
}));
vi.mock("@/lib/book-verify", () => ({ verifyBook: vi.fn(async () => null) }));
vi.mock("@/lib/rag", () => ({ buildContext: () => "", wikiRetrieve: () => [] }));
vi.mock("@/lib/track", () => ({ track: () => {} }));
vi.mock("@/lib/utils", () => ({
  uid: (p: string) => `${p}_test_${Math.random().toString(36).slice(2, 8)}`,
  todayISO: () => "2026-11-11",
}));
vi.mock("@/lib/resources", () => ({
  parseResourceConstraint: () => ({ resourceType: "video" }),
  classifyResource: () => ({}),
  validateResources: () => ({ verdicts: [] }),
}));

import { executeTool, executeAction, resolveBook } from "../agent/tool-executors";
import type { Book, BookChapter, KnowledgeItem } from "../types";

const chapter = (id: string, title: string, status: BookChapter["status"] = "todo"): BookChapter => ({
  id, title, status, focusQuestion: `为什么要读${title}`, knowledgeType: "concept",
});

function seedBook(overrides: Partial<Book> = {}): Book {
  return {
    id: "bk-1",
    title: "影响力",
    author: "罗伯特·西奥迪尼",
    status: "reading",
    readStatus: "reading",
    routeType: "full",
    verification: "verified",
    goal: { primary: "understand", secondary: ["think"], intent: "想搞懂说服", background: "", setAt: "2026-11-01" },
    chapters: [chapter("c1", "第一章 互惠", "done"), chapter("c2", "第二章 承诺与一致", "reading"), chapter("c3", "第三章 社会认同")],
    deposits: [],
    insights: [],
    chat: [],
    createdAt: "2026-11-01",
    ...overrides,
  } as Book;
}

const note = (id: string, title: string, links: string[] = []): KnowledgeItem =>
  ({ id, title, body: "", domain: "笔记", source: "manual", sourceTitle: "手动记录", masteredAt: "2026-11-01", reviewStage: 0, links }) as KnowledgeItem;

beforeEach(() => {
  mutableState.books = [seedBook()];
  mutableState.knowledge = [note("k1", "互惠原理"), note("k2", "社会认同"), note("k3", "承诺与一致")];
  mutableState.goals = [];
  applied.length = 0;
});

describe("resolveBook / AG-01 书目消歧", () => {
  it("精确书名唯一命中", () => {
    const r = resolveBook(mutableState.books as Book[], "影响力");
    expect(r.kind).toBe("exact");
  });
  it("近名多本（两本都非精确同名）→ ambiguous", () => {
    /* 查「影响力」：两本都是版本变体、无精确同名 → 消歧。
     *  精确同名优先不消歧（与 resolveGoal 语义一致），见下一条。 */
    const books = [seedBook({ id: "bk-1", title: "影响力（新版）" }), { ...seedBook(), id: "bk-2", title: "影响力（修订版）" }];
    expect(resolveBook(books, "影响力").kind).toBe("ambiguous");
  });
  it("精确同名优先：查「影响力」命中同名书而非《先发影响力》", () => {
    const books = [seedBook(), { ...seedBook(), id: "bk-2", title: "先发影响力" }];
    const r = resolveBook(books, "影响力");
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.bookId).toBe("bk-1");
  });
  it("按 id 精确命中", () => {
    const r = resolveBook(mutableState.books as Book[], "", "bk-1");
    expect(r.kind).toBe("exact");
  });
  it("未找到", () => {
    expect(resolveBook(mutableState.books as Book[], "不存在").kind).toBe("none");
  });
});

describe("get_book（R01：详细读取）", () => {
  it("返回目标/进度/逐章状态，含 id 供后续精确定位", async () => {
    const out = await executeTool("get_book", { title: "影响力" });
    expect(out.result.ok).toBe(true);
    expect(out.result.content).toContain("阅读目标：主=understand");
    expect(out.result.content).toContain("1/3 章读完");
    expect(out.result.content).toContain("[done] 第一章 互惠");
    expect(out.result.content).toContain("id=bk-1");
  });
  it("近名多本时返回候选", async () => {
    mutableState.books = [seedBook({ id: "bk-1", title: "影响力（新版）" }), { ...seedBook(), id: "bk-2", title: "影响力（修订版）" }];
    const out = await executeTool("get_book", { title: "影响力" });
    expect(out.result.content).toContain("本相近的书");
  });
});

describe("edit_book_goal（R03：预览 + 应用）", () => {
  it("草稿带旧→新预览，应用后调用 setBookGoal 且 inferred=false", async () => {
    const out = await executeTool("edit_book_goal", { title: "影响力", primary: "apply", intent: "用在谈判里" });
    expect(out.result.ok).toBe(true);
    expect(out.action!.payload.preview).toContain("主目标：understand → apply");
    expect(out.action!.payload.preview).toContain("用在谈判里");
    expect(out.action!.payload.preview).toContain("重排路线");
    const res = await executeAction(out.action!);
    expect(res.ok).toBe(true);
    expect(applied.some((a) => a.fn === "setBookGoal")).toBe(true);
    const goal = applied.find((a) => a.fn === "setBookGoal")!.args[1] as { primary: string; inferred: boolean; intent: string };
    expect(goal.primary).toBe("apply");
    expect(goal.inferred).toBe(false);
    expect(goal.intent).toBe("用在谈判里");
  });
  it("primary 值不合法 → 拒绝", async () => {
    const out = await executeTool("edit_book_goal", { title: "影响力", primary: "invalid" });
    expect(out.result.ok).toBe(false);
  });
  it("空修改 → 拒绝", async () => {
    const out = await executeTool("edit_book_goal", { title: "影响力" });
    expect(out.result.ok).toBe(false);
  });
});

describe("set_reading_progress（R05：章节/全书状态）", () => {
  it("章节 done + 全书 finished 均落库", async () => {
    const out = await executeTool("set_reading_progress", { title: "影响力", chapterTitle: "第二章 承诺与一致", chapterStatus: "done", readStatus: "finished" });
    expect(out.result.ok).toBe(true);
    expect(out.action!.payload.preview).toContain("第二章 承诺与一致」：reading → done");
    expect(out.action!.payload.preview).toContain("不等于验收掌握");
    await executeAction(out.action!);
    expect(applied.find((a) => a.fn === "setChapterStatus")!.args).toEqual(["bk-1", "c2", "done"]);
    expect(applied.find((a) => a.fn === "setBookReadStatus")!.args).toEqual(["bk-1", "finished"]);
  });
  it("按序号定位章节", async () => {
    const out = await executeTool("set_reading_progress", { title: "影响力", chapterTitle: "3", chapterStatus: "skipped" });
    expect(out.action!.payload.chapterId).toBe("c3");
  });
  it("状态已是目标值 → 无需修改（无 action）", async () => {
    const out = await executeTool("set_reading_progress", { title: "影响力", chapterTitle: "第一章 互惠", chapterStatus: "done" });
    expect(out.result.ok).toBe(true);
    expect(out.action).toBeUndefined();
  });
  it("chapterStatus 不合法 → 拒绝", async () => {
    expect((await executeTool("set_reading_progress", { title: "影响力", chapterTitle: "1", chapterStatus: "mastered" })).result.ok).toBe(false);
  });
});

describe("move_chapter（R04：节点顺序）", () => {
  it("下移一位：目标与邻居交换", async () => {
    const out = await executeTool("move_chapter", { title: "影响力", chapterTitle: "第一章 互惠", dir: 1 });
    expect(out.action!.payload.preview).toContain("与「第二章 承诺与一致」交换");
    await executeAction(out.action!);
    expect(applied.find((a) => a.fn === "moveChapter")!.args).toEqual(["bk-1", "c1", 1]);
  });
  it("第一个节点上移 → 无需移动", async () => {
    const out = await executeTool("move_chapter", { title: "影响力", chapterTitle: "第一章 互惠", dir: -1 });
    expect(out.result.content).toContain("已经是第一个");
    expect(out.action).toBeUndefined();
  });
});

describe("save_reading_deposit（R07：带章节来源）", () => {
  it("沉淀落到指定章节，type 合法", async () => {
    const out = await executeTool("save_reading_deposit", { title: "影响力", chapterTitle: "第一章 互惠", type: "view", text: "互惠的本质是负债感" });
    expect(out.action!.payload.preview).toContain("互惠的本质是负债感");
    await executeAction(out.action!);
    const arg = applied.find((a) => a.fn === "addBookDeposit")!.args[1] as { chapterId?: string; type: string; text: string };
    expect(arg.chapterId).toBe("c1");
    expect(arg.type).toBe("view");
  });
  it("type 不合法 → 拒绝", async () => {
    expect((await executeTool("save_reading_deposit", { title: "影响力", type: "random", text: "x" })).result.ok).toBe(false);
  });
});

describe("link_notes（N04：双链关联）", () => {
  it("应用后调用 linkNotes", async () => {
    const out = await executeTool("link_notes", { from: "互惠原理", to: "社会认同" });
    expect(out.action!.payload.preview).toContain("互惠原理");
    await executeAction(out.action!);
    expect(applied.find((a) => a.fn === "linkNotes")!.args).toEqual(["k1", "k2"]);
  });
  it("已存在关联 → 无需重复", async () => {
    mutableState.knowledge = [note("k1", "互惠原理", ["k2"]), note("k2", "社会认同")];
    const out = await executeTool("link_notes", { from: "互惠原理", to: "社会认同" });
    expect(out.result.content).toContain("已经关联");
    expect(out.action).toBeUndefined();
  });
  it("任一笔记不存在 → 拒绝", async () => {
    const out = await executeTool("link_notes", { from: "互惠原理", to: "不存在的笔记" });
    expect(out.result.ok).toBe(false);
    expect(out.result.content).toContain("不存在的笔记");
  });
});

describe("review_queue（N05：list 读 / enable+record 走审批）", () => {
  it("list：队列计数", async () => {
    mutableState.knowledge = [
      { ...note("k1", "到期知识点"), nextReviewAt: "2026-11-01" },
      { ...note("k2", "未来知识点"), nextReviewAt: "2026-12-01" },
      note("k3", "不在队列"),
    ];
    const out = await executeTool("review_queue", { action: "list" });
    expect(out.result.content).toContain("今日待复习 1 条，队列共 2 条");
  });
  it("enable 生成待确认卡，应用后调用 enableReview", async () => {
    const out = await executeTool("review_queue", { action: "enable", title: "互惠原理", enabled: true });
    expect(out.action!.payload.action).toBe("enable");
    await executeAction(out.action!);
    expect(applied.find((a) => a.fn === "enableReview")!.args).toEqual(["k1", true]);
  });
  it("record 缺 ok → 拒绝（不凭模型判断伪造复习）", async () => {
    const out = await executeTool("review_queue", { action: "record", title: "互惠原理" });
    expect(out.result.ok).toBe(false);
    expect(out.result.content).toContain("真实作答");
  });
  it("record 带 ok → 应用后调用 recordReview", async () => {
    const out = await executeTool("review_queue", { action: "record", title: "互惠原理", ok: false });
    await executeAction(out.action!);
    expect(applied.find((a) => a.fn === "recordReview")!.args).toEqual(["k1", false]);
  });
});

/* ===== 批次 C 二轮（R02/R04/R06）===== */

describe("get_book 章节详情（R06：讨论与检验的材料上下文）", () => {
  it("带 chapterTitle 返回核心论点/本章问题/关键概念/验收锚点/接续入口", async () => {
    mutableState.books = [
      seedBook({
        chapters: [
          { ...chapter("c1", "第一章 互惠", "done"), coreIdea: "负债感驱动回报", keyConcepts: ["互惠", "让步"], assessFocus: "能举例说明" },
        ],
        deposits: [{ id: "d1", chapterId: "c1", type: "view", text: "互惠的本质是负债感", at: "2026-11-05" }],
        assessments: [{ id: "a1", chapterId: "c1", kind: "explain", question: "解释互惠", answer: "", level: "partial", evidence: "e", feedback: "f", at: "2026-11-06" }],
      }),
    ];
    const out = await executeTool("get_book", { title: "影响力", chapterTitle: "第一章 互惠" });
    expect(out.result.content).toContain("核心论点：负债感驱动回报");
    expect(out.result.content).toContain("本章问题：为什么要读第一章 互惠");
    expect(out.result.content).toContain("关键概念：互惠、让步");
    expect(out.result.content).toContain("验收锚点：能举例说明");
    expect(out.result.content).toContain("用户本章已有沉淀");
    expect(out.result.content).toContain("上次验收");
    expect(out.result.content).toContain("接续入口：/read/bk-1");
  });
  it("章节不存在 → 明确提示", async () => {
    const out = await executeTool("get_book", { title: "影响力", chapterTitle: "不存在的章" });
    expect(out.result.content).toContain("没有找到章节");
  });
});

describe("record_book_assessment（R06：检验理解落库）", () => {
  it("验收记录落库；mastered 同时 markChapterMastered", async () => {
    const out = await executeTool("record_book_assessment", {
      title: "影响力", chapterTitle: "第一章 互惠", kind: "explain",
      question: "用自己的话解释互惠", answer: "别人给了好处我会有亏欠感", level: "mastered",
      evidence: "用户原话提到亏欠感", feedback: "举例到位",
    });
    expect(out.action!.payload.preview).toContain("将标记为已验收掌握");
    await executeAction(out.action!);
    const asArg = applied.find((a) => a.fn === "addChapterAssessment")!.args[1] as { chapterId: string; level: string; evidence: string };
    expect(asArg.chapterId).toBe("c1");
    expect(asArg.level).toBe("mastered");
    expect(applied.find((a) => a.fn === "markChapterMastered")!.args[0]).toBe("bk-1");
  });
  it("evidence 缺失 → 拒绝（判而不解释=无效判）", async () => {
    const out = await executeTool("record_book_assessment", {
      title: "影响力", chapterTitle: "1", kind: "explain",
      question: "q", answer: "a", level: "partial", evidence: "", feedback: "f",
    });
    expect(out.result.ok).toBe(false);
    expect(out.result.content).toContain("判分依据");
  });
  it("level 不合法 → 拒绝", async () => {
    expect((await executeTool("record_book_assessment", {
      title: "影响力", chapterTitle: "1", kind: "explain", question: "q", answer: "a", level: "pass", evidence: "e", feedback: "f",
    })).result.ok).toBe(false);
  });
});

describe("update_book（R02：字段差异预览）", () => {
  it("新旧书名/作者差异进预览，应用后 updateBook", async () => {
    const out = await executeTool("update_book", { title: "影响力", newTitle: "影响力（新增第7原则）", author: "罗伯特·B. 西奥迪尼" });
    expect(out.action!.payload.preview).toContain("书名：《影响力》 → 《影响力（新增第7原则）》");
    await executeAction(out.action!);
    expect(applied.find((a) => a.fn === "updateBook")).toBeTruthy();
  });
  it("重名拒绝", async () => {
    mutableState.books = [seedBook(), { ...seedBook(), id: "bk-2", title: "先发影响力" }];
    expect((await executeTool("update_book", { title: "影响力", newTitle: "先发影响力" })).result.ok).toBe(false);
  });
});

describe("remove_book（R02：影响范围先展示）", () => {
  it("审批卡列出章节/对话/沉淀/验收数量与不可恢复提示", async () => {
    const out = await executeTool("remove_book", { title: "影响力" });
    expect(out.action!.payload.preview).toContain("3 章");
    expect(out.action!.payload.preview).toContain("不可恢复");
    await executeAction(out.action!);
    expect(applied.find((a) => a.fn === "removeBook")!.args).toEqual(["bk-1"]);
  });
});

describe("rebuild_reading_route（R04：先预览后应用）", () => {
  it("校验期生成新路线，预览含新旧对照；批准后先快照再写入", async () => {
    const out = await executeTool("rebuild_reading_route", { title: "影响力", routeType: "core", userNote: "只留核心" });
    expect(out.result.ok).toBe(true);
    expect(out.action!.payload.preview).toContain("原：");
    expect(out.action!.payload.preview).toContain("新：");
    expect(out.action!.payload.preview).toContain("可恢复");
    expect((out.action!.payload.plan as { chapters: unknown[] }).chapters).toHaveLength(2);
    const res = await executeAction(out.action!);
    expect(res.ok).toBe(true);
    expect(applied.find((a) => a.fn === "snapshotBookRoute")!.args[0]).toBe("bk-1");
    const regen = applied.find((a) => a.fn === "regenerateBookRoute")!;
    expect((regen.args[1] as { routeType: string }).routeType).toBe("core");
  });
  it("routeType 不合法 → 拒绝且不生成", async () => {
    const out = await executeTool("rebuild_reading_route", { title: "影响力", routeType: "fast" });
    expect(out.result.ok).toBe(false);
    expect(applied.some((a) => a.fn === "regenerateBookRoute")).toBe(false);
  });
});

describe("restore_book_route（R04：恢复入口）", () => {
  it("有历史时生成恢复预览；应用后 restoreBookRoute", async () => {
    mutableState.books = [
      seedBook({
        routeHistory: [{ id: "rh_1", at: "2026-11-01T10:00:00Z", reason: "重排为core路线", routeType: "core", chapters: [chapter("c9", "旧节点")] }],
      }),
    ];
    const out = await executeTool("restore_book_route", { title: "影响力" });
    expect(out.action!.payload.preview).toContain("恢复为：");
    expect(out.action!.payload.preview).toContain("可再回退");
    await executeAction(out.action!);
    expect(applied.find((a) => a.fn === "restoreBookRoute")!.args).toEqual(["bk-1", "rh_1"]);
  });
  it("无历史 → 明确拒绝", async () => {
    const out = await executeTool("restore_book_route", { title: "影响力" });
    expect(out.result.ok).toBe(false);
    expect(out.result.content).toContain("还没有路线历史");
  });
});

/* ===== 批次 D（AG-06：人生伙伴与圆桌 C01/C02/C05/C06）===== */

const sess = (id: string, title: string, msgs: { role: "user" | "assistant"; content: string }[] = [], participants?: string[]) =>
  ({ id, title, personaId: participants ? "roundtable" : "solo", participants, messages: msgs.map((m, i) => ({ id: `m${i}`, ...m, at: "2026-11-01" })), createdAt: "2026-11-01" });

describe("get_session（C01：找回会话上下文）", () => {
  it("返回与会人物/议题/最近消息/接续入口", async () => {
    mutableState.sessions = [
      sess("s1", "要不要辞职创业", [
        { role: "user", content: "我在纠结要不要辞职创业，存款只够两年。" },
        { role: "assistant", content: "先拆一下风险承受…" },
      ], ["custom:p1", "custom:p2"]),
    ];
    const out = await executeTool("get_session", { title: "辞职创业" });
    expect(out.result.content).toContain("id=s1");
    expect(out.result.content).toContain("与会人物：custom:p1、custom:p2");
    expect(out.result.content).toContain("存款只够两年");
    expect(out.result.content).toContain("/council");
  });
  it("近名多会话 → 候选消歧", async () => {
    mutableState.sessions = [sess("s1", "考研还是工作"), sess("s2", "考研择校")];
    const out = await executeTool("get_session", { title: "考研" });
    expect(out.result.content).toContain("个相近会话");
  });
});

describe("create_session（C02：阵容与议题完整传入）", () => {
  it("participants + opening 进 payload；应用后首条消息为议题", async () => {
    const out = await executeTool("create_session", {
      title: "要不要裸辞", personaId: "roundtable",
      participants: ["custom:p1", "custom:p2"],
      opening: "纠结要不要裸辞：存款两年，行业下行。",
    });
    expect(out.action!.payload.preview).toContain("议题作为第一条消息");
    expect(out.action!.payload.participants).toEqual(["custom:p1", "custom:p2"]);
    await executeAction(out.action!);
    const added = applied.find((a) => a.fn === "addSession")!.args[0] as { participants?: string[]; messages: { content: string }[] };
    expect(added.participants).toEqual(["custom:p1", "custom:p2"]);
    expect(added.messages[0].content).toContain("裸辞");
  });
  it("无 opening → 空会话", async () => {
    const out = await executeTool("create_session", { title: "随便聊聊" });
    await executeAction(out.action!);
    expect(((applied.find((a) => a.fn === "addSession")!.args[0]) as { messages: unknown[] }).messages).toHaveLength(0);
  });
});

describe("manage_session（C06：重命名/删除）", () => {
  beforeEach(() => {
    mutableState.sessions = [sess("s1", "旧会话名", [{ role: "user", content: "hi" }])];
  });
  it("rename：预览新旧名，应用后 updateSession", async () => {
    const out = await executeTool("manage_session", { action: "rename", title: "旧会话名", newTitle: "新会话名" });
    expect(out.action!.payload.preview).toContain("新会话名");
    await executeAction(out.action!);
    expect(applied.find((a) => a.fn === "updateSession")!.args).toEqual(["s1", { title: "新会话名" }]);
  });
  it("delete：影响先展示（消息数），应用后 removeSession", async () => {
    const out = await executeTool("manage_session", { action: "delete", title: "旧会话名" });
    expect(out.action!.payload.preview).toContain("1 条消息");
    expect(out.action!.payload.preview).toContain("不可恢复");
    await executeAction(out.action!);
    expect(applied.find((a) => a.fn === "removeSession")!.args).toEqual(["s1"]);
  });
  it("action 不合法 → 拒绝", async () => {
    expect((await executeTool("manage_session", { action: "archive", title: "旧会话名" })).result.ok).toBe(false);
  });
});

describe("forge_persona（C05：蒸馏→核对→入库）", () => {
  it("身份摘要在预览中供核对；应用后 addCustomPersona 且 id 带 custom: 前缀", async () => {
    const out = await executeTool("forge_persona", { name: "张居正", hint: "改革推进的视角" });
    expect(out.result.ok).toBe(true);
    expect(out.action!.payload.preview).toContain("身份核对");
    expect(out.action!.payload.preview).toContain("模拟");
    await executeAction(out.action!);
    const added = applied.find((a) => a.fn === "addCustomPersona")!.args[0] as { id: string; name: string; identityNote: string };
    expect(added.id.startsWith("custom:")).toBe(true);
    expect(added.identityNote).toContain("模拟");
  });
  it("缺 name → 拒绝", async () => {
    expect((await executeTool("forge_persona", {})).result.ok).toBe(false);
  });
});