import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 schema 归一化：字符串小数 + null 数组元素（回归锁） ============
 * 事故一（utils/schema.js num() 旧实现）：非数值输入走
 * parseInt(String(v).replace(/[^\d-]/g, ""), 10)——小数点被当杂字符删除，
 * 模型以字符串给出 weeklyHours:"2.5" / estDays:"1.5" 时归一化成 25/15：
 * 目标卡每周小时数十倍膨胀（钳到 1-80 后仍失真）；阶段 estDays 膨胀把
 * buildPhaseCtx 的 maxDays 钳到上限 8。数值形态 2.5 反而正确（typeof 直通）。
 * 修复：保留点号后 parseFloat，"2.5"/"2.5小时" 归一化为 2.5，与数值形态一致。
 *
 * 事故二：normMasterPlan/normPhaseList/normPhaseDay(acceptance)/normResource
 * 对数组元素直接取属性，phases:[null] / days:[null] / acceptance:[null] /
 * resources:[null] 整次归一化以 "Cannot read property …" TypeError 失败——
 * 调用方的 catch 只能 toast 出英文技术串，违反本模块「格式容错只降级不炸」
 * 纪律（normAssessGen/normAssessGrade 对同类情况早有 q==null 防护）。
 * 修复：null/非对象元素跳过或归一化成会被现有 filter 剔除的空条目。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();
const SCHEMA_PATH = join(ROOT, "miniprogram/utils/schema.js");

type Dict = Record<string, unknown>;

type SchemaMod = {
  splitGoalReply: (t: string) => { prose: string; card: Dict | null };
  normMasterPlan: (d: unknown) => { summary: string; phases: Dict[] };
  normPhaseList: (d: unknown) => { boundary: string; days: Dict[] };
  phaseDraftToDay: (d: unknown, phaseId: string, dayId: string) => Dict;
  buildPhaseCtx: (goal: unknown, phase: unknown) => { ctx: string; maxDays: number };
};

function loadSchema(): SchemaMod {
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
  };
  delete requireCjs.cache[SCHEMA_PATH];
  return requireCjs(SCHEMA_PATH) as SchemaMod;
}

const card = (weeklyHours: unknown) =>
  `{"topic":"T","direction":"D","motivation":"M","successCriteria":["a"],"weeklyHours":${JSON.stringify(
    weeklyHours,
  )}}`;

describe("mp schema num() 字符串小数", () => {
  it("weeklyHours \"2.5\" → 2.5（不再变成 25）", () => {
    const s = loadSchema();
    const r = s.splitGoalReply(card("2.5")) as { card: Dict | null };
    expect(r.card && r.card.weeklyHours).toBe(2.5);
  });

  it("weeklyHours \"2.5小时\"（带单位）→ 2.5", () => {
    const s = loadSchema();
    const r = s.splitGoalReply(card("2.5小时")) as { card: Dict | null };
    expect(r.card && r.card.weeklyHours).toBe(2.5);
  });

  it("数值形态直通与整数字符串不回归", () => {
    const s = loadSchema();
    expect(((s.splitGoalReply(card(2.5)) as { card: Dict }).card as Dict).weeklyHours).toBe(2.5);
    expect(((s.splitGoalReply(card("5")) as { card: Dict }).card as Dict).weeklyHours).toBe(5);
  });

  it("estDays \"1.5\" → 1.5；buildPhaseCtx 的 maxDays 钳制口径不变形", () => {
    const s = loadSchema();
    const mp = s.normMasterPlan({
      summary: "s",
      phases: [{ title: "p1", outcome: "o", estDays: "1.5", outline: ["a"] }],
    }) as { phases: Dict[] };
    expect(mp.phases[0].estDays).toBe(1.5);

    const goal = { topic: "t", direction: "d", quizLog: [] };
    expect((s.buildPhaseCtx(goal, { title: "p", estDays: 1.5, outline: [] }) as Dict).maxDays).toBe(2);
  });
});

describe("mp schema null 数组元素只降级不炸", () => {
  it("phases:[null, 有效] → null 元素被跳过", () => {
    const s = loadSchema();
    const r = s.normMasterPlan({
      summary: "s",
      phases: [null, { title: "p1", outcome: "o", outline: ["a"] }],
    }) as { phases: Dict[] };
    expect(r.phases.map((p) => p.title)).toEqual(["p1"]);
  });

  it("days:[null, 有效] → null 元素被跳过", () => {
    const s = loadSchema();
    const r = s.normPhaseList({
      boundary: "b",
      days: [null, { title: "d1", knowledgePoints: ["k"] }],
    }) as { days: Dict[] };
    expect(r.days).toEqual([{ title: "d1", knowledgePoints: ["k"] }]);
  });

  it("acceptance/resources:[null, 有效] → null 元素被过滤，不抛 TypeError", () => {
    const s = loadSchema();
    const day = s.phaseDraftToDay(
      {
        title: "d",
        knowledgePoints: ["k"],
        acceptance: [null, { kind: "explain", question: "q" }],
        resources: [null, { title: "r", url: "https://x.y" }],
      },
      "ph",
      "d1",
    ) as Dict;
    expect((day.acceptance as Dict[]).map((a) => a.question)).toEqual(["q"]);
    expect((day.resources as Dict[]).map((r) => r.title)).toEqual(["r"]);
  });
});
