import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ /read/[id]「待解决的问题」单一显示回归锁 ============
 * 背景：快速添加与节点沉淀框都双写两条数据源（updateBookLearning 的
 * unresolvedQuestions + addBookDeposit 的 type:"unresolved"），而右栏列表在同一个
 * <ul> 里先渲染 unresolvedQuestions 再渲染 deposits——任一入口记录的问题都会
 * 渲染成两行相同文本，污染后续跟进所依赖的问题清单。
 *
 * 修复（显示层收口）：两个 <li> 组合并成一个去重集合（unresolvedQuestions 排前——
 * 它是 bookCtx 喂给 AI 的权威清单；deposits 只补充不在清单里的旧数据）。
 * 写入路径保持双写不动：deposits 还是沉淀时间线的记录源。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/read/[id]/page.tsx"), "utf8");

describe("read/[id] 待解决问题列表单一显示", () => {
  it("两个来源合并为去重集合后统一渲染（Set 收口）", () => {
    expect(PAGE).toMatch(
      /\.\.\.new Set\(\[\s*\.\.\.\(book\.learning\?\.unresolvedQuestions \?\? \[\]\),/
    );
    expect(PAGE).toMatch(
      /\.\.\.\(book\.deposits \?\? \[\]\)\.filter\(\(d\) => d\.type === "unresolved"\)\.map\(\(d\) => d\.text\),/
    );
  });

  it("不再存在「unresolvedQuestions 与 deposits 各自一组 <li>」的重复渲染", () => {
    // 旧实现：两组各 map 出 <li>（deposits 组用 d.text 直接渲染）
    expect(PAGE).not.toMatch(
      /\(book\.learning\?\.unresolvedQuestions \?\? \[\]\)\.slice\(0, 5\)\.map\(\(q, i\) =>/
    );
    expect(PAGE).not.toMatch(
      /\(book\.deposits \?\? \[\]\)\.filter\(\(d\) => d\.type === "unresolved"\)\.slice\(0, 5\)\.map\(\(d\) =>/
    );
  });

  it("写入路径仍是双写（deposits 保持沉淀时间线语义，不被本次修复破坏）", () => {
    const quickAdd = PAGE.slice(PAGE.indexOf("记一个问题…"));
    expect(quickAdd).toContain("updateBookLearning(book.id, { unresolvedQuestions:");
    expect(quickAdd).toContain('addBookDeposit(book.id, { chapterId: chapter?.id, type: "unresolved"');
    const depositFn = PAGE.slice(PAGE.indexOf("const addDeposit ="), PAGE.indexOf("const nodeRecap ="));
    expect(depositFn).toContain("addBookDeposit(book.id, { chapterId, type: depositType, text })");
    expect(depositFn).toContain("updateBookLearning(book.id, { unresolvedQuestions: [text] })");
  });
});
