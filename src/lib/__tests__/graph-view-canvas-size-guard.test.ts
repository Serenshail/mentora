import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 画布后备缓冲尺寸守卫必须整数对整数（回归锁） ============
 * 背景：graph-view.tsx 的 render() 曾写成
 *     if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; ... }
 * sizeRef 来自 wrapRef.getBoundingClientRect()，canvas 高度又是
 * style calc(100vh - 170px) 的产物——浏览器缩放≠100% 或分数 DPR 时 w/h*dpr
 * 普遍带小数；而 canvas.width/height 是 unsigned long，赋值小数被截断存整
 * （赋 1150.25 实际存 1150）。于是下一帧比较「1150 !== 1150.25」恒为真，
 * 动画 / 平移 / 滚轮期间 render() 每帧都重设 width/height——每次赋值都会
 * 清空位图并可能重分配后备缓冲，随后再全量重绘，纯属交互期白烧。
 * 修复：目标尺寸先 Math.round 成整数，守卫与赋值共用同一个整数。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有静态扫描做法
 * （graph-view-empty-cooldown.test.ts / button-theme-tokens.test.ts）：
 * 直接读组件源码，剥离注释后按花括号配平抽出 render 函数体做断言，
 * 按语义锚点而非行号，重排/换行不误报。 */

const FILE = readFileSync(join(process.cwd(), "src/components/brain/graph-view.tsx"), "utf8");

/** 剥离块/行注释（感知字符串与转义），只用于本测试的静态扫描。 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : "";
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && i + 1 < n && src[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = src[i];
        if (c === "\\" && i + 1 < n) {
          out += c + src[i + 1];
          i += 2;
          continue;
        }
        out += c;
        i++;
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const SRC = stripComments(FILE);

/** 从 marker 之后第一个 { 起，按花括号配平抽出箭头函数体（模板串 ${...} 天然配对）。 */
function extractArrowBody(src: string, marker: string): string | null {
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const open = src.indexOf("{", start + marker.length);
  if (open === -1) return null;
  let depth = 0;
  for (let end = open; end < src.length; end++) {
    const ch = src[end];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, end);
    }
  }
  return null;
}

const RENDER = extractArrowBody(SRC, "const render = () =>");

describe("graph-view.tsx：画布后备缓冲尺寸守卫（小数比较恒为真）", () => {
  it("抽取器确实抓到了 render 函数体（防止组件重构后扫描悄悄变空）", () => {
    expect(RENDER).not.toBeNull();
    expect(RENDER!).toContain("canvas.width");
    expect(RENDER!).toContain("devicePixelRatio");
  });

  it("核心回归锁：守卫两侧都是取整后的整数，不再拿未取整的 w * dpr 比较", () => {
    expect(RENDER).not.toMatch(/canvas\.width\s*!==\s*w\s*\*\s*dpr/);
    expect(RENDER).not.toMatch(/canvas\.height\s*!==\s*h\s*\*\s*dpr/);
    // 目标尺寸先取整（Math.round），且守卫与赋值共用该整数
    expect(RENDER).toMatch(/const\s+bw\s*=\s*Math\.round\(\s*w\s*\*\s*dpr\s*\)/);
    expect(RENDER).toMatch(/const\s+bh\s*=\s*Math\.round\(\s*h\s*\*\s*dpr\s*\)/);
    expect(RENDER).toMatch(/canvas\.width\s*!==\s*bw/);
    expect(RENDER).toMatch(/canvas\.height\s*!==\s*bh/);
    expect(RENDER).toMatch(/canvas\.width\s*=\s*bw\b/);
    expect(RENDER).toMatch(/canvas\.height\s*=\s*bh\b/);
  });

  it("赋给 canvas.width/height 的值不再可能是小数（守卫不会自我失配）", () => {
    // 所有 width/height 赋值右侧只允许 bw/bh 这类已取整的局部量
    const assigns = [...RENDER!.matchAll(/canvas\.(?:width|height)\s*=\s*([^;]+);/g)].map((m) =>
      m[1].trim()
    );
    expect(assigns.length).toBeGreaterThan(0);
    for (const rhs of assigns) expect(["bw", "bh"]).toContain(rhs);
  });

  it("数值事实：unsigned long 截断使旧写法恒真，取整后比较稳定", () => {
    const w = 1150.25;
    const dpr = 1.25;
    // 旧写法：赋给 canvas.width 后被截断为整数，与未取整值永不相等
    const truncated = Math.trunc(w * dpr);
    expect(truncated).not.toBe(w * dpr);
    // 新写法：同一个整数既比较又赋值，第二帧起守卫为假
    const bw = Math.round(w * dpr);
    expect(Math.trunc(bw)).toBe(bw);
    expect(bw !== bw).toBe(false);
  });
});
