"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, Empty, Input, Modal, PageHeader, Textarea } from "@/components/ui";
import { useAppStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { extractJson, readingPlanSchema } from "@/lib/ai/client";
import { uid } from "@/lib/utils";
import { toast } from "sonner";
import { BookOpen, Plus, Trash2 } from "lucide-react";

export default function ReadPage() {
  const hydrated = useHydrated();
  const router = useRouter();
  const books = useAppStore((s) => s.books);
  const addBook = useAppStore((s) => s.addBook);
  const removeBook = useAppStore((s) => s.removeBook);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [pasted, setPasted] = useState("");
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (!title.trim()) {
      toast.error("先写个书名");
      return;
    }
    setCreating(true);
    const id = uid("book");
    const desc = `书名：《${title.trim()}》${author.trim() ? ` 作者：${author.trim()}` : ""}${
      pasted.trim() ? `\n用户粘贴的内容/笔记：\n${pasted.trim().slice(0, 6000)}` : ""
    }`;
    try {
      const { streamChat } = await import("@/lib/ai/client");
      let plan: ReturnType<typeof readingPlanSchema.parse> | null = null;
      const full = await streamChat({
        args: { desc },
        messages: [{ role: "user", content: "生成阅读计划。" }],
        temperature: 0.5,
        task: "reading-plan",
        onDelta: () => {},
      });
      plan = readingPlanSchema.parse(extractJson(full));
      addBook({
        id,
        title: title.trim(),
        author: author.trim() || undefined,
        pastedText: pasted.trim() || undefined,
        status: "reading",
        profile: plan.bookProfile || undefined,
        planSummary: plan.planSummary,
        chapters: plan.chapters.map((c) => ({
          ...c,
          coreIdea: c.coreIdea || undefined,
          perspectives: c.perspectives || undefined,
          capture: c.capture || undefined,
          id: uid("ch"),
          status: "todo" as const,
        })),
        insights: [],
        chat: [],
        createdAt: new Date().toISOString(),
      });
      setOpen(false);
      setTitle("");
      setAuthor("");
      setPasted("");
      toast.success("阅读计划已生成，开读！");
      router.push(`/read/${id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "生成阅读计划失败");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <PageHeader
        icon={<BookOpen className="size-5" />}
        title="读书伙伴"
        desc="带着问题读，读完聊。聊出来的想法自动进你的知识库。"
        right={
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" /> 添加书籍
          </Button>
        }
      />

      {!hydrated ? (
        <div className="h-40 animate-pulse rounded-2xl bg-surface/60" />
      ) : books.length === 0 ? (
        <Empty
          icon={<BookOpen className="size-7" />}
          title="从一本书开始"
          desc="说书名就行，怎么读教练来安排。"
          action={
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" /> 添加第一本书
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {books.map((b) => {
            const doneCh = b.chapters.filter((c) => c.status === "done").length;
            return (
              <Card
                key={b.id}
                className="group card-lift cursor-pointer transition hover:border-accent/50 hover:bg-surface-2/70"
                onClick={() => router.push(`/read/${b.id}`)}
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <h3 className="truncate font-bold text-ink">《{b.title}》</h3>
                    {b.author && <p className="mt-0.5 text-xs text-ink-dim">{b.author}</p>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeBook(b.id);
                      }}
                      className="rounded-lg p-1.5 text-ink-dim/60 transition hover:bg-bad/10 hover:text-bad cursor-pointer"
                      aria-label="删除这本书"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                    <Badge tone={b.status === "done" ? "ok" : "accent"}>
                      {b.status === "done" ? "读完" : b.status === "reading" ? "在读" : "想读"}
                    </Badge>
                  </div>
                </div>
                {b.planSummary && (
                  <p className="mt-2 line-clamp-2 text-xs text-ink-dim">{b.planSummary}</p>
                )}
                <div className="mt-3 flex items-center gap-3 text-xs text-ink-dim">
                  <span>
                    章节 {doneCh}/{b.chapters.length}
                  </span>
                  <span>洞见 {b.insights.length} 条</span>
                  {b.chat.length > 0 && <span>对话 {b.chat.length} 轮</span>}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="添加书籍">
        <div className="space-y-3">
          <Input placeholder="书名（必填）" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input placeholder="作者（可选）" value={author} onChange={(e) => setAuthor(e.target.value)} />
          <Textarea
            rows={5}
            placeholder="粘贴原文片段 / 你的笔记 / 目录（可选）——有的话阅读计划会围绕它安排"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <div className="flex justify-end">
            <Button onClick={create} loading={creating}>
              生成阅读计划
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
