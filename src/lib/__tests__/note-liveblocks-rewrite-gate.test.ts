import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 块级 AI 改写竞态门 + 整篇草稿 rebase（回归锁，F11/F12） ============
 * 背景 1（F11）：块级改写等待期（最长 45s）textarea readOnly 只防了输入，
 * 点其他段落 onClick→open(i) 没有 rewriting 门——异步返回后 setText(rewritten) +
 * pendingRef={index:i} 会把改写稿写进用户后来点开的段落 j（段落错位/重复）。
 * 且 onRewrite 直连 aiNote 不走 setAiBusy，父级「AI 总结/润色/整理」在块级改写
 * 期间仍可点击，两个 AI 并发写同一篇。
 * 修复：open() 首条语句加 rewriting 门；onRewrite 经 rewriteNoteBlock 占住 aiBusy。
 *
 * 背景 2（F12）：空笔记整篇（whole）草稿提交是无条件整体替换——敲字期间外部落库
 * （bindStoreSync 跨标签页 adopt 整仓替换 knowledge）到达后，blur/卸载会用 stale
 * 草稿覆盖 adopt 进来的正文。修复：rebaseDraft 的 whole 分支在 currentBody 非空时
 * 追加为独立段落（与段级路径同一哲学：宁可多一段也不静默丢字）；卸载兜底也统一
 * 过 rebaseDraft（等值不再产生多余 store 写）。
 *
 * 剥注释说明：note-workspace.tsx 的正则字面量里含反引号（如 /[#*`>-]/g、/^```/），
 * 仓库惯用的字符级字符串状态机剥注释器会被这些反引号骗进假字符串模式、跳过后文
 * 的注释剥离。本文件已核实全部 /* 与 // 均为真实注释（无字符串内注释符），
 * 故改用非贪婪正则一次性剥块/行注释，语义等价且不受正则反引号干扰。 */

const SRC = readFileSync(join(process.cwd(), "src/components/brain/note-workspace.tsx"), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\n]*/g, "");

/** 从 marker 之后第一个 { 起，按花括号配平抽出函数体。 */
function extractBody(src: string, marker: string): string | null {
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

const OPEN = extractBody(SRC, "const open = (i: number) =>");
/* rebaseDraft 的参数类型注解里就有 { 字面量，extractBody 会截错：
 * 直接取「函数定义 → 下一个顶层函数（LiveBlocks）」的窗口。 */
const REBASE = SRC.slice(
  SRC.indexOf("function rebaseDraft("),
  SRC.indexOf("function LiveBlocks(")
);

describe("LiveBlocks：块级改写等待期禁止切换编辑目标", () => {
  it("抽取器确实抓到了 open() 函数体", () => {
    expect(OPEN).not.toBeNull();
    expect(OPEN!).toContain("setActive(i)");
  });

  it("核心回归锁：rewriting 门是 open() 的第一条语句（点击与键盘同路径）", () => {
    const gate = OPEN!.indexOf("if (rewriting) return;");
    expect(gate).toBeGreaterThan(-1);
    /* 门之前不允许有任何语句（注释已剥掉，只容空白） */
    expect(OPEN!.slice(0, gate).trim()).toBe("");
    const commitSwitch = OPEN!.indexOf("if (pendingRef.current) commit();");
    expect(commitSwitch).toBeGreaterThan(gate);
  });
});

describe("块级改写占住全局 AI 忙碌位", () => {
  it("rewriteNoteBlock 包裹 aiNote 并 setAiBusy，父级 AI 按钮在等待期 disabled", () => {
    const block = extractBody(SRC, "const rewriteNoteBlock = useCallback(");
    expect(block).not.toBeNull();
    expect(block).toContain('setAiBusy("rewrite")');
    expect(block).toContain('aiNote("rewrite", t)');
    expect(block).toContain("setAiBusy(null)");
  });

  it("LiveBlocks 的 onRewrite 用稳定回调，旧的直连内联箭头已移除", () => {
    expect(SRC).toContain("onRewrite={rewriteNoteBlock}");
    expect(SRC).not.toContain('onRewrite={(t) => aiNote("rewrite", t)}');
  });
});

describe("整篇（whole）草稿 rebase：外部写入到达时追加而非覆盖", () => {
  it("抽取器确实抓到了 rebaseDraft 函数体", () => {
    expect(REBASE).toContain("function rebaseDraft(");
    expect(REBASE).toContain('pending.mode === "whole"');
  });

  it("核心回归锁：等值不写回；currentBody 非空时把草稿追加为独立段落", () => {
    expect(REBASE).toContain("if (pending.text === currentBody) return null;");
    expect(REBASE).toContain("if (currentBody.trim())");
    expect(REBASE).toContain('[...splitBlocks(currentBody), pending.text].join("\\n\\n")');
  });

  it("currentBody 为空（正常空笔记路径）仍整体写回，行为不变", () => {
    const wholeBranch = REBASE.slice(REBASE.indexOf('pending.mode === "whole"'));
    expect(wholeBranch).toContain("return pending.text;");
  });

  it("卸载兜底也统一走 rebaseDraft（等值不再产生多余的 store 写）", () => {
    expect(SRC).toContain("rebaseDraft(pending, bodyRef.current)");
    expect(SRC).not.toContain("commitRef.current(pending.text)");
  });
});
