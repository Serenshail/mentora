import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ /read/[id] 读书伙伴：Enter 提交的中文输入法守卫（回归锁） ============
 * 背景：本页三处 Enter 提交——主聊天输入（doSend）、章节沉淀（addDeposit）、
 * 「待解决的问题」快速添加（updateBookLearning + addBookDeposit）——此前只判
 * e.key === "Enter"。中文输入法按 Enter 确认候选词时 Chromium 系浏览器会派发
 * key="Enter" 且 isComposing=true 的 keydown，此时 onChange 已把未完成的拼音串
 * 写进 state：主聊天会把半截拼音发给 AI（服务端计费），沉淀/待解决问题会把
 * 半截文本入库并同步上云。本产品 UI 全中文，属高频路径。
 * 修复后与全站一致（learn/page.tsx、learn/new/page.tsx、council、agent-home、
 * assistant-widget 均为 e.key === "Enter" && !e.nativeEvent.isComposing && …）。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法（learn-enter-ime-guard.test.ts、
 * seats.test.ts 的静态扫描）：读页面源码、剥离注释、按括号配平抽出每个
 * onKeyDown 处理函数体做断言。断言按语义锚点（doSend/addDeposit/questionDraft）
 * 而非行号，重排/换行不误报。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/read/[id]/page.tsx"), "utf8");

/** 剥离块/行注释（感知字符串与转义），防止把守卫注释掉骗过本锁。 */
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
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += src[i];
          i++;
          if (i < n) {
            out += src[i];
            i++;
          }
          continue;
        }
        out += src[i];
        i++;
      }
      if (i < n) {
        out += src[i];
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 抽出源码里每个 onKeyDown={...} 的表达式体（JSX 花括号配平，支持多行/嵌套 if）。 */
function extractKeyDownHandlers(src: string): string[] {
  const out: string[] = [];
  let idx = src.indexOf("onKeyDown=");
  while (idx !== -1) {
    const open = src.indexOf("{", idx);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(open + 1, end));
    idx = src.indexOf("onKeyDown=", end);
  }
  return out;
}

describe("read/[id]/page.tsx：Enter 提交必须带中文输入法守卫（!isComposing）", () => {
  const handlers = extractKeyDownHandlers(stripComments(PAGE));

  it("抽取器确实抓到了本页的三处 Enter 提交（防页面重构后扫描悄悄变空）", () => {
    const enterHandlers = handlers.filter((h) => h.includes('"Enter"'));
    expect(enterHandlers.length).toBeGreaterThanOrEqual(3);
  });

  it("主聊天输入：Enter 触发 doSend() 且带 !isComposing 守卫", () => {
    const hit = handlers.filter((h) => h.includes("doSend()"));
    expect(hit.length).toBeGreaterThanOrEqual(1);
    for (const h of hit) {
      expect(h).toContain('"Enter"');
      expect(h).toContain("isComposing");
    }
  });

  it("章节沉淀输入：Enter 触发 addDeposit() 且带 !isComposing 守卫", () => {
    const hit = handlers.filter((h) => h.includes("addDeposit("));
    expect(hit.length).toBeGreaterThanOrEqual(1);
    for (const h of hit) {
      expect(h).toContain('"Enter"');
      expect(h).toContain("isComposing");
    }
  });

  it("待解决问题快速添加：Enter 写入 unresolvedQuestions 且带 !isComposing 守卫", () => {
    const hit = handlers.filter((h) => h.includes("questionDraft"));
    expect(hit.length).toBeGreaterThanOrEqual(1);
    for (const h of hit) {
      expect(h).toContain('"Enter"');
      expect(h).toContain("isComposing");
    }
  });

  it("一票否决：本页任何 onKeyDown 里的 Enter 判断都不得缺 isComposing（防新增输入框漏加）", () => {
    const enterHandlers = handlers.filter((h) => h.includes('"Enter"'));
    expect(enterHandlers.length).toBeGreaterThan(0);
    for (const h of enterHandlers) {
      expect(h).toContain("isComposing");
    }
  });
});
