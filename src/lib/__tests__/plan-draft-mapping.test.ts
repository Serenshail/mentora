import { describe, expect, it } from "vitest";
import { planSchema, phasePlanSchema, type GoalCard } from "../ai/client";
import { draftToPlan, phaseDraftToDay } from "../plan";

/* 回归锁：draftToPlan（整计划）与 phaseDraftToDay（总纲要→逐阶段单日展开）的
 * resources/example/acceptance 映射必须同口径。曾因两段映射逐字重复、修改只落一处，
 * schema 容错解析出的 year/kind/evergreen 在「总纲要→逐阶段」主流程被丢弃，
 * rankResources 的 kind 权重与 evergreen 降权静默失效。映射现已抽成 plan.ts 内共享函数，
 * 本测试用同一份草稿数据分别走两条流程，锁死「输出逐字段一致」。 */

const card: GoalCard = {
  topic: "学 Python",
  direction: "零基础到能写爬虫",
  domainKind: "coding",
  motivation: "转行",
  background: "无编程经验",
  weeklyHours: 10,
  successCriteria: ["独立完成一个爬虫项目"],
};

const rawResources = [
  {
    title: "官方教程",
    url: "https://docs.python.org",
    why: "权威第一手",
    year: "2025年", // 模型常见脏格式：schema 容错解析为 2025
    kind: "doc",
    evergreen: "true", // 字符串布尔：schema 容错解析为 true
  },
  { title: "补充资料", why: "无任何元数据" }, // url/year/kind/evergreen 全缺
];

const rawExample = { title: "迷你项目", description: "写一个命令行 todo", code: "" }; // 空 code 应丢弃

const rawAcceptance = [
  { kind: "理解", question: "用自己的话解释变量" }, // 非法 kind：schema 兜底为 apply
  { kind: "build", question: "实现 todo", hint: "" }, // 空 hint 应丢弃
];

/** 同一份原始草稿，分别走 planSchema+draftToPlan 与 phasePlanSchema+phaseDraftToDay */
function buildBoth() {
  const plan = draftToPlan(
    planSchema.parse({
      summary: "s",
      totalDays: 1,
      weeklyHours: 10,
      phases: [
        {
          title: "阶段1",
          outcome: "o",
          days: [
            {
              title: "Day 1",
              knowledgePoints: ["变量"],
              resources: rawResources,
              method: "讲练结合",
              example: rawExample,
              acceptance: rawAcceptance,
            },
          ],
        },
      ],
    }),
    card
  );
  const planDay = plan.days[plan.phases[0]!.dayIds[0]!]!;
  const phaseDay = phaseDraftToDay(
    phasePlanSchema.parse({
      boundary: "只学核心",
      days: [
        {
          title: "Day 1",
          knowledgePoints: ["变量"],
          resources: rawResources,
          method: "讲练结合",
          example: rawExample,
          acceptance: rawAcceptance,
        },
      ],
    }).days[0]!,
    "ph-x",
    "day-x"
  );
  return { planDay, phaseDay };
}

const stripId = (items: { id: string; kind: string; question: string; hint?: string }[]) =>
  items.map((a) => ({ kind: a.kind, question: a.question, hint: a.hint }));

describe("draftToPlan ↔ phaseDraftToDay 映射同口径（回归锁）", () => {
  it("同一草稿数据：两条流程的 resources/example/acceptance 逐字段一致", () => {
    const { planDay, phaseDay } = buildBoth();
    expect(phaseDay.resources).toEqual(planDay.resources);
    expect(phaseDay.example).toEqual(planDay.example);
    expect(stripId(phaseDay.acceptance)).toEqual(stripId(planDay.acceptance));
  });

  it("容错元数据 year/kind/evergreen 必须带上（事故字段：丢了 rankResources 静默失效）", () => {
    const { planDay, phaseDay } = buildBoth();
    for (const day of [planDay, phaseDay]) {
      expect(day.resources[0]!.year).toBe(2025);
      expect(day.resources[0]!.kind).toBe("doc");
      expect(day.resources[0]!.evergreen).toBe(true);
      // 缺失/null 的可选字段规范化为 undefined（而非 null）
      expect(day.resources[1]!.year).toBeUndefined();
      expect(day.resources[1]!.kind).toBeUndefined();
      expect(day.resources[1]!.evergreen).toBeUndefined();
      expect(day.resources[1]!.url).toBeUndefined();
    }
  });

  it("空串兜底与验收 kind 兜底在两条流程一致", () => {
    const { planDay, phaseDay } = buildBoth();
    for (const day of [planDay, phaseDay]) {
      expect(day.example!.title).toBe("迷你项目");
      expect(day.example!.description).toBe("写一个命令行 todo");
      expect(day.example!.code).toBeUndefined(); // 空串 code 被丢弃
      expect(day.acceptance[0]!.kind).toBe("apply"); // 非法 kind 兜底
      expect(day.acceptance[1]!.kind).toBe("build");
      expect(day.acceptance[1]!.hint).toBeUndefined(); // 空串 hint 被丢弃
    }
  });
});
