import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server.node";

/* ============ WikiMarkdown 大库实时预览重复计算（回归锁） ============
 * 背景：note-workspace.tsx 的 LiveBlocks（Obsidian 式实时预览）给每个非激活块渲染
 * 一个 WikiMarkdown，块内 textarea 每次键击 setText 触发 LiveBlocks 重渲染。
 * 旧实现里 `new Map(notes.map(...))` 既无 useMemo 也无 memo，导致
 * 每键击 × 每个可见块都重建一次全库标题 Map、重跑 [[..]] 正则、
 * 让 ReactMarkdown 重解析整块；整库导入（notes 数以千计）+ 十几块时输入延迟可感知。
 *
 * 修复：组件整体 memo（LiveBlocks 每次 setText 重渲染时，各块的 body/notes/
 * onOpen/onCreate 都是稳定引用，可整体短路），标题索引按 notes 引用 useMemo，
 * [[..]] 替换结果按 [body, byTitle] useMemo。store 的写入路径都换新数组
 * （store.ts 的 set((s) => ({ knowledge: ... }))），引用变化即可让缓存失效。
 *
 * vitest 无 DOM 环境（无 jsdom/@testing-library），沿用本仓库既有做法：
 * ① 用 react-dom/server 静态渲染真实组件（React 19 的 SSR 支持 memo/useMemo），
 *    通过 vi.mock 把 ReactMarkdown 替换成把 children 原样写出的桩，直接断言
 *    [[..]] 替换后的 processed 字符串；② 按语义锚点读源码断言缓存护栏仍在。 */

const SRC_RAW = readFileSync(
  join(process.cwd(), "src/components/brain/wiki-markdown.tsx"),
  "utf8"
);

/** 剥离块/行注释（感知字符串），只用于本测试的静态扫描，避免注释里的字样误报。 */
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

/* 把 ReactMarkdown 换成「把 children 原样包进 <pre>」的桩：绕过 markdown 解析，
 * 让断言直接落在待缓存的 processed 字符串（含 [[..]] → 链接的结果）上。 */
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: React.ReactNode }) =>
    React.createElement("pre", { "data-processed": "1" }, children),
}));
vi.mock("remark-gfm", () => ({ default: () => {} }));

import { WikiMarkdown } from "@/components/brain/wiki-markdown";

describe("WikiMarkdown memo / 全库标题索引缓存", () => {
  it("组件用 memo 包裹，且 byTitle 走 useMemo([notes])", () => {
    const code = stripComments(SRC_RAW);
    expect(code).toMatch(/export\s+const\s+WikiMarkdown\s*=\s*memo\s*\(/);
    expect(code).toMatch(/useMemo\s*\(\s*\(\)\s*=>\s*buildWikiIndex\(notes\)/);
    // byTitle 的 useMemo 依赖数组必须恰好是 [notes]
    const byTitleBlock = code.match(
      /const\s+byTitle\s*=\s*useMemo\([\s\S]*?\)\s*,\s*\[([^\]]*)\]\s*\)/
    );
    expect(byTitleBlock).not.toBeNull();
    expect(byTitleBlock![1].replace(/\s/g, "")).toBe("notes");
  });

  it("processed 走 useMemo([body, byTitle])，依赖数组含 body 与 byTitle", () => {
    const code = stripComments(SRC_RAW);
    const processedBlock = code.match(
      /const\s+processed\s*=\s*useMemo\([\s\S]*?\)\s*,\s*\[([^\]]*)\]\s*\)/
    );
    expect(processedBlock).not.toBeNull();
    const deps = processedBlock![1].replace(/\s/g, "");
    expect(deps).toContain("body");
    expect(deps).toContain("byTitle");
  });

  it("memo 后双链解析不变：已存在→#wiki-<id>，未创建→#wiki-new:<encoded>", () => {
    const notes = [
      { id: "k1", title: "Machine Learning" },
      { id: "k2", title: "深度学习" },
    ];
    const html = renderToStaticMarkup(
      React.createElement(WikiMarkdown, {
        body: "见 [[Machine Learning]] 与 [[深度学习]] 及 [[Not Yet]]。",
        notes,
        onOpen: () => {},
        onCreate: () => {},
      } as never)
    );
    // processed 字符串里三类链接都在；大小写不敏感与 trim 也顺带覆盖
    expect(html).toContain("#wiki-k1");
    expect(html).toContain("#wiki-k2");
    expect(html).toContain(`#wiki-new:${encodeURIComponent("Not Yet")}`);
    expect(html).toContain("[Machine Learning](#wiki-k1)");
    expect(html).toContain("[深度学习](#wiki-k2)");
  });
});
