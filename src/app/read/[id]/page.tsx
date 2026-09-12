"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Input, PageHeader, StatusDot } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { useAppStore } from "@/lib/store";
import { useChat, useHydrated } from "@/lib/use-chat";
import { INSIGHT_EXTRACT, READING_CHAT } from "@/lib/ai/prompts";
import { extractJson, insightsSchema } from "@/lib/ai/client";
import { cn, uid } from "@/lib/utils";
import { toast } from "sonner";
import { ArrowLeft, Check, Sparkles } from "lucide-react";

export default function BookPage() {
  const hydrated = useHydrated();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const book = useAppStore((s) => s.books.find((b) => b.id === id));
  const updateBook = useAppStore((s) => s.updateBook);
  const addBookMsg = useAppStore((s) => s.addBookMsg);
  const addInsight = useAppStore((s) => s.addInsight);
  const addKnowledge = useAppStore((s) => s.addKnowledge);
  const toggleChapter = useAppStore((s) => s.toggleChapter);

  const { messages, setMessages, pending, streaming, send } = useChat();
  const [input, setInput] = useState("");
  const [currentChapter, setCurrentChapter] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending]);

  // 挂载时恢复该书的历史对话（仅一次）
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !hydrated || !book) return;
    restored.current = true;
    if (book.chat.length > 0) setMessages(book.chat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  if (!hydrated) return <div className="h-40 animate-pulse rounded-2xl bg-surface/60" />;
  if (!book) {
    return (
      <div className="py-20 text-center text-ink-dim">
        书不存在。
        <Button variant="outline" className="ml-3" onClick={() => router.push("/read")}>
          返回书架
        </Button>
      </div>
    );
  }

  const chapter = book.chapters.find((c) => c.id === currentChapter) ?? book.chapters.find((c) => c.status === "todo") ?? null;

  const bookCtx = () =>
    JSON.stringify(
      {
        title: book.title,
        author: book.author,
        planSummary: book.planSummary,
        currentChapter: chapter ? { title: chapter.title, focusQuestion: chapter.focusQuestion } : null,
        pastedExcerpt: book.pastedText?.slice(0, 2000),
        insights: book.insights.map((i) => i.text),
      },
      null,
      1
    );

  const doSend = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    void send({
      system: READING_CHAT(bookCtx()),
      userText: text,
      task: "reading-chat",
      onDone: (full) => {
        addBookMsg(book.id, { id: uid("m"), role: "user", content: text, at: new Date().toISOString() });
        addBookMsg(book.id, { id: uid("m"), role: "assistant", content: full, at: new Date().toISOString() });
      },
    });
  };

  const extract = async () => {
    if (messages.length < 2) {
      toast.error("先和伙伴聊出点东西，再提炼。");
      return;
    }
    setExtracting(true);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const chatText = messages.map((m) => `${m.role === "user" ? "用户" : "伙伴"}：${m.content}`).join("\n\n");
      const full = await streamChat({
        system: INSIGHT_EXTRACT(chatText.slice(0, 8000)),
        messages: [{ role: "user", content: "提炼。" }],
        temperature: 0.3,
        onDelta: () => {},
      });
      const parsed = insightsSchema.parse(extractJson(full));
      parsed.insights.forEach((i) =>
        addInsight(book.id, i.knowledgePoint ? `${i.title} —— ${i.knowledgePoint}` : i.title)
      );
      addKnowledge(
        parsed.insights.map((i) => ({ title: i.title, body: i.body || "", domain: book.title })),
        "read",
        `《${book.title}》`
      );
      toast.success(`提炼出 ${parsed.insights.length} 条笔记，已入第二大脑。`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "提炼失败");
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div>
      <button
        onClick={() => router.push("/read")}
        className="mb-4 flex items-center gap-1.5 text-sm text-ink-dim hover:text-ink cursor-pointer"
      >
        <ArrowLeft className="size-4" /> 书架
      </button>

      <PageHeader
        title={`《${book.title}》`}
        desc={book.author}
        right={
          <Button variant="outline" onClick={extract} loading={extracting}>
            <Sparkles className="size-4" /> 提炼洞见
          </Button>
        }
      />
      {book.profile && (
        <div className="mb-6 grid gap-2.5 sm:grid-cols-2">
          {([
            ["这本书在解决什么", book.profile.positioning],
            ["作者与立场", book.profile.author],
            ["思想谱系", book.profile.lineage],
            ["争议", book.profile.controversies],
          ] as [string, string][]).map(([label, text]) => (
            <Card key={label} className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[#8b83d6]">{label}</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-dim">{text}</p>
            </Card>
          ))}
        </div>
      )}

      {book.planSummary && (
        <Card className="mb-6 border-border bg-surface-2/50 text-sm text-ink-dim">
          <b className="text-ink">拆解路线：</b>{book.planSummary}
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        {/* 章节计划 */}
        <Card className="h-fit lg:sticky lg:top-8">
          <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-ink-dim">
            阅读路线 · 点击单元展开导读
          </p>
          <div className="relative ml-2 space-y-1 border-l border-white/[0.08] pl-5">
            {book.chapters.map((c, i) => {
              const expanded = expandedId === c.id || chapter?.id === c.id;
              return (
                <div key={c.id} className="relative">
                  <span
                    className={cn(
                      "absolute -left-[27px] top-3 flex size-3.5 items-center justify-center rounded-full border text-[8px] font-bold",
                      c.status === "done"
                        ? "border-ok/60 bg-ok/20 text-ok"
                        : chapter?.id === c.id
                          ? "border-accent/70 bg-accent/25 text-white"
                          : "border-white/15 bg-surface-2 text-ink-dim"
                    )}
                  >
                    {i + 1}
                  </span>
                  <button
                    onClick={() => {
                      setCurrentChapter(c.id);
                      setExpandedId(expanded && chapter?.id === c.id ? null : c.id);
                    }}
                    className={cn(
                      "w-full rounded-xl px-3 py-2.5 text-left transition cursor-pointer",
                      chapter?.id === c.id ? "bg-accent/10" : "hover:bg-white/[0.04]"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn("text-[13px] font-semibold", chapter?.id === c.id ? "text-white" : "text-ink")}>
                        {c.title}
                      </span>
                      {c.status === "done" && <Check className="ml-auto size-3.5 shrink-0 text-ok" />}
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-[11.5px] text-ink-dim">❓ {c.focusQuestion}</p>
                  </button>
                  {expanded && (
                    <div className="mb-2 space-y-2 rounded-xl border border-white/[0.06] bg-black/20 p-3">
                      {c.coreIdea && (
                        <p className="text-[11.5px] leading-relaxed text-ink-dim">
                          <b className="text-ink">💡 核心论点：</b>{c.coreIdea}
                        </p>
                      )}
                      {c.perspectives && c.perspectives.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-[#8b83d6]">交叉视角</p>
                          {c.perspectives.map((pv, j) => (
                            <p key={j} className="text-[11.5px] leading-relaxed text-[#8b9dc6]">⟡ {pv}</p>
                          ))}
                        </div>
                      )}
                      {c.capture && c.capture.length > 0 && (
                        <p className="text-[11px] leading-relaxed text-ink-dim/80">
                          📝 值得记：{c.capture.join(" / ")}
                        </p>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => toggleChapter(book.id, c.id)}
                      >
                        {c.status === "done" ? "标记为未读" : "标记此单元已读完"}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {book.insights.length > 0 && (
            <div className="mt-6">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
                💎 洞见（已入第二大脑）
              </p>
              <div className="space-y-2">
                {book.insights.map((i) => (
                  <p key={i.id} className="rounded-lg bg-surface-2/70 p-2.5 text-xs leading-relaxed text-ink-dim">
                    {i.text}
                  </p>
                ))}
              </div>
            </div>
          )}
        </Card>

        {/* 对话区 */}
        <div className="min-w-0">
          {chapter && (
            <Card className="mb-4 border-accent/30">
              <Badge tone="accent">当前章节：{chapter.title}</Badge>
              <p className="mt-2 text-sm text-ink-dim">
                本章带着这个问题读：<b className="text-ink">{chapter.focusQuestion}</b>
              </p>
            </Card>
          )}

          <div className="space-y-4">
            {messages.length === 0 && !pending && (
              <Card className="text-center text-sm text-ink-dim">
                <p>跟读书伙伴打个招呼，或直接说说你读到了哪里、卡在哪。</p>
                <p className="mt-2 text-xs">
                  它不会替你总结全书 —— 它会追问，直到你挖出属于自己的理解。
                </p>
              </Card>
            )}
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                {m.role === "user" ? (
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/20 border border-accent/30 px-4 py-2.5 text-sm">
                    {m.content}
                  </div>
                ) : (
                  <Card className="max-w-[92%] rounded-2xl rounded-bl-md py-4">
                    <Markdown text={m.content} />
                  </Card>
                )}
              </div>
            ))}
            {pending && (
              <Card className="max-w-[92%] rounded-2xl rounded-bl-md py-4">
                <Markdown text={pending} />
                <span className="stream-cursor" />
              </Card>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="sticky bottom-20 mt-4 md:bottom-4">
            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSend()}
                placeholder="说说你的理解、困惑，或反驳…"
                disabled={streaming}
              />
              <Button onClick={doSend} loading={streaming} className="shrink-0">
                发送
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
