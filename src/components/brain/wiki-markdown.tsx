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

  // [[...]] → markdown 链接（已存在）或占位（未创建）
  const processed = body.replace(/\[\[([^\[\]]+)\]\]/g, (_m, raw: string) => {
    const title = raw.trim();
    const target = byTitle.get(title.toLowerCase());
    if (target) return `[${title}](#wiki-${target.id})`;
    return `\u2063wikilink-new:${title}\u2063`; // 不可见分隔符占位
  });

  const parts = processed.split(/\u2063(.*?)\u2063/);

  return (
    <div className={cn("prose-mentora", className)}>
      {parts.map((part, i) => {
        if (part.startsWith("wikilink-new:")) {
          const title = part.slice("wikilink-new:".length);
          return (
            <button
              key={i}
              onClick={() => onCreate?.(title)}
              className={cn(
                "mx-0.5 inline-flex items-center rounded-md border border-dashed border-accent/35 bg-accent/[0.05] px-1.5 py-0.5 text-[0.85em] text-accent",
                onCreate && "cursor-pointer hover:bg-accent/[0.12]"
              )}
              title={onCreate ? "笔记不存在，点击创建" : "该笔记还不存在"}
            >
              {title} ⋯
            </button>
          );
        }
        if (!part) return null;
        return (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => {
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
            {part}
          </ReactMarkdown>
        );
      })}
    </div>
  );
}
