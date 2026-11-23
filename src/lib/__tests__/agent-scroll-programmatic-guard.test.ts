import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 程序滚动防误判守卫（回归锁） ============
 * 背景：scrollToBottom 的 rAF 回调里同步执行 programmatic=true → 改 scrollTop →
 * 置 false，而 scroll 事件按规范在渲染步异步派发、必然晚于该同步体——
 * onMessagesScroll 的豁免守卫读到的标志恒为 false，从未生效。当前没有实际误判
 * 仅靠两处兜底掩盖。修复：标志保持到下一次滚动事件由处理器消费；位置本就没变、
 * 不会触发 scroll 时由 rAF 兜底复位；三处程序滚动（回底/恢复保存位/锚点恢复）
 * 全部设标。组件行为无法脱离 DOM 单测，沿用静态扫描锁接线。 */

const HOME = readFileSync(join(process.cwd(), "src/components/agent-home.tsx"), "utf8");

describe("programmatic 滚动守卫", () => {
  it("程序滚动后不再同步复位标志：复位交给 rAF 兜底", () => {
    const start = HOME.indexOf("const scrollToBottom = useCallback");
    const end = HOME.indexOf("useLayoutEffect", start);
    const body = HOME.slice(start, end);
    expect(body).toContain("programmatic.current = true;");
    expect(body.indexOf("el.scrollTop = el.scrollHeight;")).toBeGreaterThan(-1);
    /* 关键：赋值之后到 rAF 复位之前，不得再出现 programmatic.current = false */
    const afterAssign = body.indexOf("el.scrollTop = el.scrollHeight;");
    const rafReset = body.indexOf("requestAnimationFrame(() => {", afterAssign);
    const between = body.slice(afterAssign, rafReset);
    expect(between).not.toContain("programmatic.current = false");
  });

  it("三处程序滚动（回底/恢复保存位/锚点恢复）都设标", () => {
    /* scrollToBottom 内联一处；恢复保存位与锚点恢复共用 programmaticScrollTo helper */
    expect((HOME.match(/programmatic\.current = true;/g) ?? []).length).toBe(2);
    expect((HOME.match(/programmaticScrollTo\(el, /g) ?? []).length).toBe(2);
  });

  it("滚动处理器消费标志（消费一次并复位，不算用户操作）", () => {
    expect(HOME).toMatch(/if \(programmatic\.current\) \{\s*\n\s*programmatic\.current = false;/);
  });
});
