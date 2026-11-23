import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 登录表单输入框可访问名回归锁 ============
 * 背景：/login 的姓名、邮箱、密码、激活码/重置码、邀请人码五个 <Input>
 * 此前只有 placeholder，没有 <label>/aria-label/aria-labelledby。
 * placeholder 作为可访问名在屏幕阅读器上支持不一致，且用户输入后提示消失，
 * 不满足 WCAG 1.3.1 / 3.3.2 的标签要求。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法（learn-enter-ime-guard.test.ts、
 * seats.test.ts 的静态扫描）：读源码，按 JSX 花括号/尖括号配平抽出每个 <Input ...> 元素，
 * 断言其带有 aria-label（静态字符串或随 mode 变化的表达式均可）。
 * 断言按结构而非行号，重排/换行不误报。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/login/login-form.tsx"), "utf8");

/** 抽出所有 <Input ...> 开标签的属性文本（含多行，遇到配平后的 ">" 结束）。 */
function extractInputTags(src: string): string[] {
  const out: string[] = [];
  let idx = src.indexOf("<Input");
  while (idx !== -1) {
    let i = idx + "<Input".length;
    let brace = 0;
    let quote: string | null = null;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === quote && src[i - 1] !== "\\") quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "{") brace++;
      else if (ch === "}") brace--;
      else if (ch === ">" && brace === 0) break;
    }
    out.push(src.slice(idx, i + 1));
    idx = src.indexOf("<Input", i + 1);
  }
  return out;
}

describe("login-form 输入框可访问名", () => {
  const tags = extractInputTags(PAGE);

  it("五个输入框全部存在（防止扫描失效导致的假通过）", () => {
    expect(tags.length).toBe(5);
  });

  it("每个输入框都有 aria-label 或 aria-labelledby", () => {
    const missing = tags.filter(
      (t) => !/aria-label(ledby)?\s*=/.test(t)
    );
    expect(missing).toEqual([]);
  });

  it("每个输入框都同时保留 placeholder 作为可见提示", () => {
    for (const t of tags) expect(t).toMatch(/placeholder\s*=/);
  });

  it("密码与验证码的标签随模式区分，而不是笼统一句", () => {
    const all = tags.join("\n");
    // 密码：登录态「密码」/ 注册重置态「新密码」
    expect(all).toMatch(/aria-label=\{mode === "login" \? "密码" : "新密码"\}/);
    // 验证码：注册态「激活码」/ 重置态「重置码」
    expect(all).toMatch(/aria-label=\{mode === "register" \? "激活码（必填）" : "重置码（必填）"\}/);
  });
});
