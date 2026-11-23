import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ 判分未通过必须写入 quizLog（回归锁） ============
 * 背景：submitQuiz 里 incrementAttempts 对每次成功判分都执行，但 logQuiz 只在
 * if (g.overall === "pass") 分支与 forceSkip（items: []）被调用——失败判分不留任何
 * 记录。后果：① genCtx 用 goal.quizLog.filter(q => !q.passed) 提取弱项给 AI，
 * 能落到 !passed 的只有 items 为空的强制跳过记录，弱项特征实际恒空；
 * ② 回看「验收记录」面板查 quizLog，失败次数恒 0，与头部「验收 N 次」徽章
 * （attempts 含失败）互相矛盾。
 *
 * 修复：判分明细快照（gradedItems）pass/fail 两条分支共用，未通过也落库。 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../app/learn/[id]/page.tsx", import.meta.url)),
  "utf8"
);

const submit = PAGE.slice(
  PAGE.indexOf("const submitQuiz = async"),
  PAGE.indexOf("/* 迁移题过门")
);

describe("learn/[id]：验收未通过也要落库 quizLog", () => {
  it("判分明细快照存在，pass / fail 两条分支共用同一份 items", () => {
    expect(submit).toMatch(/const gradedItems: QuizItemResult\[\] = g\.items\.map/);
    expect(submit.match(/items: gradedItems/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("存在未通过分支的 logQuiz（passed: false、非强制），弱项特征与回看记录才有数据源", () => {
    expect(submit).toMatch(
      /\} else \{\s*\n\s*\/\* 未通过也必须落库[\s\S]*?passed: false,\s*\n\s*forced: false,\s*\n\s*items: gradedItems,/
    );
  });

  it("attempts 仍对每次成功判分递增（失败落库不改变 attempts 口径）", () => {
    expect(submit).toContain("incrementAttempts(goal.id, day.id)");
  });

  it("genCtx 的弱项提取仍以 !q.passed 为准（失败记录落库后该特征才真正生效）", () => {
    const genCtx = PAGE.slice(PAGE.indexOf("function genCtx"), PAGE.indexOf("const dayRuns"));
    expect(genCtx).toMatch(/quizLog\s*\n?\s*\.filter\(\(q\) => !q\.passed\)/);
  });
});
