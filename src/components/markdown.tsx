"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 正文里的外链一律新标签页打开：
 *  讲义「① 直接可学的资料」点开就是外部课程/文档，若在本页跳转，
 *  正在生成的计划与学习状态会随页面卸载中断，回来像"计划消失"。 */
function MarkdownLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const { node, ...rest } = props;
  void node;
  return <a {...rest} target="_blank" rel="noopener noreferrer" />;
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

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("prose-mentora", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink, pre: MarkdownPre }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
