import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ /learn 入口空输入不得兜底成 "Python" 的回归锁 ============
 * 背景：/learn 页「想学点什么」的 start() 此前是 `topic.trim() || "Python"`。
 * 输入框为空时按回车（onKeyDown 无 disabled 守卫）或点按钮，会带着 "Python"
 * 跳到 /learn/new?topic=Python → 新建一条垃圾草稿并白烧一次 intake AI 调用。
 * /learn/new 在无 ?topic 时（awaitingTopic 分支）特意不再预建 "Python" 草稿，
 * 本页的兜底把同一行为放了回来。
 *
 * vitest 无 DOM 环境，沿用仓库既有做法（learn-enter-ime-guard.test.ts 的静态扫描）：
 * 读页面源码，按花括号配平抽出 start() 函数体做语义断言，不绑行号。 */

const LEARN = readFileSync(join(process.cwd(), "src/app/learn/page.tsx"), "utf8");
const LEARN_NEW = readFileSync(join(process.cwd(), "src/app/learn/new/page.tsx"), "utf8");

/** 抽出具名箭头函数体（`const start = () => {` … 配平右括号）。 */
function extractArrowBody(src: string, name: string): string {
  const anchor = src.indexOf(`const ${name} = () => {`);
  expect(anchor, `找不到 ${name}() 定义——页面结构变了，请更新本回归锁`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf("{", anchor);
  let depth = 0;
  let end = open;
  for (; end < src.length; end++) {
    if (src[end] === "{") depth++;
    else if (src[end] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(open + 1, end);
}

/** 去掉注释，避免说明性注释里的字面量干扰"不得出现"类断言。 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("learn/page.tsx：空 topic 不得兜底成 \"Python\" 建草稿", () => {
  const body = stripComments(extractArrowBody(LEARN, "start"));

  it("start() 不再用 `|| \"Python\"` 之类的硬编码兜底", () => {
    expect(body).not.toContain('"Python"');
    expect(body).not.toContain("'Python'");
    expect(body).not.toMatch(/\|\|\s*["'`]Python/);
  });

  it("start() 对空输入直接返回，不 router.push", () => {
    expect(body).toMatch(/const\s+t\s*=\s*topic\.trim\(\)/);
    expect(body).toMatch(/if\s*\(!t\)\s*return/);
    // push 必须在空值提前返回之后：截断到 return 之前不应出现 router.push
    const beforeGuard = body.slice(0, body.indexOf("if (!t) return"));
    expect(beforeGuard).not.toContain("router.push");
    expect(body).toContain("router.push(`/learn/new?topic=${encodeURIComponent(t)}`)");
  });

  it("「开始引导」按钮在输入为空时 disabled（与 learn/new 入口按钮一致）", () => {
    expect(LEARN).toMatch(/<Button\s+onClick=\{start\}\s+disabled=\{!topic\.trim\(\)\}/);
  });

  it("配套不变式：/learn/new 无 ?topic 时仍走 awaitingTopic，不预建草稿", () => {
    expect(LEARN_NEW).toContain("setAwaitingTopic(true)");
    expect(LEARN_NEW).toMatch(/if\s*\(!topicParam\)\s*\{\s*setAwaitingTopic\(true\);\s*return;/);
  });
});
