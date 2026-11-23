import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ============ 图谱画布底色跟随时段主题（回归锁） ============
 * AppShell 全局每 10 分钟 applyPeriodTheme（app-shell.tsx），globals.css:454-458
 * 按 html[data-period] 改 --color-bg（morning #f7f4ee … night #f1f1f5）。
 * 而 graph-view.tsx 的画布 fillRect 与 canvas 元素背景都写死 #fcfcfd：
 * 占屏近 100vh 的图谱块在早读/晚间时段与周围页面底色出现可见色差。
 * 修复：render 里读 --color-bg（按 data-period 缓存，避免每帧 getComputedStyle），
 * canvas 元素背景用 bg-[var(--color-bg)]。
 *
 * vitest 无 DOM 环境，沿用本仓库既有静态扫描做法（graph-view-canvas-size-guard.test.ts）。 */

const SRC = readFileSync(join(process.cwd(), "src/components/brain/graph-view.tsx"), "utf8");

/** 剥离块/行注释（感知字符串与转义）。 */
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

const CODE = stripComments(SRC);

function extractArrowBody(src: string, marker: string): string | null {
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const open = src.indexOf("{", start + marker.length);
  if (open === -1) return null;
  let depth = 0;
  for (let end = open; end < src.length; end++) {
    if (src[end] === "{") depth++;
    else if (src[end] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, end);
    }
  }
  return null;
}

const RENDER = extractArrowBody(CODE, "const render = () =>");

describe("graph-view：画布底色随时段主题，不再写死 #fcfcfd", () => {
  it("抽取器抓到了 render 函数体", () => {
    expect(RENDER).not.toBeNull();
    expect(RENDER!).toContain("fillRect");
  });

  it("render 用主题色填底，不再硬编码 #fcfcfd", () => {
    expect(RENDER).toMatch(/ctx\.fillStyle\s*=\s*themeBg\(\)/);
    expect(RENDER).not.toMatch(/ctx\.fillStyle\s*=\s*"#fcfcfd"/);
  });

  it("主题色读 --color-bg，并按 data-period 值缓存（不在 render 每帧 getComputedStyle）", () => {
    const helper = extractArrowBody(CODE, "const themeBg = () =>");
    expect(helper, "找不到 themeBg helper").not.toBeNull();
    expect(helper!).toMatch(/getAttribute\("data-period"\)/);
    expect(helper!).toMatch(/getPropertyValue\("--color-bg"\)/);
    expect(helper!).toMatch(/themeBgRef\.current/);
  });

  it("canvas 元素背景用 CSS 变量而非硬编码浅色", () => {
    expect(CODE).not.toContain("bg-[#fcfcfd]");
    expect(CODE).toContain("bg-[var(--color-bg)]");
  });
});
