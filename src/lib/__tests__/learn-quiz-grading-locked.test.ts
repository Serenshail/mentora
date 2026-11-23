import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ 判分进行中锁定验收输入（回归锁） ============
 * 背景：submitQuiz 提交时把当时的 answers 快照发给模型判分并写入 logQuiz，但判分
 * 期间（grading=true）验收 Textarea 没有 disabled、「返回学习」按钮也可点——判分
 * 往返的数秒内继续编辑的话，结果页读取的是当前 answers 状态，展示的「你的回答：…」
 * 会与反馈所针对的判分文本不一致（答非所判）。
 *
 * 修复：判分期间 Textarea 与「返回学习」均 disabled={grading}。 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../app/learn/[id]/page.tsx", import.meta.url)),
  "utf8"
);

const quiz = PAGE.slice(
  PAGE.indexOf("{/* ===== 验收模式 ===== */}"),
  PAGE.indexOf("{/* ===== 结果模式 ===== */}")
);

describe("learn/[id]：判分进行中验收输入锁定", () => {
  it("验收答案 Textarea 带 disabled={grading}", () => {
    expect(quiz).toMatch(
      /value=\{answers\[a\.id\] \?\? ""\}\s*\n\s*onChange=\{\(e\) => setAnswers\(\{ \.\.\.answers, \[a\.id\]: e\.target\.value \}\)\}\s*\n\s*\/\* 判分往返期间锁定编辑[\s\S]*?\*\/\s*\n\s*disabled=\{grading\}/
    );
  });

  it("「返回学习」按钮判分期间不可点（防止中途换视图后 answers 被继续改）", () => {
    const btn = quiz.slice(quiz.indexOf("返回学习") - 220, quiz.indexOf("返回学习") + 40);
    expect(btn).toMatch(/disabled=\{grading\}/);
  });
});
