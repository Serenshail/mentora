import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 学习日详情页 Enter 提交的中文输入法守卫回归锁 ============
 * 背景：/learn/[id] 页有两个「回车即提交」的输入框——
 *   · AskCoach（看不懂？问教练）：Enter → send()，会消耗一次 BYOK 调用并把问题写进 day.qa；
 *   · QuickNotes（随手记）：Enter → addKnowledge() 落库并清空输入框。
 * 此前两者都只判 e.key，中文输入法选词回车（keydown.isComposing=true）会把
 * 组词缓冲区里的半截文本当作最终输入提前发送/保存。
 * 修复后与全站统一守卫一致：council/page.tsx、learn/new/page.tsx、
 * components/assistant-widget.tsx、agent-home.tsx、learn/page.tsx
 * 均为 e.key === "Enter" && !e.nativeEvent.isComposing && …。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法
 * （learn-enter-ime-guard.test.ts / seats.test.ts 的静态扫描）：
 * 读页面源码、按花括号配平抽出每个 onKeyDown 处理体做断言。
 * 断言按语义锚点（send() / addKnowledge）而非行号，重排不误报。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/learn/[id]/page.tsx"), "utf8");

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

describe("learn/[id]/page.tsx：Enter 提交必须带中文输入法守卫（!isComposing）", () => {
  const handlers = extractKeyDownHandlers(PAGE);

  it("抽取器确实抓到了本页的两个 Enter 提交（防止页面重构后扫描悄悄变空）", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(2);
    expect(handlers.filter((h) => h.includes('"Enter"')).length).toBeGreaterThanOrEqual(2);
  });

  it("AskCoach 输入框：Enter 触发 send() 且带 !isComposing 守卫（否则半截问题会被发送并计费）", () => {
    const hit = handlers.filter((h) => h.includes("send()"));
    expect(hit.length).toBeGreaterThanOrEqual(1);
    for (const h of hit) {
      expect(h).toContain('"Enter"');
      expect(h).toContain("isComposing");
    }
  });

  it("QuickNotes 输入框：Enter 触发 addKnowledge() 且带 !isComposing 守卫（否则半截笔记落库并清空输入）", () => {
    const hit = handlers.filter((h) => h.includes("addKnowledge"));
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
