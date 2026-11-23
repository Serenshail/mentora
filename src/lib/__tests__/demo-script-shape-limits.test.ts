import { describe, expect, it, vi } from "vitest";

/* demo.ts 已加 server-only 护栏（防演示脚本误进浏览器包），测试里豁免 */
vi.mock("server-only", () => ({}));

import { demoCouncil, demoPlan, demoQuizGrade, demoReadingSystem } from "../ai/demo";
import {
  extractJson,
  readingAssessGradeSchema,
  masterPlanSchema,
  phasePlanSchema,
  quizGradeSchema,
} from "../ai/client";

/* 演示脚本的四个「形状/上限」回归锁：
 *  A. parseRequestedDays 不能再用 lastIndexOf("]")——真实 PLANNER_PHASE_DETAIL 在 daysJson 之后
 *     还有「## 输出」JSON 示例，取到的是示例里的 ]，切片横跨规则文本 → parse 必炸 → 展开任意一天
 *     都回退 Day 1 内容并被落库到错误的日期槽位。
 *  B. demoPlan 的 weeklyHours 必须能从 JSON.stringify(goalCard) 的**数字**形态读到
 *     （"weeklyHours": 8 无引号），否则总纲要永远按默认 8 小时生成。
 *  C. demoQuizGrade 的判分项数必须封顶：itemId 个数由请求体可控，配合固定慢速流式会被放大成
 *     数小时长连接 / 数十 MB 输出。
 *  D. demoCouncil 是所有未适配任务的兜底 prose 生成器，必须显式标注「演示模式」，
 *     否则会被调用点当成功结果写入（润色覆盖正文、life-post 当生成文案）。
 *  E. demoReadingSystem 的 reading-assess-grade 对畸形 args.qa 不能退化成原始引擎报错。 */

async function drain(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const c of gen) out += c;
  return out;
}

const LESSON = ["## 今日掌握", "- **容器的增删改查与推导式**：日常 80% 的代码都在干这个", "", "## 讲解", "看这个完整的例子（迷你任务清单）："].join("\n");

describe("parseRequestedDays：括号配平取 JSON 数组（真实提示词尾部有输出示例）", () => {
  /* 与 prompts.ts PLANNER_PHASE_DETAIL 同构：daysJson 之后还有规则文本与「## 输出」示例，
   * 示例里含多个 [ ... ]，lastIndexOf("]") 会取到示例的闭合括号。 */
  const system = [
    "你是 Mentora 的授课设计师。下面已经给出这个阶段的「天清单」，本轮只为清单里**指定的那一天**写出完整细节。",
    "",
    "## 本轮要写的天（title 与 knowledgePoints 原文照抄，不得增删改、不得重新编号）",
    '[{"title":"Day 5：需求拆解与骨架","knowledgePoints":["需求拆解","最小可运行版本"]}]',
    "",
    "## 每天的细节标准",
    "1. knowledgePoints：把清单里的知识点逐条转成对象 [示例 1] [示例 2]",
    "2. resources：每天 2-3 条直接资料（标题里可能有 [方括号]）",
    "",
    "## 输出",
    "只输出一个 json 代码块，不要任何解释：",
    "```json",
    "{",
    '  "days": [',
    '    { "title": "Day 1：xxx", "knowledgePoints": [{"text": "...", "knowledgeType": "concept"}] }',
    "  ]",
    "}",
    "```",
    "本轮只写上面指定的那一天，每天 ≤ 300 tokens，宁缺毋滥。",
  ].join("\n");

  it("展开的是请求的那一天，而不是 Day 1 默认模板", async () => {
    const parsed = phasePlanSchema.parse(extractJson(await drain(demoPlan(system))));
    expect(parsed.days).toHaveLength(1);
    expect(parsed.days[0].title).toBe("Day 5：需求拆解与骨架");
    expect(
      parsed.days[0].knowledgePoints.map((k) => (typeof k === "string" ? k : k.text))
    ).toEqual(["需求拆解", "最小可运行版本"]);
  });
});

