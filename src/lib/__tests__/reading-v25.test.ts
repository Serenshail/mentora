import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

/* Node 环境没有 localStorage：zustand persist 的 setItem 会炸（同 backup-import.test.ts 先例） */
if (typeof globalThis.localStorage === "undefined") {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => Array.from(mem.keys())[i] ?? null,
      get length() {
        return mem.size;
      },
    },
    configurable: true,
  });
}

import {
  readingAddNodeSchema,
  readingAssessGenSchema,
  readingAssessGradeSchema,
  readingGoalSchema,
  readingGraduationSchema,
  readingPlanSchema,
  readingStrategySchema,
  readingTransferGenSchema,
  readingTransferGradeSchema,
} from "../ai/client";
import { demoReadingSystem } from "../ai/demo";
import { useAppStore } from "../store";

/* ============ schema 容错锁（PRD 2026-11-05）============ */

describe("readingGoalSchema（PRD 4.1 目标推荐）", () => {
  it("合法枚举直通", () => {
    const r = readingGoalSchema.parse({ primary: "apply", secondary: ["think"], reason: "工具书" });
    expect(r.primary).toBe("apply");
    expect(r.secondary).toEqual(["think"]);
  });
  it("非法枚举回落 understand，不炸", () => {
    const r = readingGoalSchema.parse({ primary: "掌握", secondary: ["随便"] });
    expect(r.primary).toBe("understand");
    expect(r.secondary![0]).toBeNull();
  });
});

describe("readingStrategySchema（PRD 4.4 策略调度）", () => {
  it("五模式合法值直通", () => {
    expect(readingStrategySchema.parse({ mode: "collision", reason: "有争议" }).mode).toBe("collision");
    expect(readingStrategySchema.parse({ mode: "recall-check" }).mode).toBe("recall-check");
  });
  it("非法 mode 回落 socratic（不因脏值中断对话）", () => {
    expect(readingStrategySchema.parse({ mode: "讲课" }).mode).toBe("socratic");
  });
});

describe("升级 PRD：迁移 / 结业 / 四级判定", () => {
  it("transfer-gen：任务文本必须非空", () => {
    const r = readingTransferGenSchema.parse({ task: "用互惠原理设计一次真实说服", chapterIds: ["c1"], whyThisTask: "落进用户场景" });
    expect(r.task).toContain("说服");
  });
  it("transfer-grade：三级判定，脏值回落 naming_only", () => {
    expect(readingTransferGradeSchema.parse({ verdict: "used_correct" }).verdict).toBe("used_correct");
    expect(readingTransferGradeSchema.parse({ verdict: "背下来了" }).verdict).toBe("naming_only");
  });
  it("assess-grade：ungradable 是合法四级且不被回落吞掉", () => {
    const r = readingAssessGradeSchema.parse({
      results: [{ kind: "explain", level: "ungradable", evidence: "回答与问题无关", feedback: "换题" }],
    });
    expect(r.results[0]!.level).toBe("ungradable");
  });
  it("graduation：结业笔记 + nextSteps 上限 3 条", () => {
    const ok = readingGraduationSchema.parse({ noteMarkdown: "## 带走了什么", nextSteps: ["a", "b", "c"] });
    expect(ok.nextSteps).toHaveLength(3);
    expect(() => readingGraduationSchema.parse({ noteMarkdown: "x", nextSteps: ["1", "2", "3", "4"] })).toThrow();
  });
});

describe("readingAssessGenSchema / readingAssessGradeSchema（PRD 4.5 三重验收）", () => {
  it("出题：三种维度按目标分布，kind 脏值回落 explain", () => {
    const r = readingAssessGenSchema.parse({
      questions: [
        { kind: "explain", question: "q1" },
        { kind: "迁移", question: "q2" },
        { kind: "apply", question: "q3" },
      ],
    });
    expect(r.questions.map((q) => q.kind)).toEqual(["explain", "explain", "apply"]);
  });
  it("出题：少于 2 题拒绝（三重验收至少两维）", () => {
    expect(() => readingAssessGenSchema.parse({ questions: [{ kind: "explain", question: "q" }] })).toThrow();
  });
  it("判分：evidence/feedback 允许 null（诚实留白不炸）", () => {
    const r = readingAssessGradeSchema.parse({
      results: [{ kind: "explain", level: "partial", evidence: null, feedback: null }],
      suggestion: "重读第二段",
    });
    expect(r.results[0].level).toBe("partial");
    expect(r.suggestion).toBe("重读第二段");
  });
  it("判分：level 脏值回落 partial（不放水也不误杀）", () => {
    const r = readingAssessGradeSchema.parse({ results: [{ kind: "explain", level: "满分" }] });
    expect(r.results[0].level).toBe("partial");
  });
});

