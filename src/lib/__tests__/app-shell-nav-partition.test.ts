import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ app-shell 导航分区：切片边界与数据长度脱钩的回归锁 ============
 * 背景（FIX heavy-w1-41）：v23.3 把 NAV 从约 8 项砍到 4 项，但按旧长度
 * 写死的 slice(5)/slice(6)/grid-cols-6 没跟着改：
 *   ① 底栏 6 列只渲染 4 主入口 +「更多」= 5 个子元素，最右一列恒空；
 *   ② MOBILE_MORE 的 NAV.slice(5) 恒空，抽屉少一块且是死代码；
 *   ③ 桌面侧栏 NAV.slice(6) 恒空，渲染出只有「系统」标题的零条目空分组。
 * 修复：单一 PRIMARY_COUNT 派生 PRIMARY_NAV/OVERFLOW_NAV，工作台与底栏
 * 共用主入口、系统分组与抽屉共用溢出项、底栏列数由主入口数派生。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法（静态扫描源码，见
 * learn-enter-ime-guard.test.ts）：把顶层的 NAV/分区常量用 Node 求值，
 * 断言分区覆盖 NAV 全部项且无重叠，并对渲染结构做语义锚点断言。
 * 断言按常量名/JSX 锚点而非行号，后续重排换行不误报。 */

const SHELL = readFileSync(
  join(process.cwd(), "src/components/app-shell.tsx"),
  "utf8"
);

/** 抽出 `const NAV = [...]` 的数组字面量（配平方括号，容忍嵌套 {} 与 icon 引用）。 */
function extractNavArray(src: string): string {
  const start = src.indexOf("const NAV = [");
  expect(start, "app-shell.tsx 必须保留顶层 const NAV = [...]").toBeGreaterThan(-1);
  const open = src.indexOf("[", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("NAV 数组字面量未闭合");
}

type NavEntry = { href: string; label: string; icon: string };

/** 在受控作用域内 eval NAV 字面量：把 lucide 图标标识符换成字符串占位。 */
function parseNav(src: string): NavEntry[] {
  const literal = extractNavArray(src);
  const normalized = literal.replace(
    /icon:\s*([A-Z][A-Za-z0-9_]*)/g,
    (_m, name: string) => `icon: ${JSON.stringify(name)}`
  );
  // eslint-disable-next-line no-eval -- 输入是本仓库源码的顶层常量字面量，已归一化
  return eval(normalized) as NavEntry[];
}

/** 读取 `const NAME = <数字>` 形式的正整数常量。 */
function intConst(src: string, name: string): number {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)\\s*;`));
  expect(m, `必须保留数值常量 const ${name} = <n>`).not.toBeNull();
  return Number(m![1]);
}

describe("app-shell.tsx：NAV 分区必须完整、互斥、列数派生", () => {
  it("顶层仍以单一 PRIMARY_COUNT 定义主入口容量（PRD §3.1：5 主入口 + 更多）", () => {
    expect(intConst(SHELL, "PRIMARY_COUNT")).toBe(5);
    expect(SHELL).toContain("const PRIMARY_NAV = NAV.slice(0, PRIMARY_COUNT);");
    expect(SHELL).toContain("const OVERFLOW_NAV = NAV.slice(PRIMARY_COUNT);");
  });

  it("PRIMARY_NAV 与 OVERFLOW_NAV 拼起来恰好覆盖 NAV 全部项、无重叠、无遗漏", () => {
    const nav = parseNav(SHELL);
    const count = intConst(SHELL, "PRIMARY_COUNT");
    const primary = nav.slice(0, count);
    const overflow = nav.slice(count);
    expect(nav.length).toBeGreaterThan(0);
    expect(primary.length + overflow.length).toBe(nav.length);
    const hrefs = nav.map((e) => e.href);
    expect(new Set(hrefs).size).toBe(hrefs.length); // href 唯一，key 不会撞
    expect(new Set([...primary, ...overflow].map((e) => e.href))).toEqual(
      new Set(hrefs)
    );
    for (const p of primary) expect(overflow.some((o) => o.href === p.href)).toBe(false);
  });

  it("MOBILE_MORE 由 OVERFLOW_NAV + 设置组成，不再有 slice(5) 这类写死边界", () => {
    expect(SHELL).toContain("...OVERFLOW_NAV,");
    expect(SHELL).toMatch(/MOBILE_MORE\s*=\s*\[\s*\.\.\.OVERFLOW_NAV/);
    expect(SHELL).not.toMatch(/NAV\.slice\(\s*5\s*\)/);
    expect(SHELL).not.toMatch(/NAV\.slice\(\s*6\s*\)/);
  });

  it("底栏列数由主入口数派生，不存在硬编码 grid-cols-6", () => {
    expect(SHELL).toContain(
      "gridTemplateColumns: `repeat(${MOBILE_PRIMARY.length + 1}, minmax(0, 1fr))`"
    );
    expect(SHELL).not.toContain("grid-cols-6");
    // 底栏 nav 内仍是 MOBILE_PRIMARY.map +「更多」按钮两个渲染块
    expect(SHELL).toContain("{MOBILE_PRIMARY.map(");
    expect(SHELL).toContain('aria-label="更多"');
  });

  it("桌面「系统」分组仅当溢出项存在或管理员时渲染，且遍历 OVERFLOW_NAV", () => {
    expect(SHELL).toContain("{(OVERFLOW_NAV.length > 0 || isAdmin) && (");
    expect(SHELL).toContain("{OVERFLOW_NAV.map(");
    expect(SHELL).toContain("{PRIMARY_NAV.map(");
    // 工作台分组不得再出现按旧长度写死的 slice
    expect(SHELL).not.toContain("NAV.slice(0, 6)");
  });

  it("管理员后台入口仍受 isAdmin 门控（安全面不回归）", () => {
    const occurrences = SHELL.match(/\{isAdmin && \(/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2); // 桌面系统分组 + 移动抽屉
    expect(SHELL).toContain('href="/admin"');
  });
});
