import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ coachTone 必须随 args 上行到 lesson / quiz-grade（回归锁） ============
 * 背景：设置页允许用户选「标准/温和」（settings.coachTone，智能体也能改），learn/[id]
 * 页把它读出并经 GoalDetailInner → LearnBody → DayPanel 三层透传——但 DayPanel 体内
 * 两处 streamChat 的 args 只带 ctx，tone 除形参外零引用。服务端 route.ts 对 lesson 与
 * quiz-grade 两个任务都读取 s("tone")==="gentle" 切换语气分支：全仓无任何调用方传
 * tone，用户选了「温和」后讲义与判分反馈语气毫无变化。
 *
 * 修复：两处 streamChat 的 args 都带 tone。本锁断言接线不回退。 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../app/learn/[id]/page.tsx", import.meta.url)),
  "utf8"
);
const ROUTE = readFileSync(
  fileURLToPath(new URL("../../app/api/chat/route.ts", import.meta.url)),
  "utf8"
);

/** task 标记之前最近的 args 行（genLesson / submitQuiz 各一次命中） */
function argsBefore(src: string, taskMark: string): string {
  const at = src.indexOf(taskMark);
  if (at === -1) return "";
  const from = src.lastIndexOf("args: {", at);
  return src.slice(from, src.indexOf("}", from) + 1);
}

describe("learn/[id]：DayPanel 的 tone 透传必须真正进入 args", () => {
  it("lesson 生成的 args 携带 tone", () => {
    expect(argsBefore(PAGE, 'task: "lesson"')).toMatch(/args: \{ ctx, tone \}/);
  });

  it("quiz-grade 判分的 args 携带 tone", () => {
    expect(argsBefore(PAGE, 'task: "quiz-grade"')).toMatch(/args: \{ ctx, tone \}/);
  });

  it("服务端 lesson / quiz-grade 两个分支仍按 tone 切换（接线目标不回退）", () => {
    expect(ROUTE).toMatch(/case "lesson":[\s\S]{0,200}s\("tone"\) === "gentle"/);
    expect(ROUTE).toMatch(
      /case "quiz-grade": return P\.QUIZ_GRADE\(s\("ctx"\), s\("tone"\) === "gentle" \? "gentle" : "standard"\);/
    );
  });

  it("DayPanel 形参上的 tone prop 仍存在（三层透传链路不被拆）", () => {
    const dayPanel = PAGE.slice(PAGE.indexOf("function DayPanel"));
    expect(dayPanel).toMatch(/tone = "standard" as "standard" \| "gentle"/);
  });
});
