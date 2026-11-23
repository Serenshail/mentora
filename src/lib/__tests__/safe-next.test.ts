/* safeNext 是登录回跳的唯一防线：login-form.tsx 的 router.push/replace 都过它，
 * 服务端 page.tsx 原样透传 ?next=，无第二层校验——这里锁死它的放行/拦截边界。
 *
 * 回归背景（FIX open-redirect）：原正则 /^\/[^/\\]/ 只拒第二字符为 / 或 \，
 * ASCII tab/LF/CR 恰好漏过，而 WHATWG URL 解析会先剥离这些控制字符：
 * ?next=%2F%09%2F%2Fevil.com → /\t//evil.com → new URL 出站到 https://evil.com/。 */
import { describe, expect, it } from "vitest";
import { safeNext } from "../safe-next";

describe("safeNext 只放行站内绝对路径", () => {
  it.each([
    ["/", "/"],
    ["/dashboard", "/dashboard"],
    ["/learn?focus=1&day=3", "/learn?focus=1&day=3"],
    ["/brain?note=abc#section", "/brain?note=abc#section"],
  ])("放行 %j", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["admin"], // 非斜杠开头
    ["//evil.com"], // 协议相对
    ["/\\evil.com"], // 反斜杠变体，WHATWG 解析成 //evil.com
    ["https://evil.com"],
    ["javascript:alert(1)"],
  ])("拦截 %j → 回首页", (input) => {
    expect(safeNext(input)).toBe("/");
  });

  it("拦截控制字符变体（WHATWG 剥离后即协议相对 URL，出站跳转）", () => {
    for (const raw of ["/\t//evil.com", "/\n//evil.com", "/\r//evil.com"]) {
      expect(safeNext(raw)).toBe("/");
      // 出站逃逸成立性的锚点：若解析行为变化，这条会先暴露
      expect(new URL(raw, "https://app.example.com/login").href).toBe("https://evil.com/");
    }
    // 首字符被控制字符前缀的站内路径：宁可拦错也不放行出站风险
    expect(safeNext("\t/admin")).toBe("/");
    /* 任何位置的控制字符一律拒绝：WHATWG 解析会在解析前剥离 tab/LF/CR，
     * 路径内的控制字符会让「看到的 URL」与「实际导航到的 URL」不一致
     * （例如 /notes\t1 实际导航到 /notes1）。白名单式校验不猜浏览器行为，
     * 直接拒绝——正常站内路径不会包含控制字符。 */
    expect(safeNext("/notes\t1")).toBe("/");
    expect(safeNext("/notes\u00001")).toBe("/");
  });
});
