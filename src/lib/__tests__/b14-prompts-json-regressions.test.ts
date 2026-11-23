import { describe, expect, it, vi } from "vitest";

/* ============ 修复批次 b14：prompts / json 回归锁 ============
 *  ① DAILY_LESSON：procedure 型知识在非编程/非语言领域不得切进 CODING_LESSON；
 *  ② DAILY_LESSON：纯数学「函数」主题必须进 MATH_LESSON，编程语境的「函数」不误伤；
 *  ③ meta 抽取必须容忍 JSON 转义引号（不再在 \" 处截断）；
 *  ④ AGENT_CHAT：显式指令优先原则必须给绝对红线留豁免（不得被包装成显式指令越狱）；
 *  ⑤ extractJson：正文引用标记 [1] 不得抢在真 JSON 之前被返回。 */

vi.mock("server-only", () => ({}));

import { DAILY_LESSON, AGENT_CHAT } from "../ai/prompts";
import { extractJson } from "../ai/json";

const ctxOf = (goal: Record<string, unknown>) => JSON.stringify({ goal });

describe("DAILY_LESSON：procedure × 非编程领域", () => {
  it("考研数学的 procedure 天 → 数学讲义，不是编程讲义", () => {
    const out = DAILY_LESSON(ctxOf({ topic: "考研数学", direction: "高数与线性代数", domainKind: "exam", knowledgeType: "procedure" }));
    expect(out).toContain("数学类学科");
    expect(out).not.toContain("用户在学**编程**");
  });

  it("政治的 procedure 天 → 人文讲义，不是编程讲义", () => {
    const out = DAILY_LESSON(ctxOf({ topic: "考研政治", direction: "马原答题", domainKind: "humanities", knowledgeType: "procedure" }));
    expect(out).toContain("人文社科");
    expect(out).not.toContain("用户在学**编程**");
  });

  it("编程的 procedure 天仍然走编程讲义（不误伤正例）", () => {
    const out = DAILY_LESSON(ctxOf({ topic: "Python 爬虫", domainKind: "coding", knowledgeType: "procedure" }));
    expect(out).toContain("用户在学**编程**");
  });

  it("语言的 procedure 天仍走语言讲义", () => {
    const out = DAILY_LESSON(ctxOf({ topic: "日语 N2", domainKind: "language", knowledgeType: "procedure" }));
    expect(out).toContain("语言习得讲义");
  });
});

describe("DAILY_LESSON：函数主题的数学路由", () => {
  it("「一次函数与二次函数图像」→ MATH_LESSON", () => {
    expect(DAILY_LESSON(ctxOf({ topic: "一次函数与二次函数图像", domainKind: "exam" }))).toContain("数学类学科");
  });

  it("「高中函数专题」→ MATH_LESSON", () => {
    expect(DAILY_LESSON(ctxOf({ topic: "高中函数专题", domainKind: "exam" }))).toContain("数学类学科");
  });

  it("编程语境的「函数」仍不进数学讲义", () => {
    const out = DAILY_LESSON(ctxOf({ topic: "计算机二级 C 语言", direction: "掌握函数、数组、指针", domainKind: "exam" }));
    expect(out).not.toContain("数学类学科");
  });
});

describe("DAILY_LESSON：meta 抽取容忍转义引号", () => {
  it("topic 内嵌双引号时，引号后的数学关键词仍能路由", () => {
    const out = DAILY_LESSON(ctxOf({ topic: '概率论"随机过程"入门', direction: "x", domainKind: "other" }));
    expect(out).toContain("数学类学科");
  });
});

describe("AGENT_CHAT：显式指令优先原则给红线留豁免", () => {
  it("核心原则不再声称「用户显式指令 > 一切默认规则」", () => {
    const p = AGENT_CHAT("");
    expect(p).toContain("绝对红线（不可协商）");
    expect(p).toContain("除「绝对红线」外的一切默认规则");
    expect(p).not.toContain("用户显式指令 > 一切默认规则");
  });
});

describe("extractJson：引用标记不得抢在真 JSON 之前", () => {
  it("正文带 [1] 引用标记时返回真 JSON", () => {
    const t = '根据资料[1]，以及资料[2]的结论：\n{"queries":["a","b"]}';
    expect(extractJson<{ queries: string[] }>(t).queries).toEqual(["a", "b"]);
  });

  it("模型真的只输出 [1] 时仍返回它（兜底不丢）", () => {
    expect(extractJson<number[]>("[1]")).toEqual([1]);
  });

  it("裸数组元素是对象时仍返回整个数组", () => {
    const t = '[{"a":1},{"b":2}]';
    expect(extractJson<unknown[]>(t)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("围栏优先，不受正文引用标记影响", () => {
    const t = '见 [1]。\n```json\n{"ok":true}\n```';
    expect(extractJson<{ ok: boolean }>(t).ok).toBe(true);
  });
});
