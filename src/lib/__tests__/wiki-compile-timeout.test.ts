import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ LLMWiki 编译：串行 streamChat 必须带 AbortSignal.timeout（回归锁） ============
 * 背景：「AI 整理」按钮（note-workspace.tsx）调 runWikiCompile，for 循环最多 3 次串行
 * streamChat。调用方期间 aiBusy=true 把 AI 总结/润色/整理整条编辑工具栏 disabled，且
 * 没有任何取消路径；streamChat 不传 signal 时 fetch 无超时依赖浏览器默认，上游挂起时
 * UI 无限期停在「AI 中…」。同文件 aiNote/autolink 均已确立 AbortSignal.timeout(45_000)
 * 的既有标准（note-workspace.tsx 注释明言「弱网下不设超时会让 aiBusy 恒为 true」）。
 * 修复：wiki-compile.ts 的 streamChat 补 signal: AbortSignal.timeout(45_000)，超时走
 * 既有 catch 计入 failed/lastError。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法
 * （brain-review-unmount-abort.test.ts / seats.test.ts 的静态扫描）：
 * 直接读源码断言，按语义锚点而非行号，重排/换行不误报。
 * 扫描前先剥离注释（负向验证发现：注释掉的旧代码会被裸扫描误匹配成"仍在"），
 * 防止把 signal 行注释掉骗过本锁。 */

const SRC_RAW = readFileSync(join(process.cwd(), "src/lib/wiki-compile.ts"), "utf8");

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

const SRC = stripComments(SRC_RAW);

/** 抽出源码里每个 streamChat(...) 调用的完整实参（圆括号配平，支持多行/嵌套）。 */
function extractStreamChatArgs(src: string): string[] {
  const out: string[] = [];
  let idx = src.indexOf("streamChat(");
  while (idx !== -1) {
    const open = src.indexOf("(", idx);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(open + 1, end));
    idx = src.indexOf("streamChat(", end);
  }
  return out;
}

describe("wiki-compile.ts：串行编译的 streamChat 必须带 AbortSignal.timeout（aiBusy 锁死防线）", () => {
  const calls = extractStreamChatArgs(SRC);

  it("抽取器确实抓到了本文件的 streamChat 调用（防止重构后扫描悄悄变空）", () => {
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("每一处 streamChat 调用都带 signal: AbortSignal.timeout(<有限毫秒>)，无一豁免", () => {
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const args of calls) {
      const m = /signal\s*:\s*AbortSignal\.timeout\(\s*(\d[\d_]*)\s*\)/.exec(args);
      // 缺 signal = 回归：上游挂起时「AI 整理」按钮永久锁死
      expect(m, `streamChat 调用缺 signal/AbortSignal.timeout：${args.slice(0, 120)}`).not.toBeNull();
      // 数值必须是真实超时（≥1s）而非摆设：0/极小值等于没有超时
      const ms = Number(m![1].replace(/_/g, ""));
      expect(ms).toBeGreaterThanOrEqual(1000);
    }
  });

  it("signal 行不在注释里（剥离注释后仍然在场）", () => {
    expect(SRC).toMatch(/signal\s*:\s*AbortSignal\.timeout\(/);
  });

  it("超时失败必须计入 failed/lastError 而不是静默假空态（既有 catch 语义不得回退）", () => {
    // runWikiCompile 的 catch 块仍要把失败暴露给调用方
    expect(SRC).toMatch(/catch\s*\(/);
    expect(SRC).toContain("res.failed++");
    expect(SRC).toContain("res.lastError =");
  });
});
