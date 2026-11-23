"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, BookOpen, Search, Trash2 } from "lucide-react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { READING_GOAL_LABELS, type Book, type BookReadStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS: Record<BookReadStatus, { label: string; tone: "default" | "accent" | "warn" | "ok" }> = {
  unread: { label: "未开始", tone: "default" },
  reading: { label: "在读", tone: "accent" },
  finished: { label: "已读完", tone: "warn" },
  assessing: { label: "验收中", tone: "warn" },
  mastered: { label: "已掌握", tone: "ok" },
};

function readStatus(book: Book): BookReadStatus {
  return book.readStatus ?? (book.status === "done" ? "finished" : book.status === "reading" ? "reading" : "unread");
}

function BookProgress({ book }: { book: Book }) {
  const done = book.chapters.filter((chapter) => chapter.status === "done").length;
  const skipped = book.chapters.filter((chapter) => chapter.status === "skipped").length;
  const mastered = book.chapters.filter((chapter) => chapter.masteredAt).length;
  const total = book.chapters.length;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-dim">
        <span>{total ? `已读 ${done} / ${total} 个节点` : "尚未安排阅读节点"}</span>
        <span>{mastered > 0 && `已掌握 ${mastered}`}{mastered > 0 && skipped > 0 && " · "}{skipped > 0 && `跳过 ${skipped}`}</span>
      </div>
      {total > 0 && (
        <div role="progressbar" aria-label={`${book.title}已读节点`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="h-1.5 overflow-hidden rounded-full bg-ink/5">
          <div className="h-full rounded-full bg-accent" style={{ width: `${(done / total) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

export function ReadingShelf({ books, onDelete }: { books: Book[]; onDelete: (book: Book) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | BookReadStatus>("all");
  const needle = query.trim().toLocaleLowerCase();
  const readable = books.filter((book) => book.verification === "verified" || (book.verification === "user_material" && book.pastedText?.trim()));
  const awaitingEvidence = books.filter((book) => !readable.includes(book));
  const filtered = readable.filter((book) =>
    (filter === "all" || readStatus(book) === filter) &&
    (!needle || `${book.title} ${book.author ?? ""} ${book.goal?.intent ?? ""}`.toLocaleLowerCase().includes(needle))
  );
  // 与阅读详情页的默认节点保持一致，不将跳过节点当作已读或掌握。
  const continuing = readable.find((book) => readStatus(book) === "reading" && book.chapters.some((chapter) => chapter.status === "todo" || chapter.status === "reading"));
  const next = continuing?.chapters.find((chapter) => chapter.status === "todo" || chapter.status === "reading");
  const filters: { key: "all" | BookReadStatus; label: string }[] = [
    { key: "all", label: "全部" },
    ...Object.entries(STATUS).map(([key, meta]) => ({ key: key as BookReadStatus, label: meta.label })),
  ];
  const linkClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-white transition hover:bg-ink/85 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent";

  return (
    <div className="space-y-8">
      {continuing && next && !needle && filter === "all" && (
        <section aria-labelledby="continue-reading-title" className="rounded-2xl border border-accent/20 bg-accent/[0.04] p-5 sm:p-7">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 max-w-2xl flex-1">
              <p className="mb-3 flex items-center gap-2 text-xs font-medium text-accent"><BookOpen className="size-4" /> 继续你的阅读</p>
              <h2 id="continue-reading-title" title={continuing.title} className="line-clamp-3 break-words text-xl font-semibold tracking-tight text-ink sm:text-2xl [overflow-wrap:anywhere]">{continuing.title}</h2>
              {continuing.author && <p className="mt-1 text-sm text-ink-dim">{continuing.author}</p>}
              {continuing.goal?.intent && <p className="mt-3 break-words text-sm leading-relaxed text-ink-dim">带着这个问题读：{continuing.goal.intent}</p>}
              <div className="mt-4 rounded-xl border border-border bg-surface/80 p-4">
                <p className="text-xs text-ink-dim">接下来读</p>
                <p title={next.title} className="mt-1 line-clamp-2 break-words font-medium text-ink [overflow-wrap:anywhere]">{next.title}</p>
                {next.focusQuestion && <p className="mt-2 break-words text-sm leading-relaxed text-ink-dim">{next.focusQuestion}</p>}
              </div>
            </div>
            <div className="w-full shrink-0 space-y-4 lg:w-56">
              <BookProgress book={continuing} />
              <Link href={`/read/${continuing.id}`} className={cn(linkClass, "w-full")} aria-label={`继续阅读${continuing.title}`}>继续阅读 <ArrowRight className="size-4" /></Link>
            </div>
          </div>
        </section>
      )}

      <section aria-labelledby="reading-shelf-title" className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="reading-shelf-title" className="text-lg font-semibold text-ink">我的书架 <span className="ml-1 text-sm font-normal text-ink-dim">{readable.length} 本</span></h2>
            <p className="mt-1 text-sm text-ink-dim">找到一本书，继续阅读、讨论或回顾。</p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3.5 top-3.5 size-4 text-ink-dim" />
            <Input type="search" aria-label="搜索书名、作者或阅读问题" placeholder="搜索书名、作者或阅读问题" value={query} onChange={(event) => setQuery(event.target.value)} className="h-11 pl-10" />
          </div>
        </div>
        <div role="group" aria-label="按阅读状态筛选" className="flex flex-wrap gap-2">
          {filters.map(({ key, label }) => (
            <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={cn("min-h-11 cursor-pointer rounded-xl border px-3 text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent", filter === key ? "border-ink bg-ink text-white" : "border-border bg-surface text-ink-dim hover:border-accent/40 hover:text-ink")}>
              {label}<span className="ml-1.5 opacity-70">{key === "all" ? readable.length : readable.filter((book) => readStatus(book) === key).length}</span>
            </button>
          ))}
        </div>
        <p role="status" className="text-xs text-ink-dim">显示 {filtered.length} 本书</p>
        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border px-5 py-12 text-center">
            <Search className="mx-auto mb-3 size-6 text-ink-dim" aria-hidden="true" />
            <h3 className="font-medium text-ink">没有找到符合条件的书</h3>
            <p className="mt-2 text-sm text-ink-dim">换个关键词，或查看全部阅读状态。</p>
          <Button variant="outline" className="mt-5 min-h-11" onClick={() => { setQuery(""); setFilter("all"); }}>清除筛选</Button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((book) => {
              const meta = STATUS[readStatus(book)];
              return (
                <Card key={book.id} className="flex min-w-0 flex-col transition hover:border-accent/40">
                  <div className="mb-4 flex items-center justify-between gap-2">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    <button type="button" onClick={() => onDelete(book)} aria-label={`删除《${book.title}》`} className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-ink-dim transition hover:bg-bad/10 hover:text-bad focus-visible:outline-2 focus-visible:outline-accent"><Trash2 className="size-4" /></button>
                  </div>
                  <Link href={`/read/${book.id}`} className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
                    <h3 className="break-words text-lg font-semibold leading-snug text-ink hover:text-accent">{book.title}</h3>
                    {book.author && <p className="mt-1 text-sm text-ink-dim">{book.author}</p>}
                  </Link>
                  {book.verification === "user_material" && <p className="mt-2 text-xs text-warn">基于你的材料 · 未经搜索核实</p>}
                  {book.goal && <p className="mt-4 text-xs font-medium text-accent">{READING_GOAL_LABELS[book.goal.primary].label}{book.goal.secondary?.map((goal) => ` · ${READING_GOAL_LABELS[goal].label}`).join("")}</p>}
                  <p className="mt-2 mb-5 line-clamp-3 break-words text-sm leading-relaxed text-ink-dim">{book.goal?.intent || book.planSummary || "打开阅读工作区，从一个问题开始读这本书。"}</p>
                  <div className="mt-auto space-y-4">
                    <BookProgress book={book} />
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-ink-dim">
                      <span>{book.insights.length} 条洞见 · {book.chat.length} 条消息</span>
                      <Link href={`/read/${book.id}`} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-ink hover:text-accent focus-visible:outline-2 focus-visible:outline-accent" aria-label={`打开${book.title}的阅读工作区`}>打开阅读 <ArrowRight className="size-3.5" /></Link>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>
      {awaitingEvidence.length > 0 && (
        <details className="rounded-xl border border-border px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-ink">待核实的旧条目 · {awaitingEvidence.length}</summary>
          <ul className="mt-2 divide-y divide-border">
            {awaitingEvidence.map((book) => (
              <li key={book.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="break-words text-ink-dim">{book.title}</span>
                <div className="flex items-center gap-3">
                  <Link href={"/read/" + book.id} className="text-accent hover:underline">核实来源</Link>
                  <button type="button" onClick={() => onDelete(book)} className="text-bad hover:underline" aria-label={"移除《" + book.title + "》"}>移除</button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
