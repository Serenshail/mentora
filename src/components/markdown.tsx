"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 正文里的外链一律新标签页打开：
 *  讲义「① 直接可学的资料」点开就是外部课程/文档，若在本页跳转，
 *  正在生成的计划与学习状态会随页面卸载中断，回来像"计划消失"。
 *  但页内锚点（# 开头）必须在当前文档内跳转：remarkGfm 无条件启用，
 *  GFM 脚注引用会被渲染成 <a href="#user-content-fn-1">，[跳转](#锚点)
 *  也是 hash 链接。给它们加 target="_blank" 会新开一个重复页面，反而打断
 *  学习视图且无法在本页定位——正是上面注释想避免的体验。 */
function MarkdownLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const { node, href, ...rest } = props;
  void node;
  // 仅以 # 开头的纯页内锚点走本页跳转；相对/绝对路径的外链一律新标签页。
  // 相对路径即便指向本站也会触发整页导航，仍按外链处理，避免计划/对话状态被卸载。
  const inPage = typeof href === "string" && href.startsWith("#");
  if (inPage) return <a href={href} {...rest} />;
  return <a href={href} {...rest} target="_blank" rel="noopener noreferrer" />;
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) {
    return textOf((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

/** 空代码块（``` 紧跟 ```）在深色主题下就是一条黑条：
 *  上游已尽量清理，这里再做一层渲染兜底——内容为空就不渲染 <pre>。 */
function MarkdownPre(props: React.HTMLAttributes<HTMLPreElement> & { node?: unknown }) {
  const { node, children, ...rest } = props;
  void node;
  if (!textOf(children).trim()) return null;
  return <pre {...rest}>{children}</pre>;
}

/** 宽表在窄屏局部滚动：包一层 overflow-x:auto 容器，避免页面级横向溢出。
 *  只改表现层，表格结构与内容不动。 */
function MarkdownTable(props: React.TableHTMLAttributes<HTMLTableElement> & { node?: unknown }) {
  const { node, ...rest } = props;
  void node;
  return (
    <div className="prose-table-scroll">
      <table {...rest} />
    </div>
  );
}

/* react-markdown v10 的同步组件没有任何内部缓存：每次渲染都新建 processor 并
 * 同步 parse + runSync 全文。这里把它们提到模块作用域，保证同一份配置对象/数组
 * 的引用稳定（组件重渲染时不再每次新建）。 */
const REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS = { a: MarkdownLink, pre: MarkdownPre, table: MarkdownTable };

/** 整体 memo：对话历史里的每条消息都是一个 Markdown，父组件因输入框 onChange
 *  setInput、流式 tick 等重渲染时，text/className 未变的实例（全部历史消息）
 *  直接短路，不再重跑全文解析；只有正在流式增长的那一条会真正重新解析。 */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("prose-mentora", className)}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
