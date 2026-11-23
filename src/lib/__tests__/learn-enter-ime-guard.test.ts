import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 中文输入法选词回车误触发的回归锁 ============
 * 背景：/learn 页两处输入框（「想学点什么」start() 与方向引导 doSend()）
 * 的 Enter 处理此前只判 e.key === "Enter"，拼音输入法选词回车
 * （keydown.isComposing=true）会把半成品字母当对话发给 AI、
 * 或以拼音 topic 直接 router.push 开一场新引导。
 * 修复后与全站统一守卫一致（learn/new/page.tsx、council、agent-home、
 * assistant-widget 均为 e.key === "Enter" && !e.nativeEvent.isComposing && …）。
 *
 * vitest 无 DOM 环境（无 jsdom），无法渲染组件模拟 keydown，
 * 因此采用本仓库既有做法（seats.test.ts 的静态扫描）：
 * 直接读页面源码，按括号配平抽出每个 onKeyDown 处理函数体做断言。
 * 断言按语义锚点（start()/doSend()）而非行号，重排/换行不误报。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/learn/page.tsx"), "utf8");

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

describe("learn/page.tsx：Enter 提交必须带中文输入法守卫（!isComposing）", () => {
  const handlers = extractKeyDownHandlers(PAGE);

  it("抽取器确实抓到了本页的两个 Enter 提交（防止页面重构后扫描悄悄变空）", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(2);
    expect(handlers.filter((h) => h.includes('"Enter"')).length).toBeGreaterThanOrEqual(2);
  });

  it("「想学点什么」输入框：Enter 触发 start() 且带 !isComposing 守卫", () => {
    const hit = handlers.filter((h) => h.includes("start()"));
    expect(hit.length).toBeGreaterThanOrEqual(1);
    for (const h of hit) {
      expect(h).toContain('"Enter"');
      expect(h).toContain("isComposing");
    }
  });

  it("方向引导输入框：Enter 触发 doSend() 且带 !isComposing 守卫", () => {
    const hit = handlers.filter((h) => h.includes("doSend()"));
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