describe("readingAddNodeSchema（PRD 4.3 加节点）", () => {
  it("单节点解析 + knowledgeType 容错", () => {
    const r = readingAddNodeSchema.parse({
      chapter: { title: "拖延专题", knowledgeType: "策略", focusQuestion: "书里怎么看拖延？" },
    });
    expect(r.chapter.knowledgeType).toBe("concept");
    expect(r.chapter.title).toBe("拖延专题");
  });
});

describe("readingPlanSchema v2（认知地图 + 节点新字段）", () => {
  it("map 与 bookProfile 两代输出都能收", () => {
    const v2 = readingPlanSchema.parse({
      map: { coreProblem: "p", authorStance: "a", lineage: "l", controversies: "c" },
      planSummary: "s",
      chapters: [
        { title: "t1", focusQuestion: "f1", keyConcepts: ["k"], prerequisites: [], expectedOutcome: "e", assessFocus: "af" },
        { title: "t2", focusQuestion: "f2" },
        { title: "t3", focusQuestion: "f3" },
      ],
    });
    expect(v2.map?.coreProblem).toBe("p");
    expect(v2.chapters[0].assessFocus).toBe("af");
    const v1 = readingPlanSchema.parse({
      bookProfile: { positioning: "p", author: "a", lineage: "l", controversies: "c" },
      planSummary: "s",
      chapters: [
        { title: "t1", focusQuestion: "f1" },
        { title: "t2", focusQuestion: "f2" },
        { title: "t3", focusQuestion: "f3" },
      ],
    });
    expect(v1.bookProfile?.positioning).toBe("p");
    expect(v1.chapters[0].keyConcepts).toBeUndefined();
  });
});

/* ============ Demo 同形状锁（演示模式必须走通全部新闭环）============ */

describe("demoReadingSystem：六个新任务的演示输出全部过得了 schema", () => {
  const collect = async (task: string, args: Record<string, unknown> = {}) => {
    let out = "";
    for await (const chunk of demoReadingSystem(task, args)) out += chunk;
    return out;
  };
  const json = (s: string) => JSON.parse(s.replace(/```json\n?/, "").replace(/\n?```/, ""));

  it("reading-goal → readingGoalSchema", async () => {
    expect(readingGoalSchema.parse(json(await collect("reading-goal"))).primary).toBe("understand");
  });
  it("reading-strategy → readingStrategySchema", async () => {
    expect(readingStrategySchema.parse(json(await collect("reading-strategy"))).mode).toBe("socratic");
  });
  it("reading-assess-gen → readingAssessGenSchema（三题三维度）", async () => {
    const r = readingAssessGenSchema.parse(json(await collect("reading-assess-gen")));
    expect(r.questions).toHaveLength(3);
    expect(r.questions.map((q) => q.kind)).toEqual(["explain", "connect", "apply"]);
  });
  it("reading-assess-grade → readingAssessGradeSchema（空白=not，有答=partial，证据非空）", async () => {
    const args = { qa: JSON.stringify([{ answer: "" }, { answer: "我觉得它说的是对的因为……" }, { answer: "" }]) };
    const r = readingAssessGradeSchema.parse(json(await collect("reading-assess-grade", args)));
    expect(r.results.map((x) => x.level)).toEqual(["not", "partial", "not"]);
    expect(r.results[1].evidence).toContain("你说");
  });
  it("reading-add-node → readingAddNodeSchema", async () => {
    expect(readingAddNodeSchema.parse(json(await collect("reading-add-node", { interest: "拖延" }))).chapter.title).toContain("拖延");
  });
  it("reading-recap → Markdown 正文（不输出代码块）", async () => {
    const md = await collect("reading-recap");
    expect(md).toContain("## ");
    expect(md).not.toContain("```");
  });
  it("reading-transfer-gen → readingTransferGenSchema（演示任务为真实场景应用题）", async () => {
    const r = readingTransferGenSchema.parse(json(await collect("reading-transfer-gen")));
    expect(r.task.length).toBeGreaterThan(20);
  });
  it("reading-transfer-grade → readingTransferGradeSchema（空白=naming_only 不放水）", async () => {
    const blank = readingTransferGradeSchema.parse(json(await collect("reading-transfer-grade", { answer: "" })));
    expect(blank.verdict).toBe("naming_only");
    const answered = readingTransferGradeSchema.parse(json(await collect("reading-transfer-grade", { answer: "我先给对方有用的东西再提请求" })));
    expect(answered.verdict).toBe("used_correct");
    expect(answered.evidence).toContain("你说");
  });
  it("reading-graduation → readingGraduationSchema（结业笔记+建议≤3）", async () => {
    const g = readingGraduationSchema.parse(json(await collect("reading-graduation")));
    expect(g.noteMarkdown).toContain("## ");
    expect((g.nextSteps ?? []).length).toBeLessThanOrEqual(3);
  });
});

