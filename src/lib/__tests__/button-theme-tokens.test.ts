import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ Button 变体只用设计令牌、不用一次性写死 hex（回归锁） ============
 * 背景：ui.tsx 的 primary 曾写死 bg-[#1d1d1f] / hover:bg-[#333336]，
 * outline 曾写死 hover:bg-[#fafafa] / hover:border-[#d4d4d8]。globals.css
 * @theme 的 --color-ink 正是 #1d1d1f，且全站已用 bg-ink 表达同一墨色；
 * #333336/#fafafa/#d4d4d8 无对应令牌却与 surface-2(#f4f4f5)、faint(#d2d2d7)
 * 同意图，后续调色必然两套值漂移。修复改为令牌表达：
 * primary -> bg-ink hover:bg-black/80（全站墨色按钮既有写法），
 * outline -> hover:bg-surface-2 hover:border-faint。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有静态扫描做法
 * （graph-view-empty-cooldown.test.ts / learn-enter-ime-guard.test.ts）：
 * 直接读组件源码，按语义锚点而非行号断言，换行/重排不误报。 */

const UI = readFileSync(join(process.cwd(), "src/components/ui.tsx"), "utf8");
const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** 抽出 Button 的 variants 对象字面量（花括号配平），避免误扫文件其余部分。 */
function variantsBlock(src: string): string {
  const start = src.indexOf("const variants: Record<BtnVariant, string>");
  if (start < 0) throw new Error("未找到 Button variants 定义");
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error("variants 字面量未闭合");
}

const V = variantsBlock(UI);

describe("Button 变体的墨色/悬停态只用主题令牌", () => {
  it("primary 用 bg-ink（与 --color-ink 同源），不再写死 hex", () => {
    expect(V).toMatch(/primary:\s*"[^"]*\bbg-ink\b/);
    expect(V).not.toMatch(/#1d1d1f/i);
    expect(V).not.toMatch(/#333336/i);
    expect(V).toMatch(/primary:[\s\S]*?hover:bg-black\/80/);
  });

  it("outline 悬停用 surface-2 / faint 令牌，不再写死 hex", () => {
    expect(V).toMatch(/outline:[\s\S]*?hover:bg-surface-2/);
    expect(V).toMatch(/outline:[\s\S]*?hover:border-faint/);
    expect(V).not.toMatch(/#fafafa/i);
    expect(V).not.toMatch(/#d4d4d8/i);
  });

  it("variants 内不再出现任意一次性方括号 hex 颜色", () => {
    expect(V).not.toMatch(/\[#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\]/);
  });

  it("globals.css @theme 仍定义被引用的三个令牌（防止令牌被删后类失效）", () => {
    for (const token of ["--color-ink", "--color-surface-2", "--color-faint"]) {
      expect(CSS, token).toContain(token);
    }
  });
});
