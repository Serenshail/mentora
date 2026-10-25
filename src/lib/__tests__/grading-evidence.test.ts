import { describe, expect, it } from "vitest";
import {
  normalizeQuizGrade,
  normalizeReviewGrade,
  quizGradeSchema,
} from "../ai/client";

/** 证据强制的回归锁（v21）：
 *  验收的核心承诺是"通过必须有依据"。提示词可以要求 evidence，但只有代码降级才算确定性执行。 */

const mkItem = (over: Record<string, unknown> = {}) => ({
  itemId: "a0",
  verdict: "correct",
  evidence: "讲义原文：栈区存放局部变量与函数参数",
  feedback: "答对了",
  ...over,
});

const mkGrade = (items: unknown[], overall: "pass" | "fail" = "pass") => ({
  items,
  overall,
  summary: "总评",
  reviewAdvice: "继续",
  transferQuestion: "换个场景怎么改？",
});

describe("normalizeQuizGrade：无证据不得通过", () => {
  it("有 evidence 的 correct 保持 correct 且 overall=pass", () => {
    const g = normalizeQuizGrade(quizGradeSchema.parse(mkGrade([mkItem()])));
    expect(g.items[0].verdict).toBe("correct");
    expect(g.overall).toBe("pass");
  });

  it("缺 evidence 的 correct 降级为 ungradable，overall 转 fail", () => {
    const g = normalizeQuizGrade(
      quizGradeSchema.parse(mkGrade([mkItem({ evidence: "" })], "pass"))
    );
    expect(g.items[0].verdict).toBe("ungradable");
    expect(g.overall).toBe("fail");
    expect(g.items[0].feedback).toContain("未引用讲义原文");
  });

  it("缺 evidence 的 partially_correct 同样降级", () => {
    const g = normalizeQuizGrade(
      quizGradeSchema.parse(mkGrade([mkItem({ verdict: "partially_correct", evidence: "  " })]))
    );
    expect(g.items[0].verdict).toBe("ungradable");
    expect(g.overall).toBe("fail");
  });

  it("incorrect 不需要 evidence", () => {
    const g = normalizeQuizGrade(
      quizGradeSchema.parse(mkGrade([mkItem({ verdict: "incorrect", evidence: "" })], "fail"))
    );
    expect(g.items[0].verdict).toBe("incorrect");
    expect(g.overall).toBe("fail");
  });

  it("全部 ungradable（无正向证据）→ 不得 pass", () => {
    const g = normalizeQuizGrade(
      quizGradeSchema.parse(
        mkGrade([mkItem({ evidence: "" }), mkItem({ itemId: "a1", evidence: "" })], "pass")
      )
    );
    expect(g.overall).toBe("fail");
  });

  it("混合：一题有证据 + 一题缺证据 → 保守判 fail", () => {
    const g = normalizeQuizGrade(
      quizGradeSchema.parse(
        mkGrade([mkItem(), mkItem({ itemId: "a1", evidence: "" })], "pass")
      )
    );
    expect(g.items[0].verdict).toBe("correct");
    expect(g.items[1].verdict).toBe("ungradable");
    expect(g.overall).toBe("fail");
  });

  it("模型自说 pass 但没有正向证据时被推翻", () => {
    const g = normalizeQuizGrade(
      quizGradeSchema.parse(
        mkGrade([mkItem({ verdict: "incorrect", evidence: "" })], "pass")
      )
    );
    expect(g.overall).toBe("fail");
  });
});

describe("normalizeReviewGrade：复习通过必须有笔记原文依据", () => {
  it("有 evidence 的 pass 保持 pass", () => {
    const g = normalizeReviewGrade({
      verdict: "pass",
      evidence: "笔记原文：FSRS 按回忆表现调整下次间隔",
      feedback: "记住了",
    });
    expect(g.verdict).toBe("pass");
  });

  it("无 evidence 的 pass 改判 fail", () => {
    const g = normalizeReviewGrade({ verdict: "pass", evidence: "", feedback: "记住了" });
    expect(g.verdict).toBe("fail");
    expect(g.feedback).toContain("未能引用笔记原文");
  });

  it("fail 不需要 evidence", () => {
    const g = normalizeReviewGrade({ verdict: "fail", evidence: "", feedback: "忘了" });
    expect(g.verdict).toBe("fail");
    expect(g.feedback).toBe("忘了");
  });
});
