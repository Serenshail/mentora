import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server.node";
import { Markdown } from "@/components/markdown";

/* ============ 通用 Markdown 组件 memo 化（回归锁） ============
 * 背景：react-markdown v10 的同步组件没有任何内部缓存
 * （node_modules/react-markdown/lib/index.js:175-179 每次渲染都新建 processor 并
 *  processor.runSync(processor.parse(file)) 全文解析）。对话类页面
 * （learn/[id] 的 qa.map + 流式文本 + 输入框 onChange=setInput、council 圆桌、
 * read/[id] 纪要）在每次键击/流式 tick 都会重渲染父组件，若 Markdown 未 memo，
 * 页面上所有历史消息都会被同步重新解析，长回答 + 弱机型下造成输入卡顿与掉帧。
 *
 * 修复语义：Markdown 整体用 React.memo 包裹，且 remarkPlugins / components
 * 提到模块作用域保持引用稳定；props 只有 text/className 两个字符串，
 * 浅比较即可让未变化的实例短路，只有正在增长的那一条真正重新解析。
 *
 * 仓库无 jsdom/@testing-library：① 运行时断言导出值确实是 memo 包装；
 * ② 用 react-dom/server 静态渲染真实组件确认 memo 后渲染结果不变；
 * ③ 静态扫描源码确认没有退回「组件内每次新建插件数组/组件映射」。 */

const SRC_RAW = readFileSync(join(process.cwd(), "src/components/markdown.tsx"), "utf8");

/** 剥离块/行注释（感知字符串），避免注释里的字样误报。 */
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
        out += src[i];
        if (src[i] === "\\" && i + 1 < n) {
          out += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const MEMO_TYPE = Symbol.for("react.memo");

describe("Markdown 组件 memo 化", () => {
  it("导出值是 React.memo 包装（$$typeof 为 react.memo）", () => {
    expect((Markdown as unknown as { $$typeof: symbol }).$$typeof).toBe(MEMO_TYPE);
  });

  it("remarkPlugins / components 是模块作用域常量，组件内不再新建数组/对象", () => {
    const code = stripComments(SRC_RAW);
    expect(code).toMatch(/const\s+REMARK_PLUGINS\s*=\s*\[/);
    expect(code).toMatch(/const\s+MARKDOWN_COMPONENTS\s*=/);
    // 组件体内联写法回归（每次渲染新建数组/对象会让引用不稳定，纯属浪费）
    expect(code).not.toMatch(/remarkPlugins=\{\[/);
    expect(code).not.toMatch(/components=\{\{/);
    expect(code).toMatch(/remarkPlugins=\{REMARK_PLUGINS\}/);
    expect(code).toMatch(/components=\{MARKDOWN_COMPONENTS\}/);
  });

  it("memo 包装后渲染结果不变：正文 + 外链 target 仍生效", () => {
    const html = renderToStaticMarkup(
      React.createElement(Markdown, { text: "**加粗**与[课程](https://example.com/c)", className: "text-xs" })
    );
    expect(html).toContain("prose-mentora");
    expect(html).toContain("text-xs");
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain('target="_blank"');
  });
});
