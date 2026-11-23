import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ /brain 实时预览：LiveBlocks 必须按笔记重挂载（回归锁） ============
 * 背景：LiveBlocks 的 text / active / pendingRef 是组件内 state，没有任何「body 变了
 * 就重置」的逻辑。它挂在 note.body 变化时不会重挂载的同一 JSX 位置（<LiveBlocks
 * body={note.body} …>），于是切笔记时实例被复用：
 *   (a) 在上一篇的某块里编辑过（哪怕已 blur 提交，text 仍保留旧草稿）；
 *   (b) 点未解析的 [[双链]] → onCreate → openByTitle(title, true) → onOpenNote +
 *       onModeChange("edit")，React 批处理下 wsMode 仍是 edit、LiveBlocks 不卸载；
 *   (c) ⌘K / URL ?note=id 只 setOpenId 不改 wsMode（app/brain/page.tsx），同样留在 edit。
 * 目标笔记为空（blocks=[]）时走整篇 textarea 分支，value={text} 直接把上一篇的残留
 * 文本渲染成新笔记正文（autoFocus）。用户继续敲任何一个字符并失焦，commit() 看到
 * pendingRef(mode:"whole") 与空 body 不同，就把「残留文本 + 新键入」整体写成新笔记正文。
 * 同一路径下在途的块级 AI 改写（onRewrite 返回后 setText + pendingRef）也会落到新笔记。
 *
 * 修复：给 <LiveBlocks> 加 key={note.id}，切笔记即强制重挂载，state/ref 全部重建；
 * 旧实例的卸载清理仍按上一帧的 onCommit 闭包（commitRef）把未提交草稿写回上一篇。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法（note-ai-append-live-body.test.ts /
 * brain-review-unmount-abort.test.ts 的静态扫描 + 剥注释）：直接读组件源码做断言，
 * 按语义锚点而非行号，重排/换行不误报。剥注释防止把 key 注释掉骗过本锁。 */

const SRC = readFileSync(
  join(process.cwd(), "src/components/brain/note-workspace.tsx"),
  "utf8"
);

/** 剥离块/行注释（感知字符串与转义），只用于本测试的静态扫描。 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : "";
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++; // 保留换行，行号结构不乱
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

/* 组件源码是 CRLF（Windows 检出），统一成 LF 再按多行锚点扫描 */
const CODE = stripComments(SRC).replace(/\r\n/g, "\n");

/** 取出 <LiveBlocks …/> 元素的完整开标签文本（含所有 props）。 */
function liveBlocksOpenTags(src: string): string[] {
  const out: string[] = [];
  let idx = src.indexOf("<LiveBlocks");
  while (idx !== -1) {
    // 开标签以 "/>" 或 ">" 结束；props 里没有 ">"（箭头函数只到 "}"）
    const end = src.indexOf("/>", idx);
    if (end === -1) break;
    out.push(src.slice(idx, end));
    idx = src.indexOf("<LiveBlocks", end);
  }
  return out;
}

describe("note-workspace：切笔记时 LiveBlocks 必须重挂载，不得沿用上一篇的编辑器 state", () => {
  const tags = liveBlocksOpenTags(CODE);

  it("抽取器确实抓到了 <LiveBlocks> 渲染点（防止组件重构后扫描悄悄变空）", () => {
    expect(tags.length).toBeGreaterThanOrEqual(1);
  });

  it("LiveBlocks 带 key={note.id}：key 变化即重挂载，text/active/pendingRef 全部重建", () => {
    for (const tag of tags) {
      expect(tag).toContain("key={note.id}");
      // key 与 body 必须在同一个元素上：挂到外层 div 上不会重挂载 LiveBlocks
      expect(tag).toContain("body={note.body}");
    }
  });

  it("key 不得退化为常量/下标（那等于没加，实例仍复用）", () => {
    for (const tag of tags) {
      expect(tag).not.toMatch(/key=\{\s*i\s*\}/);
      expect(tag).not.toMatch(/key=\{["'][^"']*["']\}/);
      expect(tag).not.toMatch(/key=\{(?:index|0|1)\}/);
    }
  });

  it("漏洞路径仍在：空笔记走 value={text} 的整篇 textarea（所以必须靠重挂载清空）", () => {
    // 这条断言是给「有人删掉 textarea 分支后本锁仍全绿」兜底的：只要该分支存在，
    // 就说明残留 text 仍会直接上屏，key 重挂载是唯一防线。
    expect(CODE).toContain("blocks.length === 0 ?");
    expect(CODE).toMatch(/value=\{text\}/);
    // 初始 text 为空串——重挂载后新实例从空开始
    expect(CODE).toMatch(/useState\(\s*""\s*\)/);
  });

  it("卸载清理用 commitRef 写回上一篇（重挂载不能把草稿写进新笔记）", () => {
    expect(CODE).toContain("const commitRef = useRef(onCommit)");
    expect(CODE).toContain("commitRef.current = onCommit");
    // 清理段必须走 commitRef，不得直接调 onCommit（那是本次渲染的新笔记）
    const cleanupStart = CODE.indexOf("pendingRef.current = null;\n      if (!pending) return;");
    expect(cleanupStart).toBeGreaterThan(-1);
    const cleanup = CODE.slice(cleanupStart, cleanupStart + 600);
    /* 写回值从 pending.text 升级为 rebaseDraft(pending, bodyRef.current) 的结果
     * （whole 模式有外部写入到达时追加而非覆盖、等值不写回），
     * 「必须经 commitRef 写回上一篇」的契约本身不变 */
    expect(cleanup).toContain("commitRef.current(");
  });
});
