import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server.node";
import { WikiMarkdown } from "@/components/brain/wiki-markdown";

/* ============ WikiMarkdown 畸形百分号编码 href 不崩（回归锁） ============
 * 背景：笔记正文是任意用户数据（Obsidian 整库导入、云端同步、手写 markdown），
 * 一条形如 [x](#wiki-new:%E4) 的链接经 react-markdown v10 的 defaultUrlTransform
 * 原样放行（无协议前缀，safeProtocol 只拦带协议的 URL），旧实现对 #wiki-* 分支
 * 直接 decodeURIComponent：畸形编码（孤立 %E4 尾字节）在**渲染期**抛 URIError，
 * 整个笔记页被打进 error boundary；「重试」重渲染同一笔记必然复崩，用户只能
 * 回总览再手动避开该笔记。
 *
 * 修复：safeDecodeURIComponent 解码失败回退原文本——「原样显示、点不动」
 * 代替「整页崩」。
 *
 * 仓库无 jsdom/@testing-library，沿用 markdown-link-anchor.test.ts 的做法：
 * 用 react-dom/server 静态渲染**真实**组件（不 mock react-markdown），让
 * defaultUrlTransform → a 组件分支的完整真实链路跑一遍。 */

const SRC_RAW = readFileSync(
  join(process.cwd(), "src/components/brain/wiki-markdown.tsx"),
  "utf8"
);

describe("WikiMarkdown 畸形百分号编码 href 回归锁", () => {
  it("根因属实：decodeURIComponent 对畸形编码抛 URIError", () => {
    expect(() => decodeURIComponent("%E4")).toThrow(URIError);
  });

  it("[x](#wiki-new:%E4) 渲染不抛错：href 进 #wiki-new 分支，解码失败回退原文本", () => {
    // 修复前这里在渲染期抛 URIError（decodeURIComponent("%E4")），整页进 error boundary
    const html = renderToStaticMarkup(
      React.createElement(WikiMarkdown, {
        body: "正文 [x](#wiki-new:%E4) 尾",
        notes: [{ id: "k1", title: "A" }],
        onOpen: () => {},
        onCreate: () => {},
      } as never)
    );
    // 确实进入了 #wiki-new: 分支（title 属于该分支独有），没有被 defaultUrlTransform 剥掉
    expect(html).toContain('title="笔记不存在，点击创建"');
    expect(html).toContain("x ⋯");
  });

  it("合法编码路径不受影响：[[新 笔记]] 仍渲染为待建双链", () => {
    const html = renderToStaticMarkup(
      React.createElement(WikiMarkdown, {
        body: "见 [[新 笔记]]。",
        notes: [{ id: "k1", title: "A" }],
        onOpen: () => {},
        onCreate: () => {},
      } as never)
    );
    expect(html).toContain("新 笔记 ⋯");
    expect(html).toContain('title="笔记不存在，点击创建"');
  });

  it("源码护栏：#wiki-* 三个分支全部走 safeDecodeURIComponent，裸 decodeURIComponent 只许出现在 helper 内部", () => {
    expect(SRC_RAW).toContain("function safeDecodeURIComponent");
    // (?<!safe) 负向后行：safeDecodeURIComponent( 的内部调用不算裸调用
    const bare = [...SRC_RAW.matchAll(/(?<!safe)decodeURIComponent\(/g)].length;
    expect(bare).toBe(1);
    // 三个解码点（heading/new/带 id 的锚点）都用了 safe 版本
    expect(SRC_RAW).toContain('safeDecodeURIComponent(href.slice(14))');
    expect(SRC_RAW).toContain('safeDecodeURIComponent(href.slice("#wiki-new:".length))');
    expect(SRC_RAW).toContain("safeDecodeURIComponent(heading)");
  });
});
