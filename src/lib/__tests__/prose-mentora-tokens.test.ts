import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ prose-mentora 排版只走设计令牌（回归锁） ============
 * 背景：globals.css 的 .prose-mentora 块曾把正文灰阶（#3f3f46 / marker
 * #a1a1aa / code #4c43c4）写成墨色阶之外的一次性 hex，并用 6 处
 * rgba(91,84,230,α) 手抄 --color-accent(#5b54e6) 的 alpha 副本。
 * 而 globals.css 的 html[data-period] 规则会在运行时按学习时段覆盖
 * --color-accent（晨读琥珀 #b45309 / 午后青 #0e7490 / 深夜紫 #6d28d9），
 * 手抄副本却永远是靛蓝——链接下划线、行内 code 底/边、引用块底色、
 * 选中态、焦点环会与站内 accent 可见地漂移。修复统一改为令牌：
 * 灰阶 -> var(--color-ink-dim) / var(--color-ink-3)，
 * 强调色 -> var(--color-accent) 或 color-mix(in srgb, var(--color-accent) N%, transparent)。
 *
 * vitest 无 DOM 环境（沿用 button-theme-tokens.test.ts 的静态扫描做法）：
 * 直接读 CSS 源码，按语义锚点而非行号断言，换行/重排不误报。 */

const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** 抽出整段 markdown 排版（首/尾注释锚点之间），避免误扫文件其余规则。
 * .prose-mentora 是一族规则（基础块 + h1/code/pre/blockquote/a/...），
 * 只取首个 `{}` 基础块会漏掉 code / li::marker / a 等子规则。 */
function proseSection(src: string): string {
  const start = src.indexOf("/* ---- markdown 内容排版");
  const end = src.indexOf("@keyframes rise", start);
  if (start < 0 || end < 0) throw new Error("未找到 markdown 排版段落边界");
  return src.slice(start, end);
}

const PROSE = proseSection(CSS);

describe("prose-mentora 排版只用设计令牌", () => {
  it("正文与 marker 用墨色阶令牌，不再写死灰阶 hex", () => {
    expect(PROSE).toMatch(/{\s*[^}]*color:\s*var\(--color-ink-dim\)/);
    expect(PROSE).not.toMatch(/#3f3f46/i);
    expect(PROSE).not.toMatch(/#a1a1aa/i);
    expect(PROSE).toMatch(/li::marker\s*{\s*color:\s*var\(--color-ink-3\)/);
  });

  it("行内 code 文字用 --color-accent，不再写死 #4c43c4", () => {
    expect(PROSE).not.toMatch(/#4c43c4/i);
    expect(PROSE).toMatch(/\.prose-mentora code\s*{[^}]*color:\s*var\(--color-accent\)/);
  });

  it("强调色 alpha 统一由 --color-accent 派生，不再出现手抄 rgba(91,84,230)", () => {
    // 全文件范围内都不再有靛蓝 alpha 手写副本（含 ::selection、:focus-visible）
    expect(CSS).not.toMatch(/rgba\(\s*91\s*,\s*84\s*,\s*230/i);
    // 且确有基于令牌的 alpha 派生（color-mix 保留透明度语义）
    expect(CSS).toMatch(/color-mix\(in srgb, var\(--color-accent\)/);
  });

  it("@theme 仍定义被引用的令牌，且时段覆盖仍存在（防止令牌被删/覆盖被移除后断言失真）", () => {
    for (const token of [
      "--color-ink-dim",
      "--color-ink-3",
      "--color-accent",
    ]) {
      expect(CSS, token).toContain(token);
    }
    expect(CSS).toMatch(/html\[data-period="morning"\][\s\S]*?--color-accent:/);
  });
});
