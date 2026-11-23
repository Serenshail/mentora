import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 Markdown 解析：紧邻段落的 GFM 表格被打断（回归锁） ============
 * 事故链（FIX heavy-f90-mdjs-1）：块级识别只在主循环入口（md.js 表格分支）判断
 * 表格，而段落合并循环的停止条件只列了空行/列表/#/>/```/分隔线，漏了 `|` 表格行。
 * AI 输出「段落行 + 换行 + 表格」（GFM 合法：表格可以打断段落）时，整张表连同
 * 分隔行被 join 进 pbuf 变成一段纯文本，小程序 rich-text 里表格结构丢失，
 * 讲义/笔记/纪要场景退化成一行乱码似的文字。
 *
 * 这里直接加载真实 CommonJS 模块 mentora/miniprogram/utils/md.js 跑断言，
 * 同时锁住「不是表格的竖线行不应被误切」与「空行分隔的旧路径不回归」。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();

interface Block {
  t: string;
  nodes?: { children: { text: string }[] }[];
  rows?: { cells: { nodes: { children: { text: string }[] }[] }[] }[];
  items?: unknown[];
}

interface MdMod {
  parse(text: string): { blocks: Block[]; links: { text: string; url: string }[] };
}

function loadMd(): MdMod {
  return requireCjs(join(ROOT, "miniprogram/utils/md.js")) as MdMod;
}

function blockTypes(text: string): string[] {
  return loadMd()
    .parse(text)
    .blocks.map((b) => b.t);
}

function paraText(text: string): string {
  const p = loadMd()
    .parse(text)
    .blocks.find((b) => b.t === "p");
  return (p?.nodes || []).map((n) => n.children[0].text).join("");
}

function tableCellTexts(text: string): string[][] {
  const tb = loadMd()
    .parse(text)
    .blocks.find((b) => b.t === "table");
  return (tb?.rows || []).map((row) => row.cells.map((c) => c.nodes[0].children[0].text));
}

describe("miniprogram md.parse — 段落后的表格", () => {
  it("段落行后无空行紧跟表格：表格被打断成独立 block（事故原样）", () => {
    const src = "段落\n| a | b |\n|---|---|\n| 1 | 2 |";
    expect(blockTypes(src)).toEqual(["p", "table"]);
    // 段落文本必须干净，不能把表格行 join 进来
    expect(paraText(src)).toBe("段落");
    expect(tableCellTexts(src)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("多行段落 + 表格：段落整体合并，表格仍是独立 block", () => {
    const src = "第一行\n第二行\n| a | b |\n|---|---|\n| 1 | 2 |";
    expect(blockTypes(src)).toEqual(["p", "table"]);
    expect(paraText(src)).toBe("第一行 第二行");
    expect(tableCellTexts(src)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("空行分隔的旧路径不回归（仍产出 p + table）", () => {
    const src = "段落\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    expect(blockTypes(src)).toEqual(["p", "table"]);
  });

  it("表格开头/表格后接段落：结构不变", () => {
    expect(blockTypes("| a | b |\n|---|---|\n| 1 | 2 |")).toEqual(["table"]);
    expect(blockTypes("| a | b |\n|---|---|\n| 1 | 2 |\n结尾段落")).toEqual(["table", "p"]);
  });

  it("以 | 开头但不是表格（下一行非分隔行）：仍按段落合并，不被误切", () => {
    expect(blockTypes("段落\n| 不是表格 |")).toEqual(["p"]);
    expect(paraText("段落\n| 不是表格 |")).toBe("段落 | 不是表格 |");
    // 只有分隔行、没有表头也不是表格
    expect(blockTypes("段落\n|---|---|")).toEqual(["p"]);
  });

  it("段落/列表/分隔线等既有停止条件不受影响", () => {
    expect(blockTypes("段落\n- x\n- y")).toEqual(["p", "list"]);
    expect(blockTypes("段落\n---")).toEqual(["p", "hr"]);
    expect(blockTypes("段落\n> 引用")).toEqual(["p", "quote"]);
  });
});
