import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 登录页四处 Enter 提交的中文输入法守卫回归锁 ============
 * 背景：login-form.tsx 的 email / password / 激活码·重置码 / 邀请人码四个输入框
 * 的 onKeyDown 此前只判 e.key === "Enter"，与全站统一守卫
 * （learn/page.tsx、learn/new/page.tsx、council、agent-home、assistant-widget
 * 均为 e.key === "Enter" && !e.nativeEvent.isComposing && …）不一致——
 * learn-enter-ime-guard.test.ts 锁定了其他页面却漏了登录页。
 * 中文输入法选词回车（keydown.isComposing=true）会把半成品拼音串当邮箱/密码/
 * 激活码触发 submit()：登录/注册收到一次必然失败的请求，重置模式更会把
 * 半成品当新密码提交后被服务端拒。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用 learn-enter-ime-guard.test.ts 的
 * 静态扫描做法：读源码、按括号配平抽出每个 onKeyDown 表达式体做断言，
 * 按语义锚点（submit()）而非行号锚定，重排/换行不误报。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/login/login-form.tsx"), "utf8");

/** 抽出源码里每个 onKeyDown={...} 的表达式体（JSX 花括号配平，支持多行/嵌套）。 */
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

describe("login-form.tsx：Enter 提交必须带中文输入法守卫（!isComposing）", () => {
  const handlers = extractKeyDownHandlers(PAGE);

  it("抽取器确实抓到了本页的四个 Enter 提交（防止表单重构后扫描悄悄变空）", () => {
    expect(handlers.filter((h) => h.includes("submit()")).length).toBe(4);
  });

  it("一票否决：本页任何 onKeyDown 里的 Enter 判断都不得缺 isComposing（防新增输入框漏加）", () => {
    const enterHandlers = handlers.filter((h) => h.includes('"Enter"'));
    expect(enterHandlers.length).toBeGreaterThan(0);
    for (const h of enterHandlers) {
      expect(h).toContain("isComposing");
    }
  });
});