describe("demoPlan 总纲要：weeklyHours 读数字形态", () => {
  it('ctx 里 "weeklyHours": 12（无引号 number）→ 摘要按 12 小时，而不是默认 8', async () => {
    const card = JSON.stringify({ topic: "Python", weeklyHours: 12, successCriteria: ["能写小工具"] });
    const system = `你是 Mentora 的首席学习架构师。制定**总学习纲要**。\n\n## 目标卡\n${card}`;
    const out = await drain(demoPlan(system));
    expect(out).toContain("每周 12 小时");
    expect(out).not.toContain("每周 8 小时");
    masterPlanSchema.parse(extractJson(out));
  });

  it("带引号的旧形态仍兼容", async () => {
    const system = '你是 Mentora 的首席学习架构师。制定**总学习纲要**。\n\n## 目标卡\n{"topic":"Python","weeklyHours":"6","successCriteria":["x"]}';
    expect(await drain(demoPlan(system))).toContain("每周 6 小时");
  });
});

describe("demoQuizGrade：判分项数量封顶", () => {
  /* 封顶后的 20 条仍以演示流的固定慢速（≈500B/s）流出 ≈5KB，需要比默认 5s 更宽的超时——
   * 这正是「不封顶会被放大成数小时长连接」的现场量级。 */
  it(
    "ctx 里塞 200 个 itemId → 输出 items ≤ 20（不被放大成长连接/大响应）",
    async () => {
      const items = Array.from({ length: 200 }, (_, i) => ({ itemId: `q${i}`, question: "q" }));
      const system = `## 材料\n${JSON.stringify({ day: "Day 1", lesson: LESSON, items })}`;
      const g = quizGradeSchema.parse(extractJson(await drain(demoQuizGrade(system))));
      expect(g.items.length).toBe(20);
      expect(g.items.length).toBeLessThan(items.length);
    },
    30_000
  );

  it("正常 3 题不受影响", async () => {
    const system = `## 材料\n${JSON.stringify({ lesson: LESSON, items: [{ itemId: "a" }, { itemId: "b" }, { itemId: "c" }] })}`;
    const g = quizGradeSchema.parse(extractJson(await drain(demoQuizGrade(system))));
    expect(g.items.map((i) => i.itemId)).toEqual(["a", "b", "c"]);
  });
});

describe("demoCouncil：兜底话术必须标注演示模式", () => {
  it("输出首行含（演示模式），不冒充成功结果", async () => {
    const out = await drain(demoCouncil([{ role: "user", content: "帮我把这篇笔记润色一下" }]));
    expect(out).toContain("（演示模式）");
    expect(out.indexOf("（演示模式）")).toBeLessThan(out.indexOf("我的判断"));
  });
});

describe("demoReadingSystem：reading-assess-grade 对畸形 args.qa 降级而不是报错", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["非法 JSON", { qa: "{{{" }],
    ["合法 JSON 但非数组", { qa: "5" }],
    ["缺省", {}],
  ];
  for (const [name, args] of cases) {
    it(`${name} → 仍返回 schema 合法、可判的结果（一题空答=not）`, async () => {
      const out = await drain(demoReadingSystem("reading-assess-grade", args));
      const parsed = readingAssessGradeSchema.parse(extractJson(out));
      expect(parsed.results.length).toBeGreaterThanOrEqual(1);
      expect(parsed.results[0].level).toBe("not");
    });
  }

  it("正常 qa：逐题 partial，行为不变", async () => {
    const qa = [
      { kind: "explain", answer: "我认为核心是……" },
      { kind: "connect", answer: "" },
    ];
    const parsed = readingAssessGradeSchema.parse(
      extractJson(await drain(demoReadingSystem("reading-assess-grade", { qa: JSON.stringify(qa) })))
    );
    expect(parsed.results.map((r) => r.level)).toEqual(["partial", "not"]);
  });
});
