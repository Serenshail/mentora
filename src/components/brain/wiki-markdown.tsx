"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { KnowledgeItem } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 把 [[标题]] 渲染成可点击的双链；未解析的显示为虚线待建笔记（可点击创建） */
export function WikiMarkdown({
  body,
  notes,
  onOpen,
  onCreate,
  className,
}: {
  body: string;
  notes: KnowledgeItem[];
  onOpen: (id: string) => void;
  onCreate?: (title: string) => void;
  className?: string;
}) {
  const byTitle = new Map(notes.map((n) => [n.title.toLowerCase(), n]));

  // [[...]] → markdown 链接（已存在）或占位链接（未创建）。
  // 未解析双链也走内联 markdown 链接：此前按占位符 split 后逐段独立渲染，
  // 句中一个 [[X]] 会把段落撕成多块、按钮独占一行，与已解析双链排版不一致。
  const processed = body.replace(/\[\[([^\[\]]+)\]\]/g, (_m, raw: string) => {
    const title = raw.trim();
    const target = byTitle.get(title.toLowerCase());
    if (target) return `[${title}](#wiki-${target.id})`;
    return `[${title}](<#wiki-new:${encodeURIComponent(title)}>)`;
  });

  return (
    <div className={cn("prose-mentora", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith("#wiki-new:")) {
              const title = decodeURIComponent(href.slice("#wiki-new:".length));
              return (
                <button
                  onClick={() => onCreate?.(title)}
                  className={cn(
                    "mx-0.5 inline-flex items-center rounded-md border border-dashed border-accent/35 bg-accent/[0.05] px-1.5 py-0.5 text-[0.85em] text-accent",
                    onCreate && "cursor-pointer hover:bg-accent/[0.12]"
                  )}
                  title={onCreate ? "笔记不存在，点击创建" : "该笔记还不存在"}
                >
                  {children} ⋯
                </button>
              );
            }
            if (href?.startsWith("#wiki-")) {
              const id = href.slice(6);
              return (
                <button
                  onClick={() => onOpen(id)}
                  className="mx-0.5 inline-flex items-center rounded-md border border-accent/25 bg-accent/[0.06] px-1.5 py-0.5 text-[0.85em] font-medium text-accent hover:bg-accent/[0.12] cursor-pointer"
                >
                  {children}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" className="text-accent underline">
                {children}
              </a>
            );
          },
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}
