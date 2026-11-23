"use client";

import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { KnowledgeItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { buildWikiIndex, mapWikiLinks, parseWikiTarget, wikiHeadingId } from "@/lib/wiki-links";
import type { ReactNode } from "react";

function headingText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(headingText).join("");
  if (value && typeof value === "object" && "props" in value) return headingText((value.props as { children?: ReactNode }).children);
  return "";
}

/** 解码 #wiki-* href 里的标题/锚点。正文是任意用户数据（Obsidian 整库导入、云端同步、
 * 手写 markdown），[x](#wiki-new:%E4) 这类畸形百分号编码经 react-markdown 原样放行
 * （safeProtocol 只拦带协议的 URL），直接 decodeURIComponent 会在渲染期抛 URIError
 * 把整个笔记页打崩（error boundary「重试」重渲染同一笔记必然复崩）。解码失败回退
 * 原文（残余 % 编码显示为字面量），让「点不动/显示原样」代替「整页崩」。 */
function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 把 [[标题]] 渲染成可点击的双链；未解析的显示为虚线待建笔记（可点击创建）。
 * 全库标题索引按 notes 引用缓存 + 整体 memo：Obsidian 整库导入后 notes 数以千计，
 * LiveBlocks 里每次键击都会重渲染每个非激活块，若不缓存则每块都要重建 Map、
 * 重跑 [[..]] 正则并让 ReactMarkdown 重解析。store 的写入路径（updateKnowledge 等）
 * 都换新的 knowledge 数组，引用变化即可让缓存失效。 */
export const WikiMarkdown = memo(function WikiMarkdown({
  body,
  notes,
  onOpen,
  onCreate,
  className,
}: {
  body: string;
  notes: KnowledgeItem[];
  onOpen: (id: string, heading?: string) => void;
  onCreate?: (title: string) => void;
  className?: string;
}) {
  const byTitle = useMemo(
    () => buildWikiIndex(notes),
    [notes]
  );

  // [[...]] → markdown 链接（已存在）或占位链接（未创建）。
  // 未解析双链也走内联 markdown 链接：此前按占位符 split 后逐段独立渲染，
  // 句中一个 [[X]] 会把段落撕成多块、按钮独占一行，与已解析双链排版不一致。
  const processed = useMemo(
    () => mapWikiLinks(body, (raw) => {
      const { title, label, heading } = parseWikiTarget(raw);
      if (!title && heading) return `[${label}](#wiki-heading:${encodeURIComponent(heading)})`;
      const target = byTitle.get(title.toLowerCase());
      if (byTitle.has(title.toLowerCase()) && !target) return `[${label}](#wiki-ambiguous)`;
      if (target) return `[${label}](#wiki-${target.id}${heading ? `:${encodeURIComponent(heading)}` : ""})`;
      return `[${label}](<#wiki-new:${encodeURIComponent(title)}>)`;
    }),
    [body, byTitle]
  );

  return (
    <div className={cn("prose-mentora note-document", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 id={wikiHeadingId(headingText(children))}>{children}</h1>,
          h2: ({ children }) => <h2 id={wikiHeadingId(headingText(children))}>{children}</h2>,
          h3: ({ children }) => <h3 id={wikiHeadingId(headingText(children))}>{children}</h3>,
          h4: ({ children }) => <h4 id={wikiHeadingId(headingText(children))}>{children}</h4>,
          h5: ({ children }) => <h5 id={wikiHeadingId(headingText(children))}>{children}</h5>,
          h6: ({ children }) => <h6 id={wikiHeadingId(headingText(children))}>{children}</h6>,
          table: ({ children }) => <div className="prose-table-scroll"><table>{children}</table></div>,
          a: ({ href, children }) => {
            if (href === "#wiki-ambiguous") return <span className="note-wikilink-missing" title="存在同名笔记，请从列表选择">{children}</span>;
            if (href?.startsWith("#wiki-heading:")) return <button className="note-wikilink" onClick={() => onOpen("", safeDecodeURIComponent(href.slice(14)))}>{children}</button>;
            if (href?.startsWith("#wiki-new:")) {
              const title = safeDecodeURIComponent(href.slice("#wiki-new:".length));
              return (
                <button
                  onClick={() => onCreate?.(title)}
                  className={cn(
                    "note-wikilink note-wikilink-missing",
                    onCreate && "cursor-pointer hover:bg-accent/[0.12]"
                  )}
                  title={onCreate ? "笔记不存在，点击创建" : "该笔记还不存在"}
                >
                  {children} ⋯
                </button>
              );
            }
            if (href?.startsWith("#wiki-")) {
              const [id, heading] = href.slice(6).split(":");
              return (
                <button
                  onClick={() => onOpen(id, heading ? safeDecodeURIComponent(heading) : undefined)}
                  title={notes.find(n => n.id === id)?.title}
                  className="note-wikilink"
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
});
