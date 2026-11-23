import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ 学习窗口（?day=X&focus=1）必须与普通视图同闸（回归锁） ============
 * 背景：isFocus 分支直接渲染 DayStubPanel/DayPanel，不走普通视图的任何一道闸：
 * ①免费版（entitlement=expired）手拼 /learn/<goalId>?day=<付费阶段目录日id>&focus=1，
 *   DayStubPanel 的兜底 effect 会无条件 ensureDayDetail，为付费墙阶段生成新内容
 *   （正是 activePhaseLocked 刻意阻止的事；旧付费期遗留的目录日 id 在本地/云端可得）；
 * ②locked 但已展开的天（预取的下一天）在该分支 readOnly 缺省 false，可对未解锁的
 *   天直接提交验收、setDayStatus 落库。
 *
 * 修复：focus 分支计算 focusLocked（口径与 viewDayLocked 一致）命中即渲染 PhasePaywall；
 * DayPanel 传 readOnly={focusDay.id !== activeDay?.id}（推进门与普通视图同口径）。 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../app/learn/[id]/page.tsx", import.meta.url)),
  "utf8"
);

const focus = PAGE.slice(PAGE.indexOf("if (isFocus) {"), PAGE.indexOf("const remainingDays = goal.plan"));

describe("learn/[id]：学习窗口不绕过付费墙与推进门", () => {
  it("focusLocked 存在，且免费墙口径与 viewDayLocked 一致（FREE_PHASE_LIMIT + dayViewExempt）", () => {
    expect(focus).toMatch(
      /const focusLocked =\s*\n?\s*freeTier && !!focusDay && phaseIndexOf\(focusDay\) >= FREE_PHASE_LIMIT && !dayViewExempt\(focusDay\);/
    );
    const normal = PAGE.slice(PAGE.indexOf("const viewDayLocked ="), PAGE.indexOf("if (isFocus) {"));
    expect(normal).toMatch(/freeTier && !!viewDay && phaseIndexOf\(viewDay\) >= FREE_PHASE_LIMIT && !dayViewExempt\(viewDay\)/);
  });

  it("锁定的 focus 天渲染 PhasePaywall（stub 与非 stub 都不再直通）", () => {
    expect(focus).toMatch(/focusLocked \? \(\s*\n\s*<PhasePaywall phaseIndex=\{phaseIndexOf\(focusDay\)\} \/\>/);
    // 三元顺序：locked 判断先于 stub 判断，占位日也上墙
    expect(focus.indexOf("focusLocked ? (")).toBeGreaterThan(-1);
    expect(focus.indexOf("focusDay.stub ? (")).toBeGreaterThan(focus.indexOf("focusLocked ? ("));
  });

  it("非锁定天的 DayPanel 带 readOnly 推进门（非当前任务天不可提交验收）", () => {
    expect(focus).toMatch(/readOnly=\{focusDay\.id !== activeDay\?\.id\}/);
  });
});
