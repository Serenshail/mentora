"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Input, PageHeader, StatusDot } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { useAppStore } from "@/lib/store";
import { useChat, useHydrated } from "@/lib/use-chat";
import { extractJson, insightsSchema } from "@/lib/ai/client";
import { heuristicVerify } from "@/lib/verify-heuristic";
import { READING_MODES, defaultReadingMode, type ReadingMode } from "@/lib/ai/reading-modes";
import { ragContext, wikiRetrieve } from "@/lib/rag";
import { retrieveEnhanced } from "@/lib/rag-pipeline";
import { cn, uid } from "@/lib/utils";
import { toast } from "sonner";
import { ArrowLeft, Check, ChevronDown, Lightbulb, MessagesSquare, PanelLeftClose, PanelLeftOpen, ShieldCheck } from "lucide-react";

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
  /* 三重验收（迁移自 CogniRead）：当前验收的单元 + 三题作答 + 评分中 */
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<string[]>(["", "", ""]);
  const [grading, setGrading] = useState(false);
  /* 阅读路线（PRD §5.6）：手机默认收起（当前章节+对话才是主任务），桌面默认展开；
   * 初始值在首帧读取视口，SSG 期间 window 不存在时按桌面处理，客户端水合后一致。 */
  const [planOpen, setPlanOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 1024
  );
  /* 模式选择菜单（输入框左侧）开关 */
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
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
  /* 五模式：book 级锁定;未锁定按章节知识类型推荐 */
  const activeMode: ReadingMode = (book.chatMode as ReadingMode) || defaultReadingMode(chapter?.knowledgeType);
  const activeModeMeta = READING_MODES.find((m) => m.id === activeMode) ?? READING_MODES[0];

  const bookCtx = () =>
    JSON.stringify(
      {
        title: book.title,
        author: book.author,
        planSummary: book.planSummary,
        currentChapter: chapter ? {
          title: chapter.title,
          focusQuestion: chapter.focusQuestion,
          knowledgeType: chapter.knowledgeType || "concept",
          coreIdea: chapter.coreIdea,
        } : null,
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
    void (async () => {
      /* RAG 增强（2026-10-26）：基线图导航 → CRAG 自评 → 查询改写+多查询融合 → LLM 精排。
       * 任何一步失败都回退到原行为（wikiRetrieve top-3），对话不受影响。 */
      const notes = useAppStore
        .getState()
        .knowledge.filter((k) => !(k.tags ?? []).includes("MOC")) // 目录索引笔记不作种子,但可作为 hub 被导航到
        .map((k) => ({
          id: k.id, title: k.title, body: k.body, domain: k.domain,
          links: k.links, version: k.version, updatedAt: k.updatedAt, tags: k.tags,
        }));
      let ragCtx = "";
      try {
        const enhanced = await retrieveEnhanced(
          text,
          notes,
          3,
          { context: `${chapter?.focusQuestion ?? ""} ${chapter?.coreIdea ?? ""}`.trim() }
        );
        ragCtx = enhanced.context;
      } catch {
        // 兜底：增强链路整体失败 → 原行为（纯 wikiRetrieve）
        ragCtx = ragContext(
          wikiRetrieve(
            `${text} ${chapter?.focusQuestion ?? ""} ${chapter?.coreIdea ?? ""}`,
            notes,
            3
          )
        );
      }
      void send({
        args: { bookCtx: bookCtx(), ragCtx, mode: activeMode, modeSwitch: book.modeJustSwitched === true },
        userText: text,
        task: "reading-chat",
        onDone: (full) => {
          addBookMsg(book.id, { id: uid("m"), role: "user", content: text, at: new Date().toISOString() });
          addBookMsg(book.id, { id: uid("m"), role: "assistant", content: full, at: new Date().toISOString() });
          if (book.modeJustSwitched) updateBook(book.id, { modeJustSwitched: false }); // 开场协议只触发一次
        },
      });
    })();
  };

  /* ---- 三重验收（迁移自用户 CogniRead 项目：举例 30% + 迁移 30% + 贴合 40%） ---- */
  const openVerify = (chapterId: string) => {
    setVerifyingId(chapterId);
    setAnswers(["", "", ""]);
  };

  const submitVerify = async (chapter: (typeof book.chapters)[number]) => {
    if (answers.some((a) => !a.trim())) {
      toast.error("三题都要写，验收才算数。");
      return;
    }
    setGrading(true);
    try {
      const qs = [
        { q: "用自己的话复述本章核心论点", a: answers[0] },
        { q: "举一个你生活或工作里的真实例子", a: answers[1] },
        { q: "这个观点能用到你哪件正在做的事上", a: answers[2] },
      ];
      let raw: { example?: number; transfer?: number; similarity?: number; level?: string; suggestion?: string };
      try {
        const { streamChat } = await import("@/lib/ai/client");
        const full = await streamChat({
          task: "verify-score",
          args: {
            chapter: chapter.title,
            coreIdea: chapter.coreIdea ?? "",
            focusQuestion: chapter.focusQuestion,
            book: book.title,
            answers: qs,
          },
          messages: [{ role: "user", content: "评分。" }],
          temperature: 0.2,
          onDelta: () => {},
        });
        raw = extractJson(full);
      } catch {
        raw = heuristicVerify({
          answers,
          coreIdea: chapter.coreIdea ?? "",
          focusQuestion: chapter.focusQuestion,
        });
        toast("演示模式：用启发式规则评分");
      }
      const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
      const scores = {
        example: clamp(raw.example),
        transfer: clamp(raw.transfer),
        similarity: clamp(raw.similarity),
      };
      const total = Math.round(scores.example * 0.3 + scores.transfer * 0.3 + scores.similarity * 0.4);
      const level = raw.level === "understood" ? "understood" : raw.level === "not" ? "not" : "partial";
      const verification = {
        scores,
        total,
        level: level as "understood" | "partial" | "not",
        suggestion: String(raw.suggestion || "继续推进。"),
        at: new Date().toISOString(),
      };
      updateBook(book.id, {
        chapters: book.chapters.map((ch) =>
          ch.id === chapter.id
            ? { ...ch, verification, status: total >= 60 ? "done" : ch.status }
            : ch
        ),
      });
      if (total >= 60) toast.success(`验收通过（${total} 分），单元已完成。`);
      else toast(`本次 ${total} 分——${verification.suggestion}`);
      setVerifyingId(null);
      setAnswers(["", "", ""]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "验收失败");
    } finally {
      setGrading(false);
    }
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
        task: "insight",
        args: { text: chatText.slice(0, 8000) },
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
            <Lightbulb className="size-4" /> 提炼洞见
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
              <p className="text-[11px] font-semibold uppercase tracking-wider text-accent/80">{label}</p>
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

      <div className={cn("grid gap-6", planOpen && "lg:grid-cols-[300px_1fr]")}>
        {/* 章节计划（可收起） */}
        {planOpen && (
        <Card className="h-fit lg:sticky lg:top-8">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-dim">
              阅读路线 · 点击单元展开导读
            </p>
            <button
              onClick={() => setPlanOpen(false)}
              title="收起阅读路线"
              aria-label="收起阅读路线"
              className="tap-target grid place-items-center rounded-md text-ink-dim/60 transition hover:text-ink cursor-pointer"
            >
              <PanelLeftClose className="size-4" />
            </button>
          </div>
          {/* 目录独立滚动：长书（几十个单元+展开导读）不再把整页拖长——路线列自己滚，右侧正文不动 */}
          <div className="relative ml-2 max-h-[calc(100dvh-220px)] space-y-1 overflow-y-auto border-l border-border pl-5 lg:pr-1">
            {book.chapters.map((c, i) => {
              const expanded = expandedId === c.id || chapter?.id === c.id;
              return (
                <div key={c.id} className="relative">
                  <span
                    className={cn(
                      "absolute -left-[27px] top-3 flex size-3.5 items-center justify-center rounded-full border text-[8px] font-bold",
                      c.status === "done"
                        ? "border-ok/40 bg-ok/[0.12] text-ok"
                        : chapter?.id === c.id
                          ? "border-accent/50 bg-accent text-white"
                          : "border-border bg-white text-ink-dim"
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
                      chapter?.id === c.id ? "bg-accent/[0.07]" : "hover:bg-black/[0.035]"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn("text-[13px] font-semibold", chapter?.id === c.id ? "text-accent" : "text-ink")}>
                        {c.title}
                      </span>
                      {c.status === "done" && <Check className="ml-auto size-3.5 shrink-0 text-ok" />}
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-[11.5px] text-ink-dim">{c.focusQuestion}</p>
                  </button>
                  {expanded && (
                    <div className="mb-2 space-y-2 rounded-xl border border-border bg-surface-2 p-3">
                      {c.coreIdea && (
                        <p className="text-[11.5px] leading-relaxed text-ink-dim">
                          <b className="text-ink">核心论点：</b>{c.coreIdea}
                        </p>
                      )}
                      {c.perspectives && c.perspectives.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-accent/80">交叉视角</p>
                          {c.perspectives.map((pv, j) => (
                            <p key={j} className="text-[11.5px] leading-relaxed text-ink-dim">⟡ {pv}</p>
                          ))}
                        </div>
                      )}
                      {c.capture && c.capture.length > 0 && (
                        <p className="text-[11px] leading-relaxed text-ink-dim/80">
                          值得记：{c.capture.join(" / ")}
                        </p>
                      )}

                      {/* 三重验收（举例 30% + 迁移 30% + 贴合 40%，通过 ≥60 分自动完成单元） */}
                      {verifyingId === c.id ? (
                        <div className="space-y-2 rounded-lg border border-accent/25 bg-white p-2.5">
                          <p className="flex items-center gap-1 text-[11px] font-semibold text-accent">
                            <ShieldCheck className="size-3.5" /> 三重验收 · 三题都要答
                          </p>
                          {[
                            "① 用自己的话复述本章核心论点",
                            "② 举一个你生活或工作里的真实例子",
                            "③ 这个观点能用到你哪件正在做的事上",
                          ].map((q, i) => (
                            <div key={i}>
                              <p className="text-[11px] text-ink">{q}</p>
                              <textarea
                                rows={2}
                                className="mt-1 w-full rounded-lg border border-border bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-accent/50"
                                value={answers[i]}
                                onChange={(e) =>
                                  setAnswers((p) => p.map((v, j) => (j === i ? e.target.value : v)))
                                }
                                placeholder="写你自己的话…"
                              />
                            </div>
                          ))}
                          <div className="flex justify-end gap-1.5">
                            <Button variant="outline" size="sm" onClick={() => setVerifyingId(null)} disabled={grading}>
                              取消
                            </Button>
                            <Button size="sm" onClick={() => void submitVerify(c)} loading={grading}>
                              提交验收
                            </Button>
                          </div>
                        </div>
                      ) : c.verification ? (
                        <div
                          className={cn(
                            "space-y-1.5 rounded-lg border p-2.5",
                            c.verification.level === "understood"
                              ? "border-ok/30 bg-ok/[0.05]"
                              : c.verification.level === "partial"
                                ? "border-warn/30 bg-warn/[0.05]"
                                : "border-bad/25 bg-bad/[0.04]"
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <ShieldCheck className="size-3.5 text-accent" />
                            <p className="text-[11.5px] font-semibold text-ink">
                              验收 {c.verification.total} 分
                            </p>
                            <Badge
                              tone={
                                c.verification.level === "understood"
                                  ? "ok"
                                  : c.verification.level === "partial"
                                    ? "warn"
                                    : "bad"
                              }
                            >
                              {c.verification.level === "understood"
                                ? "真懂了"
                                : c.verification.level === "partial"
                                  ? "半懂"
                                  : "没懂"}
                            </Badge>
                          </div>
                          <div className="grid grid-cols-3 gap-1.5 text-[10.5px] text-ink-dim">
                            {([
                              ["举例", c.verification.scores.example],
                              ["迁移", c.verification.scores.transfer],
                              ["贴合", c.verification.scores.similarity],
                            ] as [string, number][]).map(([label, v]) => (
                              <div key={label}>
                                <div className="flex justify-between">
                                  <span>{label}</span>
                                  <span className="tabular">{v}</span>
                                </div>
                                <div className="mt-0.5 h-1 rounded-full bg-black/[0.08]">
                                  <div
                                    className="h-full rounded-full bg-accent/70"
                                    style={{ width: `${Math.max(3, v)}%` }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                          <p className="text-[11px] leading-relaxed text-ink-dim">{c.verification.suggestion}</p>
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full"
                            onClick={() => openVerify(c.id)}
                          >
                            重新验收
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={() => openVerify(c.id)}
                        >
                          <ShieldCheck className="size-3.5" /> 三重验收（通过即完成）
                        </Button>
                      )}

                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => toggleChapter(book.id, c.id)}
                      >
                        {c.status === "done" ? "标记为未读" : "直接标记已读完（不验收）"}
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
                洞见（已入第二大脑）
              </p>
              <div className="space-y-2">
                {book.insights.map((i) => (
                  <p key={i.id} className="rounded-lg bg-surface-2 p-2.5 text-xs leading-relaxed text-ink-dim">
                    {i.text}
                  </p>
                ))}
              </div>
            </div>
          )}
        </Card>
        )}

        {/* 折叠时的展开入口：桌面=左缘竖排把手；手机=对话区上方的横条按钮（M6-4） */}
        {!planOpen && (
          <>
            <button
              onClick={() => setPlanOpen(true)}
              title="展开阅读路线"
              className="fixed left-4 top-1/2 z-20 hidden -translate-y-1/2 flex-col items-center gap-1 rounded-r-xl border border-l-0 border-border bg-white px-1.5 py-4 text-[10px] text-ink-dim shadow-sm transition hover:text-ink cursor-pointer lg:flex"
            >
              <PanelLeftOpen className="size-4" />
              <span className="[writing-mode:vertical-lr] tracking-widest">阅读路线</span>
            </button>
            <button
              onClick={() => setPlanOpen(true)}
              className="mb-4 flex min-h-[44px] w-full cursor-pointer items-center gap-2 rounded-xl border border-border bg-white px-3.5 py-2.5 text-left text-[13px] text-ink transition hover:bg-black/[0.02] lg:hidden"
            >
              <PanelLeftOpen className="size-4 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate font-medium">阅读路线 · {book.chapters.length} 个单元</span>
              <span className="shrink-0 text-xs text-ink-dim">
                {book.chapters.filter((c) => c.status === "done").length} 已读
              </span>
            </button>
          </>
        )}

        {/* 对话区 */}
        <div className="min-w-0">
          {chapter && (
            <Card className="mb-4 border-accent/25">
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
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[#1d1d1f] px-4 py-2.5 text-sm text-white">
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
              <Card aria-live="polite" className="max-w-[92%] rounded-2xl rounded-bl-md py-4">
                <Markdown text={pending} />
                <span className="stream-cursor" />
              </Card>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="above-mobile-nav sticky mt-4">
            {/* 模式选择器：输入框左侧，点开弹出五模式菜单。切换即时生效（下一句按新模式流程走） */}
            <div className="relative mb-2">
              <button
                onClick={() => setModeMenuOpen((v) => !v)}
                className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1.5 text-[11.5px] text-ink-dim transition hover:border-accent/50 hover:text-accent"
                aria-expanded={modeMenuOpen}
              >
                <MessagesSquare className="size-3.5" />
                <span className="font-semibold">{activeModeMeta.label}</span>
                <span className="max-w-[320px] truncate text-ink-dim/60">{activeModeMeta.hint}</span>
                <ChevronDown className={cn("size-3.5 transition", modeMenuOpen && "rotate-180")} />
              </button>
              {modeMenuOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setModeMenuOpen(false)} />
                  <div className="absolute bottom-full left-0 z-40 mb-2 w-[340px] overflow-hidden rounded-2xl border border-border bg-white shadow-overlay">
                    <p className="border-b border-border/60 px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-dim/70">
                      对话模式 · 切换后下一句生效
                    </p>
                    {READING_MODES.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => {
                          const switching = book.chatMode !== m.id;
                          updateBook(book.id, { chatMode: book.chatMode === m.id ? undefined : m.id, modeJustSwitched: switching });
                          setModeMenuOpen(false);
                          toast(switching ? `已切换「${m.label}」——下一句生效` : "已恢复自动模式");
                        }}
                        className={cn(
                          "flex w-full cursor-pointer flex-col gap-0.5 px-4 py-2.5 text-left transition hover:bg-black/[0.035]",
                          activeMode === m.id && "bg-accent/[0.06]"
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <span className={cn("text-[13px] font-semibold", activeMode === m.id ? "text-accent" : "text-ink")}>
                            {m.label}
                          </span>
                          <span className="text-[10px] text-ink-dim/50">适合：{m.forType}</span>
                          {activeMode === m.id && <Check className="ml-auto size-3.5 shrink-0 text-accent" />}
                        </span>
                        <span className="text-[11px] leading-relaxed text-ink-dim">{m.hint}</span>
                      </button>
                    ))}
                    <div className="border-t border-border/60 px-4 py-2 text-[10.5px] leading-relaxed text-ink-dim/60">
                      未手动选择时，按每章的知识类型自动匹配。
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSend()}
                placeholder="说说你的理解、困惑，或反驳…"
                disabled={streaming}
              />
              <Button onClick={doSend} loading={streaming} className="h-11 shrink-0 sm:h-10">
                发送
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
