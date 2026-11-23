import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ AI 总结/润色回写前必须先 flush 在途草稿（回归锁，F6/high） ============
 * 背景：raw（源码）模式逐键编辑只推进本地草稿（bodyDraftRef），350ms 定时才落库；
 * setBody 开头无条件丢弃在途草稿。AI 总结/润色按钮只 disabled 自身，textarea 仍可
 * 输入——45s 等待期内用户敲字时，若响应返回时刻距最后一次 flush 不足 350ms，
 * live（从 store 读）不含这段尾巴，随后的 setBody(live+摘要) 把草稿连同屏幕显示
 * 一起清掉：最后几个字符静默丢失并回退。
 * 修复：读取 live 前先 flushBodyDraft()（把 bodyWriterRef 绑定的在途草稿写进 store，
 * zustand set 同步生效，随后 getState 读到的 live 即含尾巴）。
 *
 * vitest 无 DOM 环境，沿用本仓库既有静态扫描做法（note-ai-append-live-body.test.ts）：
 * 剥注释后按语义锚点断言顺序，不绑行号。 */

const SRC = readFileSync(join(process.cwd(), "src/components/brain/note-workspace.tsx"), "utf8")
  .replace(/\r\n/g, "\n");

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

const CODE = stripComments(SRC);

/** 抽出「从 marker 起往后 span 个字符」的窗口（剥注释后）。 */
function windowFrom(marker: string, span = 900): string {
  const at = CODE.indexOf(marker);
  if (at === -1) return "";
  return CODE.slice(at, at + span);
}

describe("AI 总结：回写前先 flush 在途逐键草稿", () => {
  const win = windowFrom('aiNote("summarize", note.body)');

  it("抽到了 AI 总结的处理块", () => {
    expect(win).toContain("setBody(");
  });

  it("核心回归锁：flushBodyDraft() 在读取 live（getState）之前", () => {
    const flush = win.indexOf("flushBodyDraft();");
    const live = win.indexOf("useAppStore.getState()");
    expect(flush).toBeGreaterThan(-1);
    expect(live).toBeGreaterThan(-1);
    expect(flush).toBeLessThan(live);
  });
});

describe("AI 润色：回写前先 flush 在途逐键草稿", () => {
  const win = windowFrom('aiNote("rewrite", note.body)');

  it("抽到了 AI 润色的处理块", () => {
    expect(win).toContain("setBody(");
  });

  it("核心回归锁：flushBodyDraft() 在读取 live（getState）之前", () => {
    const flush = win.indexOf("flushBodyDraft();");
    const live = win.indexOf("useAppStore.getState()");
    expect(flush).toBeGreaterThan(-1);
    expect(live).toBeGreaterThan(-1);
    expect(flush).toBeLessThan(live);
  });
});

describe("「AI 润色全文」的文案与追加语义一致", () => {
  it("按钮 title 与确认框如实说明「追加润色稿」，不再承诺整篇重写", () => {
    expect(CODE).toContain("在文末追加润色稿");
    expect(CODE).toContain("将在文末追加一份润色稿");
    expect(CODE).not.toContain("措辞会重写");
  });

  it("成功提示同步为追加语义", () => {
    expect(CODE).toContain("已在文末追加 AI 润色稿");
  });

  it("落库仍是 live 基底追加（合并等待期编辑的既有契约不变）", () => {
    expect(CODE).toContain('setBody(live + "\\n\\n## 润色\\n" + rw)');
  });
});
