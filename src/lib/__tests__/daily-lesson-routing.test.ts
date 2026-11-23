import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* prompts.ts 是服务端模块（import "server-only"），在 vitest 里需要豁免该护栏 */
vi.mock("server-only", () => ({}));

import { DAILY_LESSON } from "../ai/prompts";

/* ============ DAILY_LESSON 领域/知识类型路由的回归锁 ============
 * 背景（两处独立缺陷）：
 *  ① 知识类型路由形同虚设：prompts.ts 有 knowledgeType→FACT/CONCEPT/… 的分支，
 *     但生产链路（learn/[id]/page.tsx 生成讲义时的 ctx）从不带 knowledgeType，
 *     于是 fact 型日子（如雅思词汇）永远落到领域模板，「优先按类型选模板」静默失效。
 *     修复：caller 把当日主知识类型随 ctx 上行（见下方源码扫描断言）。
 *  ② 数学模板误路由：旧 mathy 词表用「函数/统计/概率/物理」等跨域歧义裸子串，
 *     会把「计算机二级 C 语言（掌握函数、数组、指针）」「Excel 函数与数据处理」
 *     误切进 MATH_LESSON（该模板明说默认不出现代码）。
 * 这里锁路由结果（模板靠首句特征串区分）与 caller 的 ctx 契约。 */

const ctxOf = (goal: Record<string, unknown>) => JSON.stringify({ goal });

describe("DAILY_LESSON 领域/知识类型路由", () => {
  it("knowledgeType=fact → FACT_LESSON（知识类型优先于领域模板）", () => {
    const out = DAILY_LESSON(ctxOf({ topic: "雅思核心词汇", domainKind: "language", knowledgeType: "fact" }));
    expect(out).toContain("事实/术语/定义");
  });

  it("knowledgeType=concept + 领域数学 → MATH_LESSON；领域编程 → CONCEPT_LESSON（不误进数学）", () => {
    expect(DAILY_LESSON(ctxOf({ topic: "考研数学", direction: "高数与线性代数", domainKind: "exam", knowledgeType: "concept" }))).toContain("数学类学科");
    const coding = DAILY_LESSON(ctxOf({ topic: "手写解释器", domainKind: "coding", knowledgeType: "concept" }));
    expect(coding).not.toContain("数学类学科");
    expect(coding).toContain("概念/原理/因果关系");
  });

  it("数学类 topic/direction 仍正确走 MATH_LESSON", () => {
    const out = DAILY_LESSON(ctxOf({ topic: "考研数学", direction: "高数与线性代数", domainKind: "exam" }));
    expect(out).toContain("数学类学科");
  });

  it("编程备考含「函数/数组/指针」不被误路由进 MATH_LESSON（走备考模板）", () => {
    const out = DAILY_LESSON(ctxOf({ topic: "计算机二级 C 语言", direction: "掌握函数、数组、指针", domainKind: "exam" }));
    expect(out).not.toContain("数学类学科");
    expect(out).toContain("备考");
  });

  it("「Excel 函数与数据处理」（other）走 GENERIC_LESSON 而非 MATH_LESSON", () => {
    const out = DAILY_LESSON(ctxOf({ topic: "Excel 函数与数据处理", domainKind: "other" }));
    expect(out).not.toContain("数学类学科");
    expect(out).toContain("通用技能");
  });

  it("残留歧义词「物理」在无编程语境时仍走 MATH_LESSON（收窄不误伤真数学/物理）", () => {
    const out = DAILY_LESSON(ctxOf({ topic: "高中物理", direction: "力学与电磁学公式推导", domainKind: "exam" }));
    expect(out).toContain("数学类学科");
  });
});

describe("生产链路必须把主知识类型随讲义 ctx 上行", () => {
  it("learn/[id]/page.tsx 的讲义 ctx 带 knowledgeType（否则类型路由永不生效）", () => {
    const src = readFileSync(join(process.cwd(), "src/app/learn/[id]/page.tsx"), "utf8");
    /* 讲义生成处（task: "lesson" 的 ctx 构造）必须把当日主知识类型写进 ctx，
     * DAILY_LESSON 才能按 prompts.ts 的类型分支选模板。字段名按现状锁定。 */
    expect(src).toMatch(/knowledgeType:\s*mainKnowledgeType/);
  });
});
