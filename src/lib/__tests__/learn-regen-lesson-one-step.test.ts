import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ 中断恢复入口「重新生成」必须一步到位（回归锁） ============
 * 背景：讲义生成中断且已生成 >200 字时，toast 承诺「已保留已生成的内容（可点
 * 『重新生成』继续）」，且半截讲义被刻意 saveLesson 保留进 plan。但「重新生成」
 * 按钮的 onClick 只做 setLesson("") + delete plan.days[day.id].lesson + 上云同步，
 * 并不调用 genLesson——用户照文案点它，恰恰把刻意保留的中断产物删掉，还要再点
 * 一次「生成今日讲解」从头生成（两步且与文案自相矛盾）。
 *
 * 修复：清空后立即 void genLesson()，一步完成重新生成。 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../app/learn/[id]/page.tsx", import.meta.url)),
  "utf8"
);

const dayPanel = PAGE.slice(PAGE.indexOf("function DayPanel"));

describe("learn/[id]：『重新生成』点击即触发生成", () => {
  it("清空讲义的 handler 在删除落库之后调用 genLesson()", () => {
    const btnIdx = dayPanel.indexOf("delete plan.days[day.id].lesson;");
    expect(btnIdx).toBeGreaterThan(-1);
    const after = dayPanel.slice(btnIdx, btnIdx + 800);
    expect(after).toContain('void import("@/lib/auth-client")');
    expect(after).toContain("void genLesson();");
  });

  it("中断 toast 承诺的入口与按钮行为一致（文案不回退）", () => {
    expect(dayPanel).toContain("生成中断，已保留已生成的内容（可点「重新生成」继续）。");
  });

  it("保留中断产物的 saveLesson(buf) 分支仍在（兜底语义不回退）", () => {
    const catchBlock = dayPanel.slice(dayPanel.indexOf("} catch (e) {", dayPanel.indexOf("const genLesson")), dayPanel.indexOf("/* 提交验收 */"));
    expect(catchBlock).toMatch(/buf\.trim\(\)\.length > 200/);
    expect(catchBlock).toMatch(/await saveLesson\(buf\);/);
  });
});
