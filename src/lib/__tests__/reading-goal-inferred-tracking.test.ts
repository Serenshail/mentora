import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ goal_confirmed 埋点 inferred 字段的回归锁 ============
 * 背景：saveGoal 里 trackReading("goal_confirmed", { ..., inferred: !!goal.inferred })
 * 的 goal 是同一函数刚构造的字面量，根本没有 inferred 字段（可选属性，编译通过）——
 * inferred 恒为常量 false，v26.1 漏斗分析会得出「没有人用推断目标」的错误结论。
 * 修复：inferred 的判定来自编辑器表单的来源（goalFromAiRef）：打开编辑器时继承
 * book.goal.inferred、AI 推荐成功置 true、用户手动改任何字段置 false；并随保存路径
 * 写入 goal 本身，埋点与「AI 推断的默认目标」UI 提示共用同一个真相。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/read/[id]/page.tsx"), "utf8");

describe("goal_confirmed.inferred 不再是常量 false", () => {
  it("保存路径把表单来源写入 goal.inferred（随保存路径传参）", () => {
    expect(PAGE).toMatch(/inferred: goalFromAiRef\.current,\s*\n\s*setAt: new Date\(\)\.toISOString\(\),/);
  });

  it("埋点读 goal.inferred（不再读刚构造字面量上不存在的字段）", () => {
    expect(PAGE).toMatch(/trackReading\("goal_confirmed", \{ bookId: book\.id, goal: goal\.primary, inferred: goal\.inferred === true \}\)/);
    // 旧 bug 写法必须消失
    expect(PAGE).not.toMatch(/inferred: !!goal\.inferred/);
  });

  it("AI 推荐成功 → inferred=true；用户手动改任何字段 → inferred=false", () => {
    const ai = PAGE.slice(PAGE.indexOf("const aiRecommendGoal"), PAGE.indexOf("/* ================= 路线管理"));
    expect(ai).toMatch(/goalFromAiRef\.current = true/);
    // 四个手动输入点：目标卡点击 / 设为主目标 / goalIntent / goalBackground
    expect(PAGE).toMatch(/goalFromAiRef\.current = false; \/\/ 用户手动改动/);
    expect(PAGE).toMatch(/goalFromAiRef\.current = false; \/\/ 用户手动换主目标/);
    expect(PAGE).toMatch(/onChange=\{\(e\) => \{ goalFromAiRef\.current = false; setGoalIntent/);
    expect(PAGE).toMatch(/onChange=\{\(e\) => \{ goalFromAiRef\.current = false; setGoalBackground/);
  });

  it("打开编辑器时继承 book.goal.inferred（原样确认推断目标仍算推断）", () => {
    const fn = PAGE.slice(PAGE.indexOf("const openGoalEditor"), PAGE.indexOf("const saveGoal"));
    expect(fn).toMatch(/goalFromAiRef\.current = !!book\.goal\?\.inferred/);
  });

  it("「直接开始」路径的显式推断标记不被破坏", () => {
    expect(PAGE).toMatch(/\{ primary: "understand", secondary: \[\], inferred: true, setAt: new Date\(\)\.toISOString\(\) \}/);
  });
});
