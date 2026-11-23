import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ use-chat：中止生成必须清空 pending/thinking（回归锁） ============
 * 背景：stop() 只 abort 连接（不换代，结果仍按原会话落库）。AbortError 走 catch 的
 * 提前 return，而 setPending("") 只在「非 abort 的错误分支」里——于是四个消费方
 * （assistant-widget / council / read/[id] / learn/new）都无条件渲染 pending 且带
 * <span className="stream-cursor" />，点「停止」后页面留着半截回复 + 闪烁光标，
 * 看着像还在生成，而 finally 已把 streaming 复位、输入框已解锁。
 * council 删除会话前先 stop()（council/page.tsx），残留 pending 还会落在已清空的会话上。
 *
 * 修复：AbortError 分支在 alive() 为真（本轮自己的 abort）时清 pending/thinking；
 * 已 cancel 的旧代（alive() 为假）不许写，否则会清掉新流正在灌的 pending。
 *
 * vitest 无 DOM 环境（未安装 jsdom），沿用本仓库既有做法
 * （council-session-switch-cancel.test.ts / brain-review-unmount-abort.test.ts）：
 * 读源码做语义锚点断言，扫描前剥离注释，防止把守卫注释掉骗过本锁。 */

const HOOK = readFileSync(join(process.cwd(), "src/lib/use-chat.ts"), "utf8");

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

/** 取 marker 之后第一个箭头函数体 `=> { ... }`（花括号配平，含嵌套）。 */
function bodyOf(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at === -1) return "";
  const arrow = src.indexOf("=> {", at);
  if (arrow === -1) return "";
  const open = arrow + 3;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return "";
}

const HOOK_SRC = stripComments(HOOK);
const SEND = bodyOf(HOOK_SRC, "async (opts: {");

describe("use-chat：AbortError（用户停止/卸载）必须清空视图态", () => {
  it("send 的 AbortError 分支清 pending 与 thinking，且受 alive() 保护", () => {
    expect(SEND).not.toBe("");
    const at = SEND.indexOf('name === "AbortError"');
    expect(at).toBeGreaterThan(-1);
    // 从 AbortError 判断到该分支 return ""，中间必须同时清 pending / thinking
    const branchEnd = SEND.indexOf('return "";', at);
    expect(branchEnd).toBeGreaterThan(at);
    const branch = SEND.slice(at, branchEnd);
    expect(branch).toContain("alive()"); // 已 cancel 的旧代不许清新流的 pending
    expect(branch).toContain('setPending("")');
    expect(branch).toContain('setThinking("")');
  });

  it("主动停止不报错：AbortError 分支不设 error 横幅", () => {
    const at = SEND.indexOf('name === "AbortError"');
    const branchEnd = SEND.indexOf('return "";', at);
    const branch = SEND.slice(at, branchEnd);
    expect(branch).not.toContain("setError(");
  });

  it("停止语义不被改坏：AbortError 分支仍然提前 return，不落库、不调 onDone", () => {
    const at = SEND.indexOf('name === "AbortError"');
    const branchEnd = SEND.indexOf('return "";', at);
    expect(branchEnd).toBeGreaterThan(at);
    const branch = SEND.slice(at, branchEnd);
    expect(branch).not.toContain("setMessages("); // 半截回答不进消息列表
    expect(branch).not.toContain("opts.onDone?."); // 也不当作完整回答落库
  });

  it("cancel() 仍清全部视图态（换代后由它负责，不依赖 catch）", () => {
    const cancel = bodyOf(HOOK_SRC, "const cancel = useCallback(");
    for (const s of ['setPending("")', 'setThinking("")', "setStreaming(false)"]) {
      expect(cancel).toContain(s);
    }
  });
});
