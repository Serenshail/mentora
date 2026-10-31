/* ========= 判分结果归一化（Web 端 quizGradeSchema/reviewGradeSchema 的容错移植） =========
 * 不引入 zod：手写与 z.preprocess 同语义的宽容解析。
 * 证据强制纪律原样保留：没有 evidence 的正向判定降级——验收的参照物是讲义，
 * 模型"结论对、依据错"不算过。 */

function normVerdict(v) {
  var s = String(v == null ? "" : v).toLowerCase();
  if (s === "pass" || s === "correct") return "correct";
  if (s === "fail" || s === "incorrect") return "incorrect";
  if (s === "partially_correct" || s === "partial") return "partially_correct";
  if (s === "ungradable") return "ungradable";
  return "incorrect";
}

/* 验收判分：g = extractJson 的原始对象。解析失败抛错，由调用方兜底。 */
function normalizeQuizGrade(g) {
  if (!g || !Array.isArray(g.items)) throw new Error("判分结果不完整");
  var items = g.items.map(function (it) {
    var evidence =
      typeof it.evidence === "string" && it.evidence.trim()
        ? it.evidence.trim().slice(0, 400)
        : "";
    var hintLevel =
      typeof it.hintLevel === "number"
        ? Math.min(5, Math.max(0, Math.round(it.hintLevel)))
        : undefined;
    return {
      itemId: String(it.itemId || ""),
      verdict: normVerdict(it.verdict),
      evidence: evidence,
      feedback: String(it.feedback || ""),
      hintLevel: hintLevel
    };
  });
  items = items.map(function (it) {
    var positive =
      it.verdict === "correct" || it.verdict === "partially_correct";
    if (positive && !it.evidence) {
      return {
        itemId: it.itemId,
        verdict: "ungradable",
        evidence: "",
        hintLevel: it.hintLevel,
        feedback:
          (it.feedback || "") + "（未引用讲义原文作为依据，本次判定不计为通过）"
      };
    }
    return it;
  });
  var hasIncorrect = items.some(function (it) {
    return it.verdict === "incorrect";
  });
  var hasPositive = items.some(function (it) {
    return it.verdict === "correct" || it.verdict === "partially_correct";
  });
  var hasUngradable = items.some(function (it) {
    return it.verdict === "ungradable";
  });
  var overall = hasIncorrect || !hasPositive || hasUngradable ? "fail" : "pass";
  return {
    items: items,
    overall: overall,
    summary: String(g.summary || ""),
    reviewAdvice: String(g.reviewAdvice || ""),
    transferQuestion:
      typeof g.transferQuestion === "string" && g.transferQuestion.trim()
        ? g.transferQuestion.trim()
        : ""
  };
}

/* 复习判分：pass 必须引用笔记原文，无证据改判 fail（不给"感觉记住了"放水） */
function normalizeReviewGrade(g) {
  var s = String((g && g.verdict) == null ? "" : g.verdict).toLowerCase();
  var pass = ["pass", "correct", "true", "通过", "回忆成功"].indexOf(s) >= 0;
  var evidence =
    g && typeof g.evidence === "string" && g.evidence.trim()
      ? g.evidence.trim().slice(0, 400)
      : "";
  var feedback = String((g && g.feedback) || "");
  if (pass && !evidence) {
    return {
      verdict: "fail",
      evidence: "",
      feedback: feedback + "（未能引用笔记原文作为依据，本次不计通过）"
    };
  }
  return { verdict: pass ? "pass" : "fail", evidence: evidence, feedback: feedback };
}

module.exports = {
  normalizeQuizGrade: normalizeQuizGrade,
  normalizeReviewGrade: normalizeReviewGrade
};
