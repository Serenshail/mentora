import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 学习日历格子的键盘/读屏可达性（回归锁） ============
 * 背景：26 周 × 7 天每格都是一个无文本的 <button>，原先唯一的命名来源是 title
 * （读屏对 title 命名支持不可靠），且每格都可 Tab——键盘用户要按约 180 次 Tab
 * 才能穿过热力图；点击后的当日详情也没有 live region，读屏不知道内容已更新。
 *
 * 期望的形态（本测试锁住，防回退）：
 * 1. 格子有 aria-label（title 仅作鼠标悬停补充）；
 * 2. 整墙走漫游 tabindex：只有 tabStop 那格 tabIndex=0，其余 -1，墙内用方向键移动；
 * 3. 当日详情的 aria-live 容器常驻挂载，内容条件插入（新建 live region 可能不播报）。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有静态扫描做法
 * （graph-view-empty-cooldown.test.ts / button-theme-tokens.test.ts）：
 * 读组件源码、按语义锚点断言，不绑行号。 */

const SRC = readFileSync(join(process.cwd(), "src/components/learn/study-heatmap.tsx"), "utf8");

/** 抽出格子 <button ...> 的属性区（从 key={c.date} 起，到闭合的 /> 为止）。 */
function cellButton(): string {
  const start = SRC.indexOf("key={c.date}");
  if (start < 0) throw new Error("未找到格子按钮");
  const end = SRC.indexOf("/>", start);
  if (end < 0) throw new Error("格子按钮未闭合");
  return SRC.slice(start, end);
}

describe("学习日历格子的可访问名与 Tab 序", () => {
  it("格子用 aria-label 命名，不再只靠 title", () => {
    const btn = cellButton();
    expect(btn).toContain("aria-label={label}");
    expect(btn).toContain("title={label}");
  });

  it("整墙是漫游 tabindex：只有 tabStop 一格可 Tab，future 格不参与", () => {
    const btn = cellButton();
    const m = btn.match(/tabIndex=\{([^}]*)\}/);
    expect(m).not.toBeNull();
    const expr = m![1];
    expect(expr).toContain("future");
    expect(expr).toContain("tabStop");
    // 不能退化成“所有格子都能 Tab”
    expect(expr).not.toBe("0");
    // 漫游状态必须随焦点更新，否则 Tab 回来时落点丢失
    expect(btn).toContain("onFocus={() => !future && setRovingTab(c.date)}");
  });

  it("方向键在墙内移动焦点，且不越过边界", () => {
    expect(SRC).toContain("const onCellKeyDown");
    expect(SRC).toMatch(/ArrowRight.*\? 7/);
    expect(SRC).toMatch(/ArrowLeft.*\? -7/);
    expect(SRC).toContain("if (!next || next.disabled) return;");
  });

  it("aria-live 容器常驻挂载，详情内容条件渲染", () => {
    const live = SRC.indexOf('aria-live="polite"');
    expect(live).toBeGreaterThan(-1);
    const before = SRC.slice(0, live);
    // 容器前不能紧邻 `{picked && (`，否则整块 live region 是后建的
    expect(before.trimEnd().endsWith("{picked && (")).toBe(false);
    expect(SRC.slice(live)).toContain("{picked && (");
  });
});
