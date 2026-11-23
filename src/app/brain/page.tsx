"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { readPreviousInAppRoute } from "@/components/page-back-bar";
import {
  Badge, Button, Card, Modal, Skeleton, Textarea } from "@/components/ui";
import { GraphView } from "@/components/brain/graph-view";
import { ObsidianImport } from "@/components/brain/obsidian-import";
import { NoteWorkspace } from "@/components/brain/note-workspace";
import { Markdown } from "@/components/markdown";
import { useAppStore, useDueReviews } from "@/lib/store";
import { withResolvedWikiLinks } from "@/lib/wiki-links";
import { useHydrated } from "@/lib/use-chat";
import { extractJson, normalizeReviewGrade, reviewGradeSchema } from "@/lib/ai/client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ArrowLeft, Brain, RefreshCcw } from "lucide-react";

type Tab = "notes" | "graph";

/* URL 直达同步（⌘K 命令面板的跳转契约）：/brain?note=<id> 直接打开该笔记；?tab=graph 进图谱。
 * useSearchParams 在静态预渲染必须有 Suspense 边界（同 login 页先例），故抽成小组件包起来。
 * 依赖 searchParams：已在 /brain 页时 cmdk 再跳 ?note=id 只改 query 不重挂载，
 * 依赖 [] 只跑一次的写法会漏掉同页跳转（2026-10-24 修复） */
