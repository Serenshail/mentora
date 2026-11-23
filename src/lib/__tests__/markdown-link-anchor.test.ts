import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server.node";
import { Markdown } from "@/components/markdown";

/* ============ MarkdownLink 页内锚点不得被强制新标签页打开（回归锁） ============
 * 背景：markdown.tsx 的 MarkdownLink 曾对**所有** <a> 无条件加
 * target="_blank"。组件第 39 行无条件启用 remarkGfm，GFM 脚注引用会被
 * mdast-util-to-hast 渲染成 <a href="#user-content-fn-1">（脚注回链为
 * #user-content-fnref-1），[跳转](#锚点) 也是 hash 链接。给它们加
 * target="_blank" 不会在原文档内跳转，而是新开一个重复整页，反而让用户
 * 离开进行中的学习/对话视图——正是组件顶部注释想避免的体验。
 *
 * 修复语义：href 以 "#" 开头的纯页内锚点不加 target/rel（本页内跳转），
 * 其余（外部/相对/绝对路径）一律保留 target="_blank" rel="noopener noreferrer"。
 *
 * 仓库无 jsdom/@testing-library，沿用 wiki-markdown-memo.test.tsx 的做法：
 * 用 react-dom/server 静态渲染**真实** Markdown 组件（不 mock react-markdown /
 * remark-gfm），直接对产出的 <a> 标签断言，是最贴近用户可见行为的回归锁。 */

function render(text: string): string {
  return renderToStaticMarkup(React.createElement(Markdown, { text }));
}

/** 抽出渲染结果里所有 <a ...> 开标签，便于逐条断言属性。 */
function anchors(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
}

describe("MarkdownLink 外链 / 页内锚点分流", () => {
  it("外部 https 链接仍在新标签页打开（保留原设计意图）", () => {
    const html = render("[课程](https://example.com/course)");
    const a = anchors(html);
    expect(a).toHaveLength(1);
    expect(a[0]).toContain('href="https://example.com/course"');
    expect(a[0]).toContain('target="_blank"');
    expect(a[0]).toContain('rel="noopener noreferrer"');
  });

  it("[跳转](#锚点) 是页内锚点：不得加 target/rel，href 保持 # 开头", () => {
    const html = render("[跳转](#section)");
    const a = anchors(html);
    expect(a).toHaveLength(1);
    expect(a[0]).toContain('href="#section"');
    expect(a[0]).not.toContain("target=");
    expect(a[0]).not.toContain("rel=");
  });

  it("GFM 脚注引用与回链均为 #user-content-fn* 锚点：整段输出无 target", () => {
    const html = render("正文带脚注[^1]。\n\n[^1]: 注释内容。");
    const a = anchors(html);
    // 至少包含脚注引用与脚注回链两条 <a>
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(a.some((tag) => tag.includes('href="#user-content-fn-1"'))).toBe(true);
    expect(a.some((tag) => tag.includes('href="#user-content-fnref-1"'))).toBe(true);
    // 跳转目标（li#user-content-fn-1）就在同一份渲染结果里
    expect(html).toContain('id="user-content-fn-1"');
    // 关键回归断言：脚注相关链接一个都不能被强制开新标签页
    for (const tag of a) {
      expect(tag).not.toContain("target=");
      expect(tag).not.toContain("rel=");
    }
  });

  it("相对/绝对路径仍按外链处理（不以 # 开头 → 保留 target）", () => {
    const html = render("[同站资料](/docs/guide)");
    const a = anchors(html);
    expect(a).toHaveLength(1);
    expect(a[0]).toContain('href="/docs/guide"');
    // 相对/绝对路径会触发整页导航、卸载学习状态，仍按外链新标签页打开
    expect(a[0]).toContain('target="_blank"');
    expect(a[0]).toContain('rel="noopener noreferrer"');
  });
});
