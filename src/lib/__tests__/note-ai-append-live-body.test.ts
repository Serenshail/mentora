import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ /brain 笔记工作区：AI 总结/润色回写不得用点击时的正文快照（回归锁） ============
 * 背景：aiNote 走 streamChat，服务端最长等 45s（AbortSignal.timeout(45_000)）。
 * 等待期间编辑器并未锁死——raw 模式 textarea 的 onChange 与 live 模式 LiveBlocks 的
 * onCommit 都经 onTaChange/setBody 逐键落库（zustand updateKnowledge，version+1，
 * 无历史快照，覆盖不可恢复）。旧实现在 onClick 里 `await aiNote(..., note.body)` 后
 * 直接 `setBody(note.body + "\n\n## 摘要\n" + sum)` / `setBody(rw)`——用的仍是点击时
 * 捕获的 note 引用，updateKnowledge 整体覆盖正文，把用户在等待期敲入的内容静默抹掉。
 * 修复：请求返回后先从 useAppStore.getState() 取该笔记此刻的最新正文（live），
 * 总结/润色结果都以 live 为基底落库。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法
 * （brain-review-unmount-abort.test.ts 的静态扫描 + 剥注释）：
 * 直接读组件源码做断言，按语义锚点而非行号，重排/换行不误报。
 * 扫描前先剥离注释，防止把修复代码注释掉骗过本锁。 */

const SRC = readFileSync(
  join(process.cwd(), "src/components/brain/note-workspace.tsx"),
  "utf8"
);

/** 剥离块/行注释（感知字符串与转义），只用于本测试的静态扫描。
 * 与 brain-review-unmount-abort.test.ts 同款实现。 */
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

const CODE = stripComments(SRC);

/** 按 onClick 处理器内的 await aiNote(...) 位置，把源码切成片段。
 * 点击处理器的结构固定为：await aiNote( 之后到 finally 的片段即「回写段」。 */
function segmentsAfterAwaitAiNote(src: string): string[] {
  const out: string[] = [];
  let idx = src.indexOf("await aiNote(");
  while (idx !== -1) {
    const end = src.indexOf("finally", idx);
    out.push(end === -1 ? src.slice(idx) : src.slice(idx, end));
    idx = src.indexOf("await aiNote(", idx + 1);
  }
  return out;
}

describe("note-workspace：AI 总结/润色回写必须基于等待期后的最新正文", () => {
  const segs = segmentsAfterAwaitAiNote(CODE);

  it("抽取器确实抓到了 await aiNote 的调用点（防止组件重构后扫描悄悄变空）", () => {
    expect(segs.length).toBeGreaterThanOrEqual(2); // AI 总结 + AI 润色两个按钮
  });

  it("总结回写：返回后取 getState() 的 live 正文，不再用点击时的 note.body 快照拼『## 摘要』", () => {
    const summarize = segs.find((s) => s.includes("aiNote(\"summarize\""));
    expect(summarize).toBeDefined();
    expect(summarize).toContain("useAppStore.getState()");
    expect(summarize).toContain("?.body ?? note.body");
    expect(summarize).not.toContain('setBody(note.body + "\\n\\n## 摘要\\n"');
  });

  it("润色回写：同样取 live 正文落库，不允许整篇替换为纯 AI 结果 setBody(rw)", () => {
    const rewrite = segs.find((s) => s.includes('aiNote("rewrite"'));
    expect(rewrite).toBeDefined();
    expect(rewrite).toContain("useAppStore.getState()");
    expect(rewrite).not.toMatch(/if\s*\(\s*rw\.trim\(\)\s*\)\s*setBody\(rw\s*\)/);
    expect(rewrite).toContain('setBody(live + "\\n\\n## 润色\\n" + rw)');
  });

  it("快照仅可用于发起请求的入参：回写段内除 aiNote(...) 入参外不得再引用 note.body", () => {
    for (const s of segs) {
      // 剥掉两处合法引用（发起请求入参、getState 找不到时的兜底），其余出现即视为回退
      const stripped = s
        .replace(/aiNote\((?:\"[a-z]+\"|'([a-z]+)'),\s*note\.body\)/g, "")
        .replace(/\?\?\s*note\.body/g, "");
      expect(stripped).not.toContain("note.body");
    }
  });
});
