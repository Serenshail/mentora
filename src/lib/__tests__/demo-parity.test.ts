import { describe, expect, it } from "vitest";
import { demoGraduation, demoInsight, demoPlan, demoQuizGrade, demoReviewGrade } from "../ai/demo";
import {
  extractJson,
  graduationSchema,
  insightsSchema,
  masterPlanSchema,
  normalizeQuizGrade,
  normalizeReviewGrade,
  phaseListSchema,
  phasePlanSchema,
  quizGradeSchema,
  reviewGradeSchema,
} from "../ai/client";

/* 演示模式必须与真实链路同语义、同形状（ACCEPTANCE R1「Demo 真实性」的延伸）。
 * 做法：拿真实页面在用的那几套 zod schema 去 parse demo 的输出——
 * demo 一旦输出被淘汰过的形状（旧 planSchema），或者给出没有依据的 pass，
 * 这里立刻红。过去 demo 的判分就是后者：它发 verdict:"pass" 却没有 evidence，
 * 被 normalizeQuizGrade 降级成 ungradable→fail，演示者永远"验收不通过"。 */

async function drain(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const c of gen) out += c;
  return out;
}

const LESSON = [
  "## 今日掌握",
  "- **容器的增删改查与推导式**：日常 80% 的代码都在干这个",
  "",
  "## 讲解",
  "看这个完整的例子（迷你任务清单）：",
].join("\n");

describe("demo 计划生成：三种形状各用对应的真实 schema", () => {
  it("master（总纲要）→ masterPlanSchema", async () => {
    const card = JSON.stringify({ topic: "Python", weeklyHours: 8, successCriteria: ["能写小工具"] });
    const system = `你是 Mentora 的首席学习架构师。制定**总学习纲要**。\n\n## 目标卡\n${card}`;
    const parsed = masterPlanSchema.parse(extractJson(await drain(demoPlan(system))));
    expect(parsed.phases.length).toBeGreaterThanOrEqual(1);
    for (const p of parsed.phases) {
      expect(p.outcome.length).toBeGreaterThan(4);
      expect(p.outline.length).toBeGreaterThan(0);
      expect(p.boundary).toBeTruthy();
      expect(p.estDays).toBeTypeOf("number");
    }
    expect(JSON.stringify(parsed)).toContain("Python");
  });

  it("phase-list（天清单）→ phaseListSchema，且不超上限", async () => {
    const system = "本轮先为这个阶段排出「天」清单。\n## 本轮产出标准\n拆成 **最多 2 天**（这是硬上限）\n本轮只出清单，务必紧凑。";
    const parsed = phaseListSchema.parse(extractJson(await drain(demoPlan(system))));
    expect(parsed.days.length).toBeLessThanOrEqual(2);
    expect(parsed.boundary).toBeTruthy();
    for (const d of parsed.days) {
      expect(d.knowledgePoints.length).toBeGreaterThan(0);
    }
  });

  it("phase-detail（天细节）→ phasePlanSchema，标题与知识点原文照抄", async () => {
    const requested = [
      { title: "Day 5：需求拆解与骨架", knowledgePoints: ["需求拆解", "最小可运行版本"] },
    ];
    const system =
      "下面已经给出这个阶段的「天清单」，本轮只为清单里指定的那几天写出完整细节。\n" +
      "## 本阶段边界\n范围：只做小项目。不学：CI/CD。\n" +
      `## 本轮要写的天（title 与 knowledgePoints 原文照抄，不得增删改、不得重新编号）\n${JSON.stringify(requested)}\n` +
      "## 每天的细节标准\n1. knowledgePoints …";
    const parsed = phasePlanSchema.parse(extractJson(await drain(demoPlan(system))));
    expect(parsed.days).toHaveLength(1);
    expect(parsed.days[0].title).toBe("Day 5：需求拆解与骨架");
    expect(parsed.days[0].knowledgePoints.map((k) => (typeof k === "string" ? k : k.text))).toEqual([
      "需求拆解",
      "最小可运行版本",
    ]);
    expect(parsed.days[0].acceptance.length).toBeGreaterThanOrEqual(2);
    expect(parsed.days[0].resources.length).toBeGreaterThan(0);
  });
});