/* ============ store 动作语义锁（状态机/档案保留）============ */

const seedBook = () => {
  const id = "b-test";
  useAppStore.setState({
    books: [
      {
        id,
        title: "测试之书",
        status: "reading",
        readStatus: "reading",
        chapters: [
          { id: "c1", title: "节点一", focusQuestion: "f1", status: "todo" as const, keyConcepts: ["概念A"] },
          { id: "c2", title: "节点二", focusQuestion: "f2", status: "todo" as const },
        ],
        insights: [],
        chat: [],
        createdAt: new Date().toISOString(),
      },
    ],
    knowledge: [],
  });
  return id;
};

describe("阅读系统 store 动作（PRD 硬要求）", () => {
  beforeEach(() => {
    useAppStore.setState({ books: [], knowledge: [] });
  });

  it("setChapterStatus：手动标记 done 不写 masteredAt；回退 todo 清 masteredAt（已读完≠已掌握）", () => {
    const id = seedBook();
    const s = useAppStore.getState();
    s.setChapterStatus(id, "c1", "done");
    expect(useAppStore.getState().books[0].chapters[0].status).toBe("done");
    expect(useAppStore.getState().books[0].chapters[0].masteredAt).toBeUndefined();
    s.markChapterMastered(id, "c1", "证据：用户自己举了例子");
    const after = useAppStore.getState().books[0].chapters[0];
    expect(after.masteredAt).toBeTruthy();
    expect(after.status).toBe("done");
    s.setChapterStatus(id, "c1", "todo");
    expect(useAppStore.getState().books[0].chapters[0].masteredAt).toBeUndefined();
  });

  it("markChapterMastered 同时写学习证据（PRD 5.3 evidence）", () => {
    const id = seedBook();
    useAppStore.getState().markChapterMastered(id, "c1", "能独立解释概念A");
    const b = useAppStore.getState().books[0];
    expect(b.learning?.evidence).toHaveLength(1);
    expect(b.learning?.evidence[0].text).toBe("能独立解释概念A");
  });

  it("regenerateBookRoute：换路线丢章节但验收归档、沉淀/对话/学习状态全保留（PRD 4.1 验收 4）", () => {
    const id = seedBook();
    const s = useAppStore.getState();
    s.markChapterMastered(id, "c1", "旧证据");
    s.addBookDeposit(id, { chapterId: "c1", type: "explanation", text: "我自己的解释" });
    s.addBookMsg(id, { id: "m1", role: "user", content: "hi", at: new Date().toISOString() });
    s.regenerateBookRoute(id, {
      planSummary: "新路线",
      routeType: "goal",
      chapters: [{ id: "n1", title: "新节点", focusQuestion: "nf", status: "todo" as const }],
    });
    const b = useAppStore.getState().books[0];
    expect(b.chapters).toHaveLength(1);
    expect(b.chapters[0].title).toBe("新节点");
    expect(b.routeType).toBe("goal");
    expect(b.assessments).toHaveLength(1); // 旧章节验收已归档（旧 verification 字段为空所以走 mastered 证据）
    expect(b.deposits).toHaveLength(1);
    expect(b.chat).toHaveLength(1);
    expect(b.learning?.evidence).toHaveLength(1);
  });

  it("updateBookLearning：knownConcepts 去重合并、misconceptions 同概念覆盖不重复堆叠", () => {
    const id = seedBook();
    const s = useAppStore.getState();
    s.updateBookLearning(id, { knownConcepts: ["概念A"], addMisconception: { concept: "概念A", note: "第一次答错" } });
    s.updateBookLearning(id, { knownConcepts: ["概念A", "概念B"], addMisconception: { concept: "概念A", note: "搞清楚边界了" } });
    const l = useAppStore.getState().books[0].learning!;
    expect(l.knownConcepts).toEqual(["概念A", "概念B"]);
    expect(l.misconceptions).toHaveLength(1);
    expect(l.misconceptions[0].note).toBe("搞清楚边界了");
  });

  it("setBookReadStatus：五态推进，mastered 同步 status=done（书架徽标不分裂）", () => {
    const id = seedBook();
    const s = useAppStore.getState();
    s.setBookReadStatus(id, "finished");
    expect(useAppStore.getState().books[0].readStatus).toBe("finished");
    expect(useAppStore.getState().books[0].finishedAt).toBeTruthy();
    s.setBookReadStatus(id, "mastered");
    expect(useAppStore.getState().books[0].readStatus).toBe("mastered");
    expect(useAppStore.getState().books[0].status).toBe("done");
  });

  it("moveChapter：上移下移换位，越界不动", () => {
    const id = seedBook();
    const s = useAppStore.getState();
    s.moveChapter(id, "c2", -1);
    expect(useAppStore.getState().books[0].chapters.map((c) => c.id)).toEqual(["c2", "c1"]);
    s.moveChapter(id, "c1", 1);
    expect(useAppStore.getState().books[0].chapters.map((c) => c.id)).toEqual(["c2", "c1"]);
  });

  it("addBookTransfer：记录迁移；used_correct 联动 practice 沉淀+学习证据，naming_only 不沉淀（升级 PRD 2.5/2.6）", () => {
    const id = seedBook();
    const s = useAppStore.getState();
    const base = { chapterIds: ["c1"], task: "用互惠设计一次说服", answer: "我先给对方一个有用的东西再提请求", evidence: "你说：我先给再提", feedback: "机制用对了" };
    s.addBookTransfer(id, { ...base, verdict: "used_correct" });
    const after = useAppStore.getState().books[0];
    expect(after.transfers).toHaveLength(1);
    expect(after.transfers![0].verdict).toBe("used_correct");
    expect(after.deposits!.some((d) => d.type === "practice")).toBe(true);
    expect(after.learning!.evidence.some((e) => e.text.includes("迁移应用"))).toBe(true);
    s.addBookTransfer(id, { ...base, task: "第二次", verdict: "naming_only" });
    const second = useAppStore.getState().books[0];
    expect(second.transfers).toHaveLength(2);
    expect(second.deposits!.filter((d) => d.type === "practice")).toHaveLength(1); // naming_only 不沉淀
  });

  it("updateBookLearning：clarifyMisconception 标记澄清（升级 PRD 2.4 误解→澄清两态）", () => {
    const id = seedBook();
    const s = useAppStore.getState();
    s.updateBookLearning(id, { addMisconception: { concept: "互惠", note: "以为互惠=等价交换" } });
    expect(useAppStore.getState().books[0].learning!.misconceptions[0].clarified).toBeFalsy();
    s.updateBookLearning(id, { clarifyMisconception: "互惠" });
    const m = useAppStore.getState().books[0].learning!.misconceptions[0];
    expect(m.clarified).toBe(true);
    expect(m.note).toBe("以为互惠=等价交换"); // 澄清保留原证据，不删除
  });
});
