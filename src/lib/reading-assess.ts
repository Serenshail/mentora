/* 三重验收（PRD 4.5）判分结果与出题的逐题对齐。
 *
 * 背景：readingAssessGradeSchema 只约束 results 数组 min(1)，既无数量上限也不校验
 * kind 与出题顺序的对应（ai/client.ts）。页面直接 slice(0, questions.length) 只防多不防少：
 *  - 模型只回 1 条时 passed 阈值算成 max(2, ceil(1*0.66)) = 2 > 1，答案再好也过不了；
 *  - 回 2 条时要求 2/2 全 mastered，严于「三题 2/3」的设计口径；
 *  - 结果与题目 kind 错序时，归档的 question/answer/反馈会张冠李戴。
 *
 * 这里按出题顺序逐题匹配（first-unused，容忍重复 kind）：模型多回或 kind 不在出题里的丢弃，
 * 出题中没被覆盖的题记为 ungradable —— PRD 3.5：无法判定不计入通过，绝不因数量失真而放行。
 * 返回数组长度恒等于 questions.length，调用方按它计算通过阈值即可保持 2/3 口径。
 */
import type { AssessKind } from "@/lib/types";

export type AssessLevel = "mastered" | "partial" | "not" | "ungradable";

export interface AssessQuestion {
  kind: AssessKind;
  question: string;
}

export interface AssessGradeResult {
  kind: AssessKind;
  level: AssessLevel;
  evidence: string;
  feedback: string;
}

export interface RawAssessGradeResult {
  kind: AssessKind;
  level: AssessLevel;
  evidence?: string | null;
  feedback?: string | null;
}

const MISSING_FEEDBACK = "判分结果没覆盖这一题——按无法判定处理，换个问法再考一次。";

export function alignAssessResults(
  questions: AssessQuestion[],
  results: RawAssessGradeResult[]
): AssessGradeResult[] {
  const aligned: AssessGradeResult[] = questions.map((q) => ({
    kind: q.kind,
    level: "ungradable",
    evidence: "",
    feedback: MISSING_FEEDBACK,
  }));
  const used = new Set<number>();
  for (const r of results) {
    const idx = questions.findIndex((q, i) => q.kind === r.kind && !used.has(i));
    if (idx === -1) continue; // 多回 / kind 不在出题里：丢弃
    used.add(idx);
    aligned[idx] = {
      kind: questions[idx].kind,
      level: r.level,
      evidence: r.evidence ?? "",
      feedback: r.feedback ?? "",
    };
  }
  return aligned;
}