function BrainUrlSync({
  setTab,
  setOpenId,
}: {
  setTab: (t: Tab) => void;
  setOpenId: (id: string | null) => void;
}) {
  const searchParams = useSearchParams();
  useEffect(() => {
    // 挪一拍：effect 同步 setState 是级联渲染红线（lint）
    const raf = requestAnimationFrame(() => {
      const note = searchParams.get("note");
      const tabParam = searchParams.get("tab");
      if (note) {
        setTab("notes");
        setOpenId(note);
      } else if (tabParam === "graph") {
        setTab("graph");
      } else {
        setTab("notes");
        setOpenId(null);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [searchParams, setTab, setOpenId]);
  return null;
}

export default function BrainPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const knowledge = useAppStore((s) => s.knowledge);
  const linkedKnowledge = useMemo(()=>withResolvedWikiLinks(knowledge),[knowledge]);

  const due = useDueReviews();
  const [tab, setTab] = useState<Tab>("notes");
  const [openId, setOpenId] = useState<string | null>(null);
  const [wsMode, setWsMode] = useState<"preview" | "edit">("preview");
  const openNoteRoute = useCallback((id: string | null) => {
    setOpenId(id);
    setTab("notes");
    setWsMode("preview");
    const params = new URLSearchParams(window.location.search);
    params.delete("tab");
    if (id) params.set("note",id); else params.delete("note");
    const next = `/brain${params.size ? `?${params}` : ""}`;
    if (next !== window.location.pathname + window.location.search) window.history.pushState(null, "", next);
  }, []);

  /* URL 直达（⌘K 命令面板的跳转契约）：/brain?note=<id> 直接打开该笔记；?tab=graph 进图谱 */
  // 复习会话
  const [reviewQueue, setReviewQueue] = useState<string[]>([]);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [summary, setSummary] = useState<null | { total: number; correct: number; minutes: number; nextDate: string }>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [phase, setPhase] = useState<"ask" | "answer" | "graded">("ask");
  const [verdict, setVerdict] = useState<{ verdict: string; feedback: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /* 出题失败的就地重试态：旧实现出题失败（异常/空回复）要么直接 setReviewQueue([])
   * 关窗丢掉本轮队列与已答进度（与判卷失败「答案不丢、就地重试」的语义相反），
   * 要么对模型空回复静默进入答题态。统一为：失败留在弹窗内给「重试出题」。 */
  const [askFailed, setAskFailed] = useState(false);
  /* 复习会话的代际与中止手柄：关窗重开后旧请求必须停，旧结果也不能再写新会话——
   * 旧实现既无 signal 也无代际：两条流交错写 question，旧判卷完成时还会 recordReview，
   * 把一次没做完的复习记进 FSRS 影响后续间隔。 */
  const reviewGenRef = useRef(0);
  const reviewAbortRef = useRef<AbortController | null>(null);
  /* 卸载兜底（对齐 use-chat.ts 的设计——卸载即 abort，防 token 白烧）：出题/判卷在途时
   * 直接点侧栏导航会卸载本组件，弹窗 onClose 的失效/中止覆盖不到这条路，流会继续
   * 跑到完成才被丢弃。cleanup 里 gen++ + abort 双管齐下：abort 掐断在途连接；gen 失效
   * 拦住「流恰好在卸载瞬间已正常跑完」的竞态——此时 abort 不再抛错，只有代际失效能
   * 挡住随后的 setVerdict/recordReview，避免一次没答完的复习被写进 FSRS。
   * 流自身的 stale 守卫让 abort 抛出的异常静默早退（不弹 toast、不写会话状态）。 */
  useEffect(
    () => () => {
      reviewGenRef.current++;
      reviewAbortRef.current?.abort();
    },
    []
  );


  /* ---- 复习流程 ---- */
  const DAILY_REVIEW_CAP = 20;
  const startReview = async () => {
    if (due.length === 0) return;
    /* 每日上限：一次 20 条以内——复习是Daily习惯，不是义务劳动（防淹没=防流失） */
    const queue = due.slice(0, DAILY_REVIEW_CAP).map((k) => k.id);
    setReviewQueue(queue);
    setSessionTotal(queue.length);
    setCorrectCount(0);
    // eslint-disable-next-line react-hooks/purity -- 事件处理器里取时间戳，非渲染期
    setStartedAt(Date.now());
    setSummary(null);
    setOpenId(null);
    if (due.length > DAILY_REVIEW_CAP) {
      toast(`今天复习 ${DAILY_REVIEW_CAP} 条，剩下的 ${due.length - DAILY_REVIEW_CAP} 条明天来——贪多必忘。`);
    }
    await askNext(queue);
  };

  const askNext = async (queue: string[]) => {
    const store = useAppStore.getState();
    const nextId = queue[0];
    if (!nextId) {
      // eslint-disable-next-line react-hooks/purity -- 事件路径取会话耗时，非渲染期
      const minutes = startedAt ? Math.max(1, Math.round((Date.now() - startedAt) / 60000)) : 1;
      const nextDates = useAppStore
        .getState()
        .knowledge.filter((k) => k.nextReviewAt)
        .map((k) => k.nextReviewAt as string)
        .sort();
      setReviewQueue([]);
      setSummary({
        total: sessionTotal,
        correct: correctCount,
        minutes,
        nextDate: nextDates[0] ?? "",
      });
      return;
    }
    const item = store.knowledge.find((k) => k.id === nextId);
    if (!item) {
      // 笔记已被删除：递归跳到下一条，不能只 slice 不出题（否则弹窗卡在上一题 graded、
      // 队列清空时静默关窗无总结）；手动「下一个」也不会误跳过有效笔记
      const rest = queue.slice(1);
      setReviewQueue(rest);
      return askNext(rest);
    }
    setPhase("ask");
    setQuestion("");
    setAnswer("");
    setVerdict(null);
    setBusy(true);
    setAskFailed(false);
    const gen = ++reviewGenRef.current;
    reviewAbortRef.current?.abort();
    const ctrl = new AbortController();
    reviewAbortRef.current = ctrl;
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const full = await streamChat({
        task: "review-ask",
        args: {
          items: JSON.stringify(
            store.knowledge
              .filter((k) => queue.includes(k.id))
              .map((k) => ({ title: k.title, summary: k.body.slice(0, 120), domain: k.domain }))
          ),
        },
        messages: [{ role: "user", content: "出题。" }],
        signal: ctrl.signal,
        onDelta: (d) => {
          if (gen === reviewGenRef.current) setQuestion((p) => p + d);
        },
      });
      if (gen !== reviewGenRef.current) return;
      /* 模型 200 但正文为空（BYOK 自定义端点的现实场景）：streamChat 按约定返回 ""，
       * use-chat.ts:105-107 明确「必须显式报错」。旧实现无条件 setPhase("answer")，
       * 出现空问题卡，用户还能对着空题提交并把这次复习记进 FSRS。 */
      if (!full.trim()) {
        setAskFailed(true);
        toast.error("模型返回了空回复，请重试");
        return;
      }
      setPhase("answer");
    } catch {
      if (gen !== reviewGenRef.current) return; // 已关窗/换轮：不打扰新会话
      /* 出题失败与判卷失败同语义：就地保留本轮队列与已答进度，给重试入口。
       * 旧实现 setReviewQueue([]) 令 Modal 关窗，correctCount 全部丢弃。 */
      setAskFailed(true);
      toast.error("复习出题失败，稍后再试");
    } finally {
      if (gen === reviewGenRef.current) setBusy(false);
    }
  };

  const submitAnswer = async () => {
    const id = reviewQueue[0];
    const item = useAppStore.getState().knowledge.find((k) => k.id === id);
    if (!item || !answer.trim()) {
      toast.error("写点什么再提交");
      return;
    }
    setBusy(true);
    const gen = reviewGenRef.current; // 同一轮会话：不递增，只在被关窗/换轮后作废
    reviewAbortRef.current?.abort();
    const ctrl = new AbortController();
    reviewAbortRef.current = ctrl;
    try {
      const { streamChat } = await import("@/lib/ai/client");
      /* v17 修错位：出题时模型可能挑队列里任意一条、判卷过去只看 reviewQueue[0] 的标题——
       * 问的和判的对不上。现在把出题原文+笔记摘录+用户回答一起交给复习官。 */
      const full = await streamChat({
        task: "review-grade",
        args: {
          ctx: JSON.stringify({
            note: item.title,
            excerpt: item.body.slice(0, 800),
            question,
            answer,
          }),
        },
        messages: [{ role: "user", content: answer }],
        temperature: 0.2,
        signal: ctrl.signal,
        onDelta: () => {},
      });
      /* v21：复习通过必须有笔记原文依据，否则改判 fail（不给"感觉记住了"放水） */
      const g = normalizeReviewGrade(reviewGradeSchema.parse(extractJson(full)));
      /* 关窗/换了会话：这次判卷作废——不写界面、更不能 recordReview
       * （否则一次没做完的复习被记进 FSRS，后续间隔全被带偏）。 */
      if (gen !== reviewGenRef.current) return;
      setVerdict(g);
      setPhase("graded");
      if (g.verdict === "pass") setCorrectCount((c) => c + 1);
      useAppStore.getState().recordReview(id, g.verdict === "pass");
    } catch {
      if (gen !== reviewGenRef.current) return;
      /* v17 废除"评分异常默认通过"：那是给复习通过率灌水。
       * 答案还在输入框里，重试即可；不记任何分。 */
      toast.error("评分服务暂不可用，你的回答没有丢——稍等再点一次提交");
    } finally {
      if (gen === reviewGenRef.current) setBusy(false);
    }
  };

  const nextInQueue = () => {
    const rest = reviewQueue.slice(1);
    setReviewQueue(rest);
    void askNext(rest);
  };

  /* 出题失败后的就地重试：队列没动过，reviewQueue[0] 仍是这道没出出来的题 */
  const retryAsk = () => {
    setAskFailed(false);
    void askNext(reviewQueue);
  };

  if (!hydrated) return <Skeleton className="h-40 rounded-2xl bg-surface/60" />;

  return (
    <div>
      <Suspense fallback={null}>
        <BrainUrlSync setTab={setTab} setOpenId={setOpenId} />
      </Suspense>
      {/* 紧凑顶栏：标题 + 统计 + 复习 + Tab */}
      <div className="sticky top-[calc(var(--mobile-topbar-h)+var(--safe-top))] z-20 mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg py-2 md:top-0">
        <h1 className="flex items-center gap-2 text-[17px] font-bold tracking-[-0.01em] text-ink">
          <button
            type="button"
            onClick={() => {
              let origin = "/learn";
              try { origin = sessionStorage.getItem("mentora:notes-return") || origin; } catch { /* Use the learning page. */ }
              if (!(origin === "/learn" || origin.startsWith("/learn?") || origin.startsWith("/learn/") || origin.startsWith("/read/"))) origin = "/learn";
              if (readPreviousInAppRoute("") === origin) router.back();
              else router.push(origin);
            }}
            aria-label="返回学习页"
            className="flex min-h-11 min-w-11 items-center justify-center text-ink-dim transition hover:text-ink"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </button>
          <Brain className="size-4.5 text-accent" /> 笔记库
        </h1>
        <span className="text-xs text-ink-dim">
          {knowledge.length} 篇 · 连接 {linkedKnowledge.reduce((a, k) => a + k.links.length, 0)}
          {due.length > 0 ? (
            <>
              {" "}· 待复习{" "}
              <button
                onClick={startReview}
                aria-label={`开始复习 ${due.length} 个知识点`}
                className="font-semibold text-accent hover:underline cursor-pointer"
              >
                {due.length}
              </button>
            </>
          ) : (
            <> · 待复习 0</>
          )}
        </span>
        {/* 页内一级 tab 与学习页同款分段控件：learn/brain 是相邻页，激活态样式必须一致
            （旧实现是独立描边按钮，同一会话里切页要重新识别激活态） */}
        <div className="ml-auto flex items-center gap-1.5 rounded-xl border border-border bg-surface-2/50 p-1">
          {(
            [
              ["notes", "笔记"],
              ["graph", "关系图谱"],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button
              key={t}
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                "cursor-pointer rounded-lg px-3 py-1.5 text-[13px] font-medium transition",
                tab === t
                  ? "bg-white text-ink shadow-sm"
                  : "text-ink-dim hover:text-ink"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "notes" && (
        <NoteWorkspace
          openId={openId}
          onOpenNote={openNoteRoute}
          mode={wsMode}
          onModeChange={setWsMode}
          onGraph={() => setTab("graph")}
          onReview={startReview}
          dueCount={due.length}
          importSlot={<ObsidianImport iconOnly />}
        />
      )}

      {tab === "graph" && (
        <Card className="p-3">
          <GraphView
            notes={linkedKnowledge}
            focusId={openId}
            onOpen={openNoteRoute}
          />
          <p className="mt-3 text-center text-xs text-ink-dim">
            拖动节点整理布局 · 点击节点打开笔记 · 连线随内容增长而生长
          </p>
        </Card>
      )}

      {/* 复习弹窗 */}
      <Modal
        open={reviewQueue.length > 0 || !!summary}
        onClose={() => {
          /* 关窗 = 作废本轮：代际 +1 让在途请求的结果全部失效，并真正中止它们 */
          reviewGenRef.current++;
          reviewAbortRef.current?.abort();
          setBusy(false);
          setAskFailed(false);
          setReviewQueue([]);
          setSummary(null);
        }}
        title="间隔复习"
        wide
      >
        <div className="space-y-4">
          {reviewQueue.length > 0 && !summary && (
            <div className="flex items-center gap-3 text-xs text-ink-dim">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/[0.08]">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${sessionTotal ? ((sessionTotal - reviewQueue.length) / sessionTotal) * 100 : 0}%` }}
                />
              </div>
              <span className="tabular">
                {sessionTotal - reviewQueue.length + 1}/{sessionTotal}
              </span>
            </div>
          )}
          {summary && (
            <div className="space-y-3 py-2 text-center">
              <p className="text-3xl font-extrabold text-accent">
                {summary.total ? Math.round((correctCount / summary.total) * 100) : 100}%
              </p>
              <p className="text-sm font-semibold text-ink">
                {correctCount}/{summary.total} 条回忆成功 · 用时 {summary.minutes} 分钟
              </p>
              <p className="text-xs leading-relaxed text-ink-dim">
                {summary.correct === summary.total
                  ? "全对。记忆曲线正在给你复利——明天见。"
                  : "记住的那部分已经存稳了，忘掉的部分明天会再来找你。"}
              </p>
              {summary.nextDate && (
                <p className="text-xs text-ink-dim">下一次复习到期：{summary.nextDate}</p>
              )}
              <Button
                onClick={() => {
                  setSummary(null);
                  setReviewQueue([]);
                }}
              >
                完成本轮
              </Button>
            </div>
          )}
          {/* 总结出现后只渲染总结卡：旧实现 phase/question 渲染不受 summary 约束，
              判完最后一题点「下一个」时旧题目卡/判卷卡与总结同屏叠加 */}
          {!summary && phase === "ask" && !askFailed && (
            <div className="py-8 text-center text-sm text-ink-dim">
              <RefreshCcw className="mx-auto mb-3 size-6 animate-spin text-accent" />
              正在出题…
            </div>
          )}
          {!summary && askFailed && (
            <Card className="py-6 text-center">
              <p className="text-sm text-ink-dim">出题没有成功——本轮队列和已答进度都还在。</p>
              <Button className="mt-3" onClick={retryAsk} loading={busy}>
                重试出题
              </Button>
            </Card>
          )}
          {!summary && (phase === "answer" || phase === "graded") && (
            <>
              <Card className="border-accent/25">
                <Markdown text={question} />
              </Card>
              <Textarea
                rows={4}
                placeholder="不看笔记，凭回忆写下答案…"
                value={answer}
                disabled={phase === "graded"}
                onChange={(e) => setAnswer(e.target.value)}
              />
              {phase === "graded" && verdict && (
                <Card className={cn("animate-rise", verdict.verdict === "pass" ? "border-ok/30" : "border-bad/30")}>
                  <Badge tone={verdict.verdict === "pass" ? "ok" : "bad"}>
                    {verdict.verdict === "pass" ? "回忆成功" : "有遗忘"}
                  </Badge>
                  <p className="mt-2 text-sm text-ink-dim">{verdict.feedback}</p>
                </Card>
              )}
              <div className="flex justify-end gap-2">
                {phase === "answer" && (
                  <Button onClick={submitAnswer} loading={busy}>
                    提交回忆
                  </Button>
                )}
                {phase === "graded" && (
                  <Button onClick={nextInQueue}>
                    下一个 <RefreshCcw className="size-4" />
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </Modal>

    </div>
  );
}



