"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/** 正文里的外链一律新标签页打开：
 *  讲义「① 直接可学的资料」点开就是外部课程/文档，若在本页跳转，
 *  正在生成的计划与学习状态会随页面卸载中断，回来像"计划消失"。 */
function MarkdownLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const { node, ...rest } = props;
  void node;
  return <a {...rest} target="_blank" rel="noopener noreferrer" />;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("prose-mentora", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
