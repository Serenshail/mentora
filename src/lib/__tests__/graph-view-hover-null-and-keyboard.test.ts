import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 图谱 hover 判空 + 键盘可达性（回归锁） ============
 * 背景 1（判空恒真）：onPointerMove 里 `node?.id !== hoverRef.current`，
 * pickNode 未命中返回 null，node?.id 是 undefined，`undefined !== null` 恒为真 →
 * 鼠标在空白处每帧 mousemove 都置 dirtyRef 并触发下一帧全量重绘，
 * 大图下 CPU 无法归零，违背文件头「稳定后停止重绘」。修复：按 null 比较。
 *
 * 背景 2（键盘可达性）：图谱交互原本全是指针事件，「点击节点打开笔记」
 * 对键盘/运动障碍用户不可达。修复：canvas tabIndex={0} + 方向键移动键盘
 * 选中（虚线环）+ Enter/Space 打开 + Esc 取消。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法
 * （graph-view-empty-cooldown.test.ts 等静态扫描）：直接读组件源码，
 * 剥离注释后按花括号配平抽出函数体做断言，按语义锚点而非行号。 */

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

/** 从 marker 之后第一个 { 起，按花括号配平抽出箭头函数体。 */
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

const MOVE = extractArrowBody(SRC, "const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) =>");
const KEY = extractArrowBody(SRC, "const onCanvasKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) =>");

/** canvas JSX 开标签（从 "<canvas" 到 ">"，容许属性换行）。 */
function canvasTag(src: string): string | null {
  const start = src.indexOf("<canvas");
  if (start === -1) return null;
  const end = src.indexOf("/>", start);
  return end === -1 ? null : src.slice(start, end);
}

const TAG = canvasTag(SRC);

describe("graph-view.tsx：hover 判空必须按 null 比较", () => {
  it("抽取器确实抓到了 onPointerMove 函数体", () => {
    expect(MOVE).not.toBeNull();
    expect(MOVE!).toContain("pickNode(sx, sy)");
  });

  it("核心回归锁：hover 比较两侧都归一为 null，未命中时不再恒真", () => {
    expect(MOVE!).toContain("(node?.id ?? null) !== hoverRef.current");
    // 旧的恒真比较不得残留在 onPointerMove 内
    expect(MOVE!).not.toContain("node?.id !== hoverRef.current");
  });

  it("赋值仍写回 nullish 兜底后的 id（行为语义不变）", () => {
    expect(MOVE!).toContain("hoverRef.current = node?.id ?? null;");
  });
});

describe("graph-view.tsx：图谱键盘替代路径", () => {
  it("canvas 可聚焦并挂了键盘处理器", () => {
    expect(TAG).not.toBeNull();
    expect(TAG!).toContain("tabIndex={0}");
    expect(TAG!).toContain("onKeyDown={onCanvasKeyDown}");
  });

  it("onCanvasKeyDown 处理器存在且覆盖四个方向键 + Enter/Space 打开 + Esc 取消", () => {
    expect(KEY).not.toBeNull();
    expect(KEY!).toContain("ArrowRight");
    expect(KEY!).toContain("ArrowLeft");
    expect(KEY!).toContain("ArrowDown");
    expect(KEY!).toContain("ArrowUp");
    expect(KEY!).toContain('"Enter" || e.key === " "');
    expect(KEY!).toContain("Escape");
  });

  it("Enter 打开走与指针点击相同的 onOpen 入口", () => {
    expect(KEY!).toContain("onOpen(kbdSelRef.current)");
  });

  it("方向键必须 preventDefault（否则箭头键会滚动页面）", () => {
    const pd = KEY!.indexOf("e.preventDefault();");
    const dirs = KEY!.indexOf("ArrowRight");
    expect(pd).toBeGreaterThan(-1);
    expect(dirs).toBeGreaterThan(-1);
    expect(pd).toBeLessThan(dirs);
  });

  it("键盘选中环在渲染层有虚线标识（与指针 hover 实线区分）", () => {
    expect(SRC).toContain("kbdSel === n.id");
    expect(SRC).toContain('setLineDash([3, 2])');
  });

  it("节点集合变化后清掉已不在图里的键盘选中（防幽灵环）", () => {
    expect(SRC).toContain("if (kbdSelRef.current && !nodesRef.current.some((n) => n.id === kbdSelRef.current))");
  });
});
