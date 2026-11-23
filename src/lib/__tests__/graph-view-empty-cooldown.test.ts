import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 空图谱 rAF 主循环必须能冷却（回归锁） ============
 * 背景：graph-view.tsx 的 physics() 原先在 nodes.length===0 时提前 return，
 * 而 alphaRef.current = alpha * 0.99 的衰减写在 return 之后。alphaRef 初值 1，
 * 数据 effect 对空集还会把它抬到 0.15；主循环 needsPhysics = alpha > 0.02
 * 因此永真——新用户空库 / 搜索过滤零命中时，rAF 60fps 每帧空转 physics×2
 * 并重铺整块画布背景，与文件头第 5 点「稳定后停止重绘（CPU 归零）」矛盾。
 * 修复：把 alpha 衰减移到空图早退之前（非空图行为不变：物理计算用本地 alpha 快照）。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法
 * （learn-enter-ime-guard.test.ts / brain-review-unmount-abort.test.ts 的静态扫描）：
 * 直接读组件源码，剥离注释后按花括号配平抽出 physics 函数体做断言，
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

const BODY = extractArrowBody(SRC, "const physics = () =>");

describe("graph-view.tsx：空图状态 alpha 必须在早退之前衰减", () => {
  it("抽取器确实抓到了 physics 函数体（防止组件重构后扫描悄悄变空）", () => {
    expect(BODY).not.toBeNull();
    expect(BODY!).toContain("nodesRef.current");
    expect(BODY!).toContain("if (nodes.length === 0) return;");
  });

  it("physics 体内 alpha 衰减语句恰好一处（非空图冷却行为不变，且未被重复衰减）", () => {
    const hits = BODY!.split("alphaRef.current = alpha * 0.99").length - 1;
    expect(hits).toBe(1);
  });

  it("核心回归锁：alpha 衰减写在空图早退之前——0 节点时 alphaRef 仍会下降", () => {
    const decay = BODY!.indexOf("alphaRef.current = alpha * 0.99");
    const earlyReturn = BODY!.indexOf("if (nodes.length === 0) return;");
    expect(decay).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(decay).toBeLessThan(earlyReturn);
    // 早退之前的函数体确实对 alphaRef 赋了值（确保空图帧也吃到衰减）
    expect(BODY!.slice(0, earlyReturn)).toContain("alphaRef.current =");
  });

  it("主循环仍以 alpha > 0.02 为 needsPhysics 条件（冷却契约未被绕过）", () => {
    expect(SRC).toContain("alphaRef.current > 0.02 || dragNodeRef.current");
  });
});