describe("demo 判分：没有讲义原文就不许算通过", () => {
  const ctxWithLesson = JSON.stringify({
    day: "Day 1：核心数据结构",
    knowledgePoints: ["容器的增删改查与推导式", "不可变与可变的区别"],
    lesson: LESSON,
    items: [
      { itemId: "a1", kind: "apply", question: "改一个变体" },
      { itemId: "a2", kind: "explain", question: "讲清选用场景" },
    ],
    answers: { a1: "我这样改…", a2: "因为…" },
  });

  it("讲义在场：每条正向判定都带讲义原文，normalize 后仍是 pass", async () => {
    const g = normalizeQuizGrade(
      quizGradeSchema.parse(extractJson(await drain(demoQuizGrade(`## 材料\n${ctxWithLesson}`))))
    );
    expect(g.overall).toBe("pass");
    for (const it of g.items) {
      expect(it.verdict).toBe("correct");
      expect(it.evidence).toBeTruthy();
      expect(LESSON).toContain(it.evidence); // 依据必须能在讲义里逐字找到
    }
    expect(g.transferQuestion).toBeTruthy(); // 通过必出迁移题，真门才有东西可答
  });

  it("讲义缺失：判 ungradable、overall fail，不假装通过", async () => {
    const noLesson = JSON.stringify({
      day: "Day 1",
      knowledgePoints: ["容器的增删改查"],
      lesson: "",
      items: [{ itemId: "a1", kind: "apply", question: "改一个变体" }],
      answers: { a1: "…" },
    });
    const g = normalizeQuizGrade(quizGradeSchema.parse(extractJson(await drain(demoQuizGrade(noLesson)))));
    expect(g.overall).toBe("fail");
    expect(g.items[0].verdict).toBe("ungradable");
  });
});

describe("demo 复习判分：引用笔记原文才算通过", () => {
  it("摘录在场 → pass 且带证据", async () => {
    const ctx = JSON.stringify({
      note: "闭包与状态快照",
      excerpt: "闭包捕获的是变量本身，不是当时的值；要固定值就用默认参数或 IIFE 拷贝一份。",
      question: "闭包容易在哪翻车？",
      answer: "捕获变量本身，循环里就共享了。",
    });
    const g = normalizeReviewGrade(reviewGradeSchema.parse(extractJson(await drain(demoReviewGrade(`## 材料\n${ctx}`)))));
    expect(g.verdict).toBe("pass");
    expect(g.evidence).toBeTruthy();
    expect(ctx).toContain(g.evidence);
  });

  it("没有摘录 → fail（不给『感觉记住了』放水）", async () => {
    const ctx = JSON.stringify({ note: "某笔记", excerpt: "", question: "q", answer: "a" });
    const g = normalizeReviewGrade(reviewGradeSchema.parse(extractJson(await drain(demoReviewGrade(ctx)))));
    expect(g.verdict).toBe("fail");
  });
});

describe("demo 读书洞见与结业", () => {
  it("用户说过实质内容才提炼；没有就如实空数组", async () => {
    const chat = "用户：我觉得这里的关键不是语法，而是状态该放在哪儿。\n\n伙伴：那你会怎么判断？";
    const parsed = insightsSchema.parse(extractJson(await drain(demoInsight(`## 对话\n${chat}`))));
    expect(parsed.insights).toHaveLength(1);
    expect(parsed.insights[0].title).toContain("状态");

    const empty = insightsSchema.parse(extractJson(await drain(demoInsight("## 对话\n伙伴：你怎么看？"))));
    expect(empty.insights).toEqual([]);
  });

  it("结业笔记过 schema，且只用材料里真实的数字", async () => {
    const ctx = JSON.stringify({
      topic: "Python 基础",
      completedDays: 7,
      knowledgePoints: [{ text: "容器增删改查" }, { text: "闭包" }],
      failures: [],
    });
    const g = graduationSchema.parse(extractJson(await drain(demoGraduation(`## 材料（JSON）\n${ctx}`))));
    expect(g.noteMarkdown).toContain("Python 基础");
    expect(g.noteMarkdown).toContain("7 天");
    expect(g.nextSteps.length).toBeGreaterThan(0);
    expect(g.nextSteps.length).toBeLessThanOrEqual(3);
  });
});
