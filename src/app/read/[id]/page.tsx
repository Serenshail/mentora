"use client";

/* RAG trace 目前仅控制台诊断（见 doSend 内 [rag-trace]）；入库等 /api/track 白名单扩容后接 track() */

/* 阅读系统 V1.0（PRD 2026-11-05）三栏工作台：
 * 顶部=书籍认知概览（四区域，可收起）｜左侧=阅读路线（节点状态机+验收+沉淀）
 * 中间=AI 阅读空间（五模式+AI 策略推荐）｜右侧=学习状态面板（目标/理解状态/待解决/验收进度）
 * 布局原则（PRD 3.3）：界面按需展开收起，避免信息过载。 */

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Input, Modal, PageHeader, Skeleton, Textarea } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { AgentTrace, type TracePhase } from "@/components/agent-trace";
import { useAppStore } from "@/lib/store";
import { useChat, useHydrated } from "@/lib/use-chat";
import { extractJson, insightsSchema, readingAddNodeSchema, readingAssessGenSchema, readingAssessGradeSchema, readingGoalSchema, readingPlanSchema, readingStrategySchema } from "@/lib/ai/client";
import { READING_MODES, defaultReadingMode, type ReadingMode } from "@/lib/ai/reading-modes";
import {
  ASSESS_KIND_LABELS,
  DEPOSIT_TYPE_LABELS,
  READING_GOAL_LABELS,
  type AssessKind,
  type BookChapter,
  type BookReadStatus,
  type DepositType,
  type ReadingGoal,
  type ReadingGoalType,
} from "@/lib/types";
import { ragContext, wikiRetrieve } from "@/lib/rag";
import { retrieveEnhanced } from "@/lib/rag-pipeline";
import { cn, uid } from "@/lib/utils";
import { toast } from "sonner";
import {
  ArrowLeft, Bot, BookMarked, BrainCircuit, Check, ChevronDown, CircleHelp, GraduationCap,
  Layers, Lightbulb, MessagesSquare, PanelLeftClose, PanelLeftOpen, Plus, ShieldCheck,
  Sparkles, Target, Trash2, X,
} from "lucide-react";

const GOAL_ORDER: ReadingGoalType[] = ["understand", "think", "apply", "retain"];
const DEPOSIT_ORDER: DepositType[] = ["explanation", "point", "question", "view", "practice", "unresolved", "aiFeedback"];

/** 整本书阅读状态的展示元数据（已读完≠已掌握） */
const READ_STATUS_META: Record<BookReadStatus, { label: string; tone: "default" | "ok" | "warn" | "bad" | "accent" }> = {
  unread: { label: "未开始", tone: "default" },
  reading: { label: "阅读中", tone: "accent" },
  finished: { label: "已读完", tone: "warn" },
  assessing: { label: "验收中", tone: "warn" },
  mastered: { label: "已掌握", tone: "ok" },
};

const NODE_DOT: Record<BookChapter["status"], string> = {
  todo: "border-border bg-white text-ink-dim",
  reading: "border-accent/50 bg-accent/[0.15] text-accent",
  done: "border-ok/40 bg-ok/[0.12] text-ok",
  skipped: "border-border bg-black/[0.04] text-ink-dim/50",
};

/* chatMode 在 store 里是 string：用守卫收敛，不用 as 断言掩盖脏值 */
const isReadingMode = (v: string | undefined): v is ReadingMode =>
  READING_MODES.some((m) => m.id === v);

export default function BookPage() {
  const hydrated = useHydrated();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const book = useAppStore((s) => s.books.find((b) => b.id === id));
  const updateBook = useAppStore((s) => s.updateBook);
  const addBookMsg = useAppStore((s) => s.addBookMsg);
  const addInsight = useAppStore((s) => s.addInsight);
  const addKnowledge = useAppStore((s) => s.addKnowledge);
  const setBookGoal = useAppStore((s) => s.setBookGoal);
  const regenerateBookRoute = useAppStore((s) => s.regenerateBookRoute);
  const setChapterStatus = useAppStore((s) => s.setChapterStatus);
  const moveChapter = useAppStore((s) => s.moveChapter);
  const addChapterAssessment = useAppStore((s) => s.addChapterAssessment);
  const markChapterMastered = useAppStore((s) => s.markChapterMastered);
  const addBookDeposit = useAppStore((s) => s.addBookDeposit);
  const removeBookDeposit = useAppStore((s) => s.removeBookDeposit);
  const updateBookLearning = useAppStore((s) => s.updateBookLearning);
  const setBookReadStatus = useAppStore((s) => s.setBookReadStatus);

  const { messages, setMessages, pending, streaming, error, send, stop } = useChat();
  const [input, setInput] = useState("");
  const [phases, setPhases] = useState<TracePhase[]>([]);
  const [currentChapterId, setCurrentChapter] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  /* 阅读路线（PRD 3.3）：手机默认收起，桌面默认展开 */
  const [planOpen, setPlanOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 1024
  );
  /* 学习状态面板（右栏，PRD 3.3）：桌面默认展开、可收起；手机并入折叠条 */
  const [panelOpen, setPanelOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 1280
  );
  /* 认知地图（顶部）默认展开 */
  const [mapOpen, setMapOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 1024
  );
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  /* RAG 检索链路的中止器：useChat 的卸载 abort 管不到 send 之前的检索，
   * 卸载时不掐掉就是两次孤儿模型调用（改写+精排）。 */
  const ragAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => ragAbortRef.current?.abort(), []);

  /* ---- 目标（PRD 4.1）---- */
  const [goalEditing, setGoalEditing] = useState(false);
  const [goalPrimary, setGoalPrimary] = useState<ReadingGoalType | null>(null);
  const [goalSecondary, setGoalSecondary] = useState<ReadingGoalType[]>([]);
  const [goalIntent, setGoalIntent] = useState("");
  const [goalAiBusy, setGoalAiBusy] = useState(false);

  /* ---- 三重验收（PRD 4.5）：按目标生成三题 → 作答 → 证据化判分 ---- */
  const [assess, setAssess] = useState<{ chapterId: string; questions: { kind: AssessKind; question: string }[]; answers: string[] } | null>(null);
  const [assessBusy, setAssessBusy] = useState(false);
  const [assessResult, setAssessResult] = useState<{ results: { kind: AssessKind; level: "mastered" | "partial" | "not"; evidence: string; feedback: string }[]; suggestion?: string; chapterId: string } | null>(null);

  /* ---- 沉淀（PRD 4.6）---- */
  const [depositType, setDepositType] = useState<DepositType>("explanation");
  const [depositText, setDepositText] = useState("");
  /* ---- 节点小结 ---- */
  const [recap, setRecap] = useState<{ chapterId: string; md: string } | null>(null);
  const [recapBusy, setRecapBusy] = useState(false);
  /* ---- 路线重生成 / 加节点 ---- */
  const [regenBusy, setRegenBusy] = useState(false);
  const [routeMenuOpen, setRouteMenuOpen] = useState(false);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [addNodeInterest, setAddNodeInterest] = useState("");
  const [addNodeBusy, setAddNodeBusy] = useState(false);
  /* ---- 待解决问题快速添加（右栏）---- */
  const [questionDraft, setQuestionDraft] = useState("");
  /* AI 策略推荐：每节点只调一次 */
  const strategyTried = useRef<Set<string>>(new Set());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending]);

  // 恢复该书的历史对话（每本书一次；依赖带 book.id——云端数据晚到时补挂）
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !hydrated || !book) return;
    restored.current = true;
    if (book.chat.length > 0) setMessages(book.chat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, book?.id]);

  /* 阅读状态机起点：进页即"阅读中"（未开始→阅读中） */
  useEffect(() => {
    if (!hydrated || !book) return;
    const rs: BookReadStatus = book.readStatus ?? (book.status === "done" ? "finished" : book.status === "reading" ? "reading" : "unread");
    if (rs === "unread") setBookReadStatus(book.id, "reading");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, book?.id]);

  const chapter = useMemo(
    () => book?.chapters.find((c) => c.id === currentChapterId) ?? book?.chapters.find((c) => c.status === "todo" || c.status === "reading") ?? null,
    [book, currentChapterId]
  );
  /* 五模式：book 级锁定;未锁定或脏值按章节知识类型推荐 */
  const activeMode: ReadingMode = isReadingMode(book?.chatMode)
    ? book.chatMode
    : defaultReadingMode(chapter?.knowledgeType);
  const activeModeMeta = READING_MODES.find((m) => m.id === activeMode) ?? READING_MODES[0];

  const chapterJson = (c: BookChapter | null) =>
    c
      ? JSON.stringify({
          title: c.title,
          knowledgeType: c.knowledgeType || "concept",
          coreIdea: c.coreIdea ?? "",
          focusQuestion: c.focusQuestion,
          keyConcepts: c.keyConcepts ?? [],
          assessFocus: c.assessFocus ?? "",
          expectedOutcome: c.expectedOutcome ?? "",
        })
      : "null";

  const goalText = book?.goal
    ? `主目标 ${READING_GOAL_LABELS[book.goal.primary].label}${book.goal.secondary?.length ? `（次目标 ${book.goal.secondary.map((g) => READING_GOAL_LABELS[g].label).join("、")}）` : ""}${book.goal.intent ? `，想解决：${book.goal.intent}` : ""}`
    : "未设定";

  /* AI 策略推荐（PRD 4.4）：进节点时一次，cheap 任务，失败静默（知识类型默认兜底）。
   * 用户锁定了模式就不打扰（用户选择 > 系统推荐）。
   * ⚠️ 必须放在所有提前 return 之前——hook 顺序在渲染间不能变（v10.4 血泪教训）。 */
  useEffect(() => {
    if (!hydrated || !book || !chapter) return;
    if (book.chatMode) return;
    if (strategyTried.current.has(chapter.id)) return;
    strategyTried.current.add(chapter.id);
    void (async () => {
      try {
        const { streamChat } = await import("@/lib/ai/client");
        const full = await streamChat({
          task: "reading-strategy",
          args: {
            goal: goalText,
            chapter: chapterJson(chapter),
            learning: JSON.stringify({
              misconceptions: (book.learning?.misconceptions ?? []).slice(0, 5),
              unresolvedQuestions: (book.learning?.unresolvedQuestions ?? []).slice(0, 5),
            }),
            recentTurns: messages
              .slice(-4)
              .map((m) => `${m.role === "user" ? "用户" : "伙伴"}：${m.content.slice(0, 120)}`)
              .join("\n"),
            currentMode: book.chatMode ?? "",
          },
          messages: [{ role: "user", content: "推荐策略。" }],
          temperature: 0.2,
          onDelta: () => {},
        });
        const parsed = readingStrategySchema.parse(extractJson(full));
        if (parsed.mode !== defaultReadingMode(chapter.knowledgeType)) {
          updateBook(book.id, {
            recommendedMode: { mode: parsed.mode, reason: parsed.reason || "", chapterId: chapter.id, at: new Date().toISOString() },
          });
        }
      } catch {
        /* 静默：默认推荐已可用 */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, chapter?.id, book?.id]);

  if (!hydrated) return <Skeleton className="h-40 rounded-2xl bg-surface/60" />;
  if (!book) {
    return (
      <div className="py-20 text-center text-ink-dim">
        书不存在。
        <Button variant="outline" className="ml-3" onClick={() => router.push("/learn?tab=read")}>
          返回书架
        </Button>
      </div>
    );
  }

  const readStatus: BookReadStatus = book.readStatus ?? (book.status === "done" ? "finished" : book.status === "reading" ? "reading" : "unread");
  const doneCount = book.chapters.filter((c) => c.status === "done").length;
  const masteredCount = book.chapters.filter((c) => c.masteredAt).length;
  /* 认知地图：新书用 map；旧书从 profile 转换（PRD 4.2 数据兼容） */
  const map = book.map ?? (book.profile
    ? {
        coreProblem: book.profile.positioning,
        authorStance: book.profile.author,
        lineage: book.profile.lineage,
        controversies: book.profile.controversies,
        generatedAt: book.createdAt,
      }
    : null);

  const bookCtx = () =>
    JSON.stringify(
      {
        title: book.title,
        author: book.author,
        mapCore: map ? { problem: map.coreProblem, stance: map.authorStance } : null,
        readingGoal: book.goal ? { primary: book.goal.primary, secondary: book.goal.secondary, intent: book.goal.intent } : null,
        planSummary: book.planSummary,
        currentChapter: chapter ? {
          title: chapter.title,
          focusQuestion: chapter.focusQuestion,
          knowledgeType: chapter.knowledgeType || "concept",
          coreIdea: chapter.coreIdea,
          keyConcepts: chapter.keyConcepts ?? [],
          expectedOutcome: chapter.expectedOutcome ?? "",
        } : null,
        pastedExcerpt: book.pastedText?.slice(0, 2000),
        insights: book.insights.map((i) => i.text),
        misconceptions: (book.learning?.misconceptions ?? []).slice(0, 5).map((m) => `${m.concept}：${m.note}`),
        unresolvedQuestions: (book.learning?.unresolvedQuestions ?? []).slice(0, 5),
      },
      null,
      1
    );

  const doSend = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    void (async () => {
      /* UI 状态规范（R1/R2/R3）：检索阶段可见，否则用户以为页面卡死 */
      const t0 = performance.now();
      setPhases([{ label: "检索笔记", state: "running" }]);
      ragAbortRef.current?.abort(); // 上一轮检索还在飞：掐掉，防并发双跑
      const rac = new AbortController();
      ragAbortRef.current = rac;
      const notes = useAppStore
        .getState()
        .knowledge.filter((k) => !(k.tags ?? []).includes("MOC"))
        .map((k) => ({
          id: k.id, title: k.title, body: k.body, domain: k.domain,
          links: k.links, version: k.version, updatedAt: k.updatedAt, tags: k.tags,
        }));
      let ragCtx = "";
      let ragFailed = false;
      try {
        const enhanced = await retrieveEnhanced(
          text,
          notes,
          3,
          { context: `${chapter?.focusQuestion ?? ""} ${chapter?.coreIdea ?? ""}`.trim(), signal: rac.signal }
        );
        console.info("[rag-trace]", { task: "reading-chat", ...enhanced.trace });
        ragCtx = enhanced.context;
      } catch {
        ragFailed = true;
        ragCtx = ragContext(
          wikiRetrieve(
            `${text} ${chapter?.focusQuestion ?? ""} ${chapter?.coreIdea ?? ""}`,
            notes,
            3
          )
        );
      }
      if (rac.signal.aborted) return; // 已卸载/被新一轮取代：不再落库、不再 send
      const t1 = performance.now();
      setPhases([
        {
          label: "检索笔记",
          state: ragFailed ? "failed" : "done",
          durationMs: t1 - t0,
          detail: ragFailed ? "增强检索失败，已回退基础检索" : ragCtx ? "已带上你的相关笔记" : "没有相关笔记",
        },
        { label: "思考回答", state: "running" },
      ]);
      /* 先落库用户消息：send 失败时不丢这轮提问 */
      addBookMsg(book.id, { id: uid("m"), role: "user", content: text, at: new Date().toISOString() });
      const p = send({
        args: { bookCtx: bookCtx(), ragCtx, mode: activeMode, modeSwitch: book.modeJustSwitched === true },
        userText: text,
        task: "reading-chat",
        onDone: (full) => {
          if (!full) return;
          addBookMsg(book.id, { id: uid("m"), role: "assistant", content: full, at: new Date().toISOString() });
          if (book.modeJustSwitched) updateBook(book.id, { modeJustSwitched: false });
        },
      });
      const full = await p;
      if (!full) {
        setPhases((prev) =>
          prev.map((x) => (x.state === "running" ? { ...x, state: "failed" } : x))
        );
        return;
      }
      const t2 = performance.now();
      setPhases((prev) =>
        prev.map((x) => (x.state === "running" ? { ...x, state: "done", durationMs: t2 - t1 } : x))
      );
    })().catch(() => {
      setPhases((prev) => prev.map((x) => (x.state === "running" ? { ...x, state: "failed" } : x)));
    });
  };

  /* ================= 目标管理（PRD 4.1） ================= */

  const openGoalEditor = () => {
    setGoalPrimary(book.goal?.primary ?? null);
    setGoalSecondary(book.goal?.secondary ?? []);
    setGoalIntent(book.goal?.intent ?? "");
    setGoalEditing(true);
  };

  const saveGoal = () => {
    if (!goalPrimary) {
      toast.error("先选一个主要目标");
      return;
    }
    const goal: ReadingGoal = {
      primary: goalPrimary,
      secondary: goalSecondary.filter((g) => g !== goalPrimary),
      intent: goalIntent.trim() || undefined,
      setAt: new Date().toISOString(),
    };
    const changed = book.goal?.primary !== goal.primary;
    setBookGoal(book.id, goal);
    setGoalEditing(false);
    if (changed && book.chapters.length > 0) {
      toast("目标已更新。左侧路线菜单里选「重新生成路线」会按新目标重排——已有记录不会丢。");
    }
  };

  /** AI 推荐目标：根据书目信息推断（用户可接受可改） */
  const aiRecommendGoal = async () => {
    setGoalAiBusy(true);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const full = await streamChat({
        task: "reading-goal",
        args: {
          title: book.title,
          author: book.author ?? "",
          desc: (book.pastedText ?? "").slice(0, 600) || book.planSummary || "",
        },
        messages: [{ role: "user", content: "推荐阅读目标。" }],
        temperature: 0.2,
        onDelta: () => {},
      });
      const parsed = readingGoalSchema.parse(extractJson(full));
      setGoalPrimary(parsed.primary);
      setGoalSecondary((parsed.secondary ?? []).filter((g): g is ReadingGoalType => g !== parsed.primary));
      if (parsed.reason) toast(parsed.reason);
    } catch {
      toast.error("推荐失败——手动选一个也一样。");
    } finally {
      setGoalAiBusy(false);
    }
  };

  /* ================= 路线管理（PRD 4.3） ================= */

  const buildDesc = () =>
    `书名：《${book.title}》${book.author ? ` 作者：${book.author}` : ""}${
      book.pastedText ? `\n用户粘贴的内容/笔记：\n${book.pastedText.slice(0, 6000)}` : ""
    }`;

  const regenerateRoute = async (routeType: "full" | "core" | "goal") => {
    if (regenBusy) return;
    setRegenBusy(true);
    setRouteMenuOpen(false);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const full = await streamChat({
        task: "reading-plan",
        args: {
          desc: buildDesc(),
          goal: book.goal
            ? {
                primary: READING_GOAL_LABELS[book.goal.primary].label,
                secondary: book.goal.secondary?.map((g) => READING_GOAL_LABELS[g].label).join("、") || undefined,
                intent: book.goal.intent,
              }
            : undefined,
          routeType,
        },
        messages: [{ role: "user", content: "生成阅读路线。" }],
        temperature: 0.5,
        onDelta: () => {},
      });
      const plan = readingPlanSchema.parse(extractJson(full));
      regenerateBookRoute(book.id, {
        map: plan.map ? { ...plan.map, generatedAt: new Date().toISOString() } : undefined,
        planSummary: plan.planSummary,
        routeType,
        chapters: plan.chapters.map((c) => ({
          ...c,
          knowledgeType: c.knowledgeType || "concept",
          coreIdea: c.coreIdea || undefined,
          perspectives: c.perspectives || undefined,
          capture: c.capture || undefined,
          keyConcepts: c.keyConcepts || undefined,
          prerequisites: c.prerequisites || undefined,
          expectedOutcome: c.expectedOutcome || undefined,
          assessFocus: c.assessFocus || undefined,
          id: uid("ch"),
          status: "todo" as const,
        })),
      });
      setCurrentChapter(null);
      setExpandedId(null);
      toast.success(`路线已按「${routeType === "full" ? "完整" : routeType === "core" ? "核心" : "目标导向"}」重排。历史验收与沉淀都在。`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "重生成失败——原路线没动。");
    } finally {
      setRegenBusy(false);
    }
  };

  const addNodeByInterest = async () => {
    const interest = addNodeInterest.trim();
    if (!interest) {
      toast.error("写一句你感兴趣的东西");
      return;
    }
    setAddNodeBusy(true);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const full = await streamChat({
        task: "reading-add-node",
        args: {
          book: book.title,
          titles: book.chapters.map((c) => c.title).join(" / "),
          interest,
          goal: goalText,
        },
        messages: [{ role: "user", content: "添加节点。" }],
        temperature: 0.4,
        onDelta: () => {},
      });
      const parsed = readingAddNodeSchema.parse(extractJson(full));
      const c = parsed.chapter;
      const node: BookChapter = {
        ...c,
        coreIdea: c.coreIdea || undefined,
        keyConcepts: c.keyConcepts || undefined,
        prerequisites: c.prerequisites || undefined,
        expectedOutcome: c.expectedOutcome || undefined,
        assessFocus: c.assessFocus || undefined,
        perspectives: c.perspectives || undefined,
        capture: c.capture || undefined,
        id: uid("ch"),
        status: "todo",
      };
      updateBook(book.id, { chapters: [...book.chapters, node] });
      setAddNodeOpen(false);
      setAddNodeInterest("");
      toast.success(`已加节点「${node.title}」，可在路线上调整位置。`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加节点失败");
    } finally {
      setAddNodeBusy(false);
    }
  };

  /* ================= 三重验收（PRD 4.5） ================= */

  const previousWeak = (chapterId: string) => {
    const latest = (book.assessments ?? []).filter((a) => a.chapterId === chapterId && a.level !== "mastered").slice(-2);
    return latest.map((a) => `${ASSESS_KIND_LABELS[a.kind]}：${a.feedback}`).join("；");
  };

  const openAssess = async (c: BookChapter) => {
    if (assessBusy) return;
    setAssessBusy(true);
    setAssessResult(null);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const full = await streamChat({
        task: "reading-assess-gen",
        args: {
          book: book.title,
          chapter: chapterJson(c),
          goal: goalText,
          previousWeak: previousWeak(c.id),
        },
        messages: [{ role: "user", content: "出验收题。" }],
        temperature: 0.4,
        onDelta: () => {},
      });
      const parsed = readingAssessGenSchema.parse(extractJson(full));
      const questions = parsed.questions.slice(0, 3);
      setAssess({ chapterId: c.id, questions, answers: questions.map(() => "") });
    } catch {
      /* 出题失败 → 本地兜底三题（节点信息直接映射三维度），不阻断验收 */
      const questions: { kind: AssessKind; question: string }[] = [
        { kind: "explain", question: `合上书，用自己的话解释「${c.title}」的核心主张。` },
        { kind: "connect", question: `这个主张和${c.prerequisites?.[0] ? `「${c.prerequisites[0]}」` : "前面读过的内容"}是什么关系？` },
        { kind: "apply", question: `你工作或生活里哪件事能用上它？具体说怎么用。` },
      ];
      setAssess({ chapterId: c.id, questions, answers: questions.map(() => "") });
      toast("在线出题没成功，用了通用三题。");
    } finally {
      setAssessBusy(false);
    }
  };

  const submitAssess = async (c: BookChapter) => {
    if (!assess) return;
    if (assess.answers.some((a) => !a.trim())) {
      toast.error("三题都要写，验收才算数。");
      return;
    }
    setAssessBusy(true);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const qa = assess.questions.map((q, i) => ({ kind: q.kind, question: q.question, answer: assess.answers[i] }));
      const full = await streamChat({
        task: "reading-assess-grade",
        args: {
          book: book.title,
          chapter: chapterJson(c),
          goal: goalText,
          qa: JSON.stringify(qa),
        },
        messages: [{ role: "user", content: "评分。" }],
        temperature: 0.2,
        onDelta: () => {},
      });
      const parsed = readingAssessGradeSchema.parse(extractJson(full));
      const results = parsed.results
        .slice(0, assess.questions.length)
        .map((r) => ({ kind: r.kind, level: r.level, evidence: r.evidence ?? "", feedback: r.feedback ?? "" }));
      /* 逐题落档案（book 级，换路线不丢） */
      results.forEach((r, i) => {
        addChapterAssessment(book.id, {
          id: uid("as"),
          chapterId: c.id,
          kind: r.kind,
          question: assess.questions[i]?.question ?? "",
          answer: assess.answers[i],
          level: r.level,
          evidence: r.evidence || "",
          feedback: r.feedback || "",
          suggestion: parsed.suggestion || undefined,
          at: new Date().toISOString(),
        });
      });
      const masteredN = results.filter((r) => r.level === "mastered").length;
      const hasNot = results.some((r) => r.level === "not");
      const passed = !hasNot && masteredN >= Math.max(2, Math.ceil(results.length * 0.66));
      setAssessResult({ chapterId: c.id, results, suggestion: parsed.suggestion || undefined });
      setAssess(null);
      if (passed) {
        markChapterMastered(book.id, c.id, results.map((r) => r.feedback).join(" "));
        toast.success(`验收通过（${masteredN}/${results.length} 要害命中）——这个节点算掌握了。`);
      } else {
        toast(`还没过——${parsed.suggestion || "看看每题反馈，补上缺口再考一次。"}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "判分失败——答案还在，可以重交。");
    } finally {
      setAssessBusy(false);
    }
  };

  /** 补课：把最薄弱点的反馈作为求助消息发进对话区（验收服务于学习，不制造负担） */
  const remediate = (c: BookChapter) => {
    const weak = (book.assessments ?? []).filter((a) => a.chapterId === c.id && a.level !== "mastered").slice(-1)[0];
    const text = `我验收没过的点是：${weak ? `${ASSESS_KIND_LABELS[weak.kind]}——${weak.feedback}` : c.assessFocus || c.focusQuestion}。带我从头补一遍，别直接给答案。`;
    setInput("");
    addBookMsg(book.id, { id: uid("m"), role: "user", content: text, at: new Date().toISOString() });
    void send({
      args: { bookCtx: bookCtx(), ragCtx: "", mode: activeMode, modeSwitch: false },
      userText: text,
      task: "reading-chat",
      onDone: (full) => {
        if (full) addBookMsg(book.id, { id: uid("m"), role: "assistant", content: full, at: new Date().toISOString() });
      },
    });
    setAssessResult(null);
  };

  /* ================= 沉淀（PRD 4.6） ================= */

  const addDeposit = (chapterId?: string) => {
    const text = depositText.trim();
    if (!text) return;
    addBookDeposit(book.id, { chapterId, type: depositType, text });
    setDepositText("");
    if (depositType === "unresolved" || depositType === "question") {
      updateBookLearning(book.id, { unresolvedQuestions: [text] });
    }
    toast("已沉淀。你自己的话，比 AI 的总结值钱。");
  };

  const nodeRecap = async (c: BookChapter) => {
    if (recapBusy) return;
    setRecapBusy(true);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const deposits = (book.deposits ?? []).filter((d) => d.chapterId === c.id);
      const chatText = messages
        .map((m) => `${m.role === "user" ? "用户" : "伙伴"}：${m.content}`)
        .join("\n")
        .slice(0, 3000);
      const full = await streamChat({
        task: "reading-recap",
        args: {
          book: book.title,
          chapter: chapterJson(c),
          deposits: JSON.stringify(deposits.map((d) => ({ type: DEPOSIT_TYPE_LABELS[d.type], text: d.text }))),
          chatExcerpt: chatText,
        },
        messages: [{ role: "user", content: "生成小结。" }],
        temperature: 0.3,
        onDelta: () => {},
      });
      setRecap({ chapterId: c.id, md: full });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "小结失败");
    } finally {
      setRecapBusy(false);
    }
  };

  const saveRecapToBrain = () => {
    if (!recap) return;
    const c = book.chapters.find((x) => x.id === recap.chapterId);
    addKnowledge(
      [{ title: `《${book.title}》· ${c?.title ?? "节点小结"}`, body: recap.md, domain: book.title }],
      "read",
      `《${book.title}》`
    );
    toast.success("小结已入第二大脑。");
    setRecap(null);
  };

  /* ================= 整本书状态机（PRD 4.5） ================= */

  const wholeBookAssess = () => {
    setBookReadStatus(book.id, "assessing");
    updateBook(book.id, { chatMode: "recall-check", modeJustSwitched: true });
    toast("复盘检验已就位——合上书，把整本书讲给它听。聊完点「确认已掌握」。");
  };

  /* ================= 提炼洞见（保留） ================= */

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
      if (parsed.insights.length === 0) {
        toast("这段对话里还没有属于你自己的洞见——再往深处聊两轮，或者把例子讲具体些，再来提炼。");
        return;
      }
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

  /* AI 策略推荐已在组件顶部（提前 return 之前）执行——此处不再重复。 */

  const recommended = book.recommendedMode && book.recommendedMode.chapterId === chapter?.id ? book.recommendedMode : null;
  const recommendedMeta = recommended ? READING_MODES.find((m) => m.id === recommended.mode) : null;

  /* ================= 渲染 ================= */

  const goalCard = goalEditing || !book.goal ? (
    <Card className={cn("mb-6 border-accent/30", !book.goal && "border-dashed")}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[13px] font-bold text-ink">
            <Target className="size-4 text-accent" /> 这次读这本书，你想得到什么？
          </p>
          <p className="mt-1 text-xs text-ink-dim">目标决定路线怎么排、用什么方式教、验收考什么。主目标必选，可加次目标，之后随时改。</p>
        </div>
        {book.goal && (
          <Button variant="ghost" size="sm" onClick={() => setGoalEditing(false)}>
            收起
          </Button>
        )}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {GOAL_ORDER.map((g) => {
          const meta = READING_GOAL_LABELS[g];
          const primary = goalPrimary === g;
          const secondary = !primary && goalSecondary.includes(g);
          return (
            <button
              key={g}
              onClick={() => {
                /* 交互约定：第一个点的是主目标；已有主目标时再点其他目标 = 加为次目标；
                 * 点已选的次目标 = 取消。 */
                if (primary) return;
                if (secondary) {
                  setGoalSecondary((p) => p.filter((x) => x !== g));
                  return;
                }
                if (goalPrimary) setGoalSecondary((p) => (p.includes(g) ? p : [...p, g]));
                else setGoalPrimary(g);
              }}
              className={cn(
                "rounded-xl border p-3 text-left transition cursor-pointer",
                primary
                  ? "border-accent/60 bg-accent/[0.07]"
                  : secondary
                    ? "border-accent/30 bg-accent/[0.03]"
                    : "border-border bg-white hover:border-accent/40"
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className={cn("text-[13px] font-bold", primary ? "text-accent" : "text-ink")}>{meta.label}</span>
                {primary && <Badge tone="accent">主</Badge>}
                {secondary && <Badge tone="dim">次</Badge>}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">{meta.desc}</p>
            </button>
          );
        })}
      </div>
      <Input
        className="mt-3"
        placeholder="你想用这本书解决什么问题？（可选，一句话）"
        value={goalIntent}
        onChange={(e) => setGoalIntent(e.target.value)}
      />
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => void aiRecommendGoal()} loading={goalAiBusy}>
          <Sparkles className="size-3.5" /> 让 AI 推荐
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            /* 不填问卷直接开读（PRD 4.1 验收 1）：默认理解型，标记为推断 */
            setBookGoal(book.id, { primary: "understand", secondary: [], inferred: true, setAt: new Date().toISOString() });
            setGoalEditing(false);
            toast("先按「理解」目标开始——想换随时改。");
          }}
        >
          直接开始
        </Button>
        <Button size="sm" onClick={saveGoal} disabled={!goalPrimary}>
          就这样开始
        </Button>
      </div>
    </Card>
  ) : null;

  const mapStrip = map ? (
    <div className="mb-6">
      <button
        onClick={() => setMapOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between rounded-t-2xl border border-border bg-surface-2/60 px-4 py-2.5 text-left"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold text-ink">
          <Layers className="size-3.5 text-accent" /> 这本书在讲什么（认知地图 · AI 生成供导读，重要观点请核对原文）
        </span>
        <ChevronDown className={cn("size-4 text-ink-dim transition", mapOpen && "rotate-180")} />
      </button>
      {mapOpen && (
        <div className="grid gap-2.5 rounded-b-2xl border border-t-0 border-border p-3 sm:grid-cols-2">
          {([
            ["这本书在解决什么问题", map.coreProblem],
            ["作者的核心主张", map.authorStance],
            ["思想谱系", map.lineage],
            ["争议与局限", map.controversies],
          ] as [string, string][]).map(([label, text]) => (
            <div key={label} className="rounded-xl bg-surface-2/50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-accent/80">{label}</p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-dim">{text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  ) : null;

  /* 右栏：学习状态面板（PRD 3.3） */
  const statusPanel = (
    <div className="space-y-3">
      <div className="rounded-2xl border border-border bg-white p-3.5">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">阅读目标</p>
          <button onClick={openGoalEditor} className="cursor-pointer text-[11px] text-accent hover:underline">
            修改
          </button>
        </div>
        {book.goal ? (
          <>
            <p className="mt-1.5 text-[13px] font-bold text-ink">
              {READING_GOAL_LABELS[book.goal.primary].label}
              {book.goal.secondary?.length ? (
                <span className="ml-1.5 text-[11px] font-normal text-ink-dim">+ {book.goal.secondary.map((g) => READING_GOAL_LABELS[g].label).join("、")}</span>
              ) : null}
            </p>
            {book.goal.intent && <p className="mt-1 text-[11.5px] leading-relaxed text-ink-dim">「{book.goal.intent}」</p>}
            {book.goal.inferred && <p className="mt-1 text-[10.5px] text-ink-dim/60">AI 推断的默认目标——点「修改」换成你的。</p>}
          </>
        ) : (
          <p className="mt-1.5 text-[12px] text-ink-dim">还没设定——设定后路线与验收会跟着它走。</p>
        )}
      </div>

      {chapter && (
        <div className="rounded-2xl border border-border bg-white p-3.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">当前节点</p>
          <p className="mt-1.5 text-[13px] font-bold text-ink">{chapter.title}</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-dim">带着这个问题读：{chapter.focusQuestion}</p>
          {chapter.expectedOutcome && (
            <p className="mt-1.5 text-[11px] text-ink-dim/80">
              <b className="text-ink/70">学完应该能：</b>{chapter.expectedOutcome}
            </p>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-border bg-white p-3.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">理解状态</p>
        {(chapter?.keyConcepts ?? []).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {chapter!.keyConcepts!.map((k) => {
              const known =
                (book.learning?.knownConcepts ?? []).includes(k) ||
                book.chapters.some((c) => c.masteredAt && (c.keyConcepts ?? []).includes(k));
              return (
                <span
                  key={k}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10.5px]",
                    known ? "border-ok/40 bg-ok/[0.08] text-ok" : "border-border bg-white text-ink-dim"
                  )}
                >
                  {known ? "✓ " : ""}{k}
                </span>
              );
            })}
          </div>
        )}
        {(book.learning?.misconceptions ?? []).length > 0 && (
          <div className="mt-2.5 space-y-1.5">
            <p className="text-[10.5px] text-ink-dim/70">AI 记下的易混点（不是标签，是证据；补上就走）：</p>
            {book.learning!.misconceptions.slice(0, 3).map((m, i) => (
              <p key={i} className="rounded-lg bg-warn/[0.06] px-2 py-1.5 text-[11px] leading-relaxed text-ink-dim">
                <b className="text-ink/80">{m.concept}</b>：{m.note}
              </p>
            ))}
          </div>
        )}
        {(chapter?.keyConcepts ?? []).length === 0 && (book.learning?.misconceptions ?? []).length === 0 && (
          <p className="mt-1.5 text-[11.5px] text-ink-dim">聊起来、答过题之后，这里会出现你的理解证据。</p>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-white p-3.5">
        <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
          <CircleHelp className="size-3" /> 待解决的问题
        </p>
        {(book.learning?.unresolvedQuestions ?? []).length === 0 && (book.deposits ?? []).filter((d) => d.type === "unresolved").length === 0 ? (
          <p className="mt-1.5 text-[11.5px] text-ink-dim">读到没懂的地方，记在这里。</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {(book.learning?.unresolvedQuestions ?? []).slice(0, 5).map((q, i) => (
              <li key={`lq-${i}`} className="text-[11.5px] leading-relaxed text-ink-dim">· {q}</li>
            ))}
            {(book.deposits ?? []).filter((d) => d.type === "unresolved").slice(0, 5).map((d) => (
              <li key={d.id} className="text-[11.5px] leading-relaxed text-ink-dim">· {d.text}</li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex gap-1.5">
          <Input
            className="h-8 text-xs"
            placeholder="记一个问题…"
            value={questionDraft}
            onChange={(e) => setQuestionDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && questionDraft.trim()) {
                updateBookLearning(book.id, { unresolvedQuestions: [questionDraft.trim()] });
                addBookDeposit(book.id, { chapterId: chapter?.id, type: "unresolved", text: questionDraft.trim() });
                setQuestionDraft("");
              }
            }}
          />
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-white p-3.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">验收进度</p>
        <div className="mt-2 flex items-baseline gap-3 text-[13px]">
          <span className="font-bold text-ink tabular-nums">{doneCount}<span className="text-ink-dim/60">/{book.chapters.length}</span></span>
          <span className="text-[11px] text-ink-dim">节点完成</span>
          <span className="font-bold text-ok tabular-nums">{masteredCount}</span>
          <span className="text-[11px] text-ink-dim">验收通过</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/[0.07]">
          <div className="h-full rounded-full bg-accent/70 transition-all" style={{ width: `${book.chapters.length ? (doneCount / book.chapters.length) * 100 : 0}%` }} />
        </div>
        {(book.assessments ?? []).length > 0 && (
          <p className="mt-2 text-[11px] text-ink-dim">{(() => {
            const last = book.assessments![book.assessments!.length - 1];
            return `最近验收：${ASSESS_KIND_LABELS[last.kind]} · ${last.level === "mastered" ? "通过" : last.level === "partial" ? "部分" : "未过"}`;
          })()}</p>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-white p-3.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">整本书</p>
        <div className="mt-2 flex items-center gap-2">
          <Badge tone={READ_STATUS_META[readStatus].tone}>{READ_STATUS_META[readStatus].label}</Badge>
          {readStatus === "reading" && doneCount >= book.chapters.length && (
            <span className="text-[10.5px] text-accent">全部节点完成</span>
          )}
        </div>
        <div className="mt-2.5 space-y-1.5">
          {readStatus === "reading" && (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setBookReadStatus(book.id, "finished")}>
              <BookMarked className="size-3.5" /> 标记整本读完
            </Button>
          )}
          {readStatus === "finished" && (
            <Button variant="outline" size="sm" className="w-full" onClick={wholeBookAssess}>
              <ShieldCheck className="size-3.5" /> 整本复盘验收
            </Button>
          )}
          {readStatus === "assessing" && (
            <>
              <Button size="sm" className="w-full" onClick={() => setBookReadStatus(book.id, "mastered")}>
                <GraduationCap className="size-3.5" /> 复盘完成，标记已掌握
              </Button>
              <p className="text-[10.5px] leading-relaxed text-ink-dim/70">诚实原则：只在你能独立讲清这本书时点它。</p>
            </>
          )}
          {readStatus === "mastered" && (
            <p className="text-[11px] leading-relaxed text-ink-dim">
              这本书你已验收掌握。回看沉淀，或把小结关联进第二大脑。
            </p>
          )}
          {readStatus === "unread" && (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setBookReadStatus(book.id, "reading")}>
              开始读
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <button
        onClick={() => router.push("/learn?tab=read")}
        className="mb-4 flex items-center gap-1.5 text-sm text-ink-dim hover:text-ink cursor-pointer"
      >
        <ArrowLeft className="size-4" /> 书架
      </button>

      <PageHeader
        title={`《${book.title}》`}
        desc={book.author}
        right={
          <div className="flex items-center gap-2">
            <Badge tone={READ_STATUS_META[readStatus].tone}>{READ_STATUS_META[readStatus].label}</Badge>
            <Button variant="outline" onClick={() => void extract()} loading={extracting}>
              <Lightbulb className="size-4" /> 提炼洞见
            </Button>
          </div>
        }
      />

      {goalCard}
      {mapStrip}

      <div className={cn("grid gap-6", planOpen && "lg:grid-cols-[300px_1fr]", panelOpen && "xl:grid-cols-[300px_1fr_290px]")}>
        {/* ================= 左栏：阅读路线 ================= */}
        {planOpen && (
          <Card className="h-fit lg:sticky lg:top-8">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-dim">
                阅读路线 · {book.routeType === "core" ? "核心" : book.routeType === "goal" ? "目标导向" : "完整"}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setRouteMenuOpen((v) => !v)}
                  title="路线选项"
                  className="tap-target grid place-items-center rounded-md text-ink-dim/60 transition hover:text-ink cursor-pointer"
                >
                  <Layers className="size-4" />
                </button>
                <button
                  onClick={() => setPlanOpen(false)}
                  title="收起阅读路线"
                  aria-label="收起阅读路线"
                  className="tap-target grid place-items-center rounded-md text-ink-dim/60 transition hover:text-ink cursor-pointer"
                >
                  <PanelLeftClose className="size-4" />
                </button>
              </div>
            </div>
            {routeMenuOpen && (
              <div className="mb-3 space-y-2 rounded-xl border border-border bg-surface-2 p-3">
                <p className="text-[11px] font-semibold text-ink">换一种路线（已有验收与沉淀会保留）</p>
                <Button variant="outline" size="sm" className="w-full justify-start" disabled={regenBusy} onClick={() => void regenerateRoute("full")}>
                  完整路线 · 按全书结构系统读
                </Button>
                <Button variant="outline" size="sm" className="w-full justify-start" disabled={regenBusy} onClick={() => void regenerateRoute("core")}>
                  核心路线 · 只读最重要的主干
                </Button>
                <Button variant="outline" size="sm" className="w-full justify-start" disabled={regenBusy} onClick={() => void regenerateRoute("goal")}>
                  目标导向 · 围绕我的问题重组{book.goal ? "" : "（建议先设目标）"}
                </Button>
                <Button variant="outline" size="sm" className="w-full justify-start" onClick={() => { setAddNodeOpen(true); setRouteMenuOpen(false); }}>
                  <Plus className="size-3.5" /> 让 AI 加一个我感兴趣的节点
                </Button>
                {regenBusy && <p className="text-[11px] text-accent">正在重排路线…（约 30-60 秒）</p>}
              </div>
            )}
            {/* 目录独立滚动：长书翻目录不拖整页 */}
            <div className="relative ml-2 max-h-[calc(100dvh-260px)] space-y-1 overflow-y-auto border-l border-border pl-5 lg:pr-1">
              {book.chapters.map((c, i) => {
                const expanded = expandedId === c.id || chapter?.id === c.id;
                const verified = !!c.masteredAt;
                return (
                  <div key={c.id} className="relative">
                    <span
                      className={cn(
                        "absolute -left-[27px] top-3 flex size-3.5 items-center justify-center rounded-full border text-[8px] font-bold",
                        NODE_DOT[c.status] ?? NODE_DOT.todo,
                        chapter?.id === c.id && c.status !== "done" && c.status !== "skipped" && "border-accent/50 bg-accent text-white"
                      )}
                    >
                      {c.status === "done" ? <Check className="size-2.5" /> : c.status === "skipped" ? <X className="size-2.5" /> : i + 1}
                    </span>
                    <button
                      onClick={() => {
                        setCurrentChapter(c.id);
                        if (c.status === "todo") setChapterStatus(book.id, c.id, "reading");
                        setExpandedId(expanded && chapter?.id === c.id ? null : c.id);
                      }}
                      className={cn(
                        "w-full rounded-xl px-3 py-2.5 text-left transition cursor-pointer",
                        c.status === "skipped" && "opacity-50",
                        chapter?.id === c.id ? "bg-accent/[0.07]" : "hover:bg-black/[0.035]"
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className={cn("text-[13px] font-semibold", chapter?.id === c.id ? "text-accent" : "text-ink")}>
                          {c.title}
                        </span>
                        {verified && <ShieldCheck className="ml-auto size-3.5 shrink-0 text-ok" />}
                      </div>
                      <p className="mt-0.5 line-clamp-1 text-[11.5px] text-ink-dim">{c.focusQuestion}</p>
                    </button>
                    {expanded && (
                      <div className="mb-2 space-y-2 rounded-xl border border-border bg-surface-2 p-3">
                        {(c.prerequisites ?? []).length > 0 && (
                          <p className="text-[11px] leading-relaxed text-ink-dim">
                            <b className="text-ink">先读：</b>{c.prerequisites!.join("、")}
                          </p>
                        )}
                        {c.coreIdea && (
                          <p className="text-[11.5px] leading-relaxed text-ink-dim">
                            <b className="text-ink">核心论点：</b>{c.coreIdea}
                          </p>
                        )}
                        {(c.keyConcepts ?? []).length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {c.keyConcepts!.map((k) => (
                              <span key={k} className="rounded-full border border-border bg-white px-2 py-0.5 text-[10.5px] text-ink-dim">{k}</span>
                            ))}
                          </div>
                        )}
                        {c.expectedOutcome && (
                          <p className="text-[11px] leading-relaxed text-ink-dim">
                            <b className="text-ink">学完应该能：</b>{c.expectedOutcome}
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
                        {/* 旧版三题验收结果（兼容显示） */}
                        {c.verification && !verified && (
                          <p className="text-[11px] text-ink-dim/80">
                            旧验收：{c.verification.total} 分 · {c.verification.level === "understood" ? "真懂了" : c.verification.level === "partial" ? "半懂" : "没懂"}
                          </p>
                        )}

                        {/* 三重验收（PRD 4.5）：按目标生成 → 作答 → 证据化判分 */}
                        {assess && assess.chapterId === c.id ? (
                          <div className="space-y-2 rounded-lg border border-accent/25 bg-white p-2.5">
                            <p className="flex items-center gap-1 text-[11px] font-semibold text-accent">
                              <ShieldCheck className="size-3.5" /> 验收 · 按「{book.goal ? READING_GOAL_LABELS[book.goal.primary].label : "理解"}」目标出题
                            </p>
                            {assess.questions.map((q, i) => (
                              <div key={i}>
                                <p className="text-[11px] text-ink">
                                  <span className="text-[9.5px] font-semibold uppercase tracking-wider text-ink-dim/60">{ASSESS_KIND_LABELS[q.kind]} · </span>
                                  {q.question}
                                </p>
                                <Textarea
                                  rows={2}
                                  className="mt-1"
                                  value={assess.answers[i]}
                                  onChange={(e) =>
                                    setAssess((p) =>
                                      p ? { ...p, answers: p.answers.map((v, j) => (j === i ? e.target.value : v)) } : p
                                    )
                                  }
                                  placeholder="写你自己的话…"
                                />
                              </div>
                            ))}
                            <div className="flex justify-end gap-1.5">
                              <Button variant="outline" size="sm" onClick={() => setAssess(null)} disabled={assessBusy}>
                                以后再说
                              </Button>
                              <Button size="sm" onClick={() => void submitAssess(c)} loading={assessBusy}>
                                提交验收
                              </Button>
                            </div>
                          </div>
                        ) : assessResult && assessResult.chapterId === c.id ? (
                          <div className="space-y-2 rounded-lg border border-border bg-white p-2.5">
                            <p className="text-[11px] font-semibold text-ink">验收结果 · 逐题证据</p>
                            {assessResult.results.map((r, i) => (
                              <div
                                key={i}
                                className={cn(
                                  "rounded-lg border p-2",
                                  r.level === "mastered" ? "border-ok/30 bg-ok/[0.05]" : r.level === "partial" ? "border-warn/30 bg-warn/[0.05]" : "border-bad/25 bg-bad/[0.04]"
                                )}
                              >
                                <p className="text-[10.5px] font-semibold text-ink-dim">{ASSESS_KIND_LABELS[r.kind]} · {r.level === "mastered" ? "通过" : r.level === "partial" ? "部分" : "未过"}</p>
                                {r.evidence && <p className="mt-0.5 text-[11px] text-ink-dim">依据：{r.evidence}</p>}
                                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-dim">{r.feedback}</p>
                              </div>
                            ))}
                            {assessResult.suggestion && <p className="text-[11px] text-ink-dim">下一步：{assessResult.suggestion}</p>}
                            <div className="flex gap-1.5">
                              <Button variant="outline" size="sm" className="flex-1" onClick={() => remediate(c)}>
                                <Bot className="size-3.5" /> 就薄弱点补课
                              </Button>
                              <Button variant="outline" size="sm" className="flex-1" onClick={() => { setAssessResult(null); void openAssess(c); }}>
                                再考一次
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full"
                            disabled={assessBusy}
                            onClick={() => void openAssess(c)}
                          >
                            <ShieldCheck className="size-3.5" /> {verified ? "再次验收" : assessBusy ? "正在出题…" : "开始验收（通过=掌握）"}
                          </Button>
                        )}

                        {/* 沉淀（PRD 4.6）：优先用户自己的话 */}
                        <div className="rounded-lg border border-border bg-white p-2.5">
                          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-dim/70">沉淀一句话</p>
                          <div className="mt-1.5 flex gap-1.5">
                            <select
                              value={depositType}
                              onChange={(e) => setDepositType(e.target.value as DepositType)}
                              className="h-8 rounded-lg border border-border bg-white px-1.5 text-[11px] text-ink outline-none focus:border-accent/50"
                            >
                              {DEPOSIT_ORDER.map((t) => (
                                <option key={t} value={t}>{DEPOSIT_TYPE_LABELS[t]}</option>
                              ))}
                            </select>
                            <Input
                              className="h-8 flex-1 text-xs"
                              placeholder="用你自己的话…"
                              value={depositText}
                              onChange={(e) => setDepositText(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && addDeposit(c.id)}
                            />
                            <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => addDeposit(c.id)}>
                              记
                            </Button>
                          </div>
                          {(book.deposits ?? []).filter((d) => d.chapterId === c.id).length > 0 && (
                            <div className="mt-2 space-y-1">
                              {(book.deposits ?? []).filter((d) => d.chapterId === c.id).slice(0, 6).map((d) => (
                                <div key={d.id} className="group flex items-start gap-1 rounded-md bg-surface-2 px-2 py-1.5">
                                  <span className="mt-0.5 shrink-0 text-[9.5px] font-semibold uppercase tracking-wide text-accent/70">{DEPOSIT_TYPE_LABELS[d.type]}</span>
                                  <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-ink-dim">{d.text}</span>
                                  <button
                                    onClick={() => removeBookDeposit(book.id, d.id)}
                                    className="shrink-0 cursor-pointer text-ink-dim/40 opacity-0 transition group-hover:opacity-100 hover:text-bad"
                                    aria-label="删除这条沉淀"
                                  >
                                    <Trash2 className="size-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          <Button variant="ghost" size="sm" className="mt-1.5 w-full" disabled={recapBusy} onClick={() => void nodeRecap(c)}>
                            {recapBusy ? "整理中…" : "生成本节点小结"}
                          </Button>
                        </div>

                        {/* 节点操作：状态机 + 排序（PRD 4.3 验收 4/5） */}
                        <div className="flex flex-wrap gap-1.5">
                          <Button variant="ghost" size="sm" onClick={() => setChapterStatus(book.id, c.id, c.status === "done" ? "reading" : "done")}>
                            {c.status === "done" ? "标记未读完" : "标记已读完（不验收）"}
                          </Button>
                          {c.status !== "skipped" ? (
                            <Button variant="ghost" size="sm" onClick={() => setChapterStatus(book.id, c.id, "skipped")}>
                              跳过
                            </Button>
                          ) : (
                            <Button variant="ghost" size="sm" onClick={() => setChapterStatus(book.id, c.id, "todo")}>
                              恢复此节点
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => moveChapter(book.id, c.id, -1)} disabled={i === 0} aria-label="上移节点">
                            ↑
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => moveChapter(book.id, c.id, 1)} disabled={i === book.chapters.length - 1} aria-label="下移节点">
                            ↓
                          </Button>
                        </div>
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

        {/* 折叠时的展开入口：桌面=左缘竖排把手；手机=横条按钮 */}
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
              <span className="min-w-0 flex-1 truncate font-medium">阅读路线 · {book.chapters.length} 个节点</span>
              <span className="shrink-0 text-xs text-ink-dim">
                {doneCount} 已读{masteredCount > 0 ? ` · ${masteredCount} 掌握` : ""}
              </span>
            </button>
          </>
        )}

        {/* ================= 中栏：AI 阅读空间 ================= */}
        <div className="min-w-0">
          {chapter && (
            <Card className="mb-4 border-accent/25">
              <Badge tone="accent">当前节点：{chapter.title}</Badge>
              <p className="mt-2 text-sm text-ink-dim">
                本章带着这个问题读：<b className="text-ink">{chapter.focusQuestion}</b>
              </p>
            </Card>
          )}

          {/* 手机/窄屏：学习状态折叠条（PRD：按需展开收起） */}
          <div className="mb-4 xl:hidden">
            <details className="rounded-2xl border border-border bg-white">
              <summary className="flex min-h-[44px] cursor-pointer items-center gap-2 px-3.5 py-2.5 text-[13px] text-ink">
                <BrainCircuit className="size-4 text-accent" />
                <span className="min-w-0 flex-1 truncate font-medium">
                  学习状态 · {book.goal ? READING_GOAL_LABELS[book.goal.primary].label : "未设目标"} · {doneCount}/{book.chapters.length} 节点
                </span>
                <Badge tone={READ_STATUS_META[readStatus].tone}>{READ_STATUS_META[readStatus].label}</Badge>
              </summary>
              <div className="border-t border-border p-3">{statusPanel}</div>
            </details>
          </div>

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
            {/* 思考轨迹：检索与思考阶段可见，完成后折叠为耗时摘要 */}
            <AgentTrace phases={phases} />
            <div ref={bottomRef} />
          </div>

          <div className="above-mobile-nav sticky mt-4">
            {/* AI 策略推荐（hybrid，PRD 4.4）：用户未锁定模式时展示，一键采用或忽略 */}
            {recommendedMeta && recommended && !book.chatMode && (
              <button
                onClick={() => {
                  updateBook(book.id, { chatMode: recommended.mode, modeJustSwitched: true });
                  toast(`已切到「${recommendedMeta.label}」`);
                }}
                className="mb-2 flex w-full cursor-pointer items-center gap-1.5 rounded-xl border border-accent/30 bg-accent/[0.04] px-3 py-2 text-left text-[11.5px] text-ink-dim transition hover:border-accent/50"
              >
                <Bot className="size-3.5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate">
                  AI 建议「<b className="text-accent">{recommendedMeta.label}</b>」——{recommended.reason}
                </span>
                <span className="shrink-0 text-accent">采用</span>
              </button>
            )}
            {/* 模式选择器：输入框左侧，点开弹出五模式菜单。切换即时生效 */}
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
                      对话模式 · 切换后下一句生效（你的选择优先于 AI 推荐）
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
                      未手动选择时，AI 会按节点与你的状态推荐。
                    </div>
                  </div>
                </>
              )}
            </div>
            {error && (
              <p className="mb-2 rounded-lg border border-bad/25 bg-bad/[0.05] px-3 py-2 text-xs leading-relaxed text-bad">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSend()}
                placeholder="说说你的理解、困惑，或反驳…"
                disabled={streaming}
              />
              {streaming && (
                <Button
                  variant="outline"
                  onClick={() => {
                    stop();
                    /* 主动取消不是失败：阶段标 cancelled */
                    setPhases((prev) =>
                      prev.map((x) => (x.state === "running" ? { ...x, state: "cancelled" } : x))
                    );
                  }}
                  className="h-11 shrink-0 sm:h-10"
                >
                  停止
                </Button>
              )}
              <Button onClick={doSend} loading={streaming} className="h-11 shrink-0 sm:h-10">
                发送
              </Button>
            </div>
          </div>
        </div>

        {/* ================= 右栏：学习状态面板（桌面） ================= */}
        {panelOpen && (
          <div className="hidden xl:block">
            <div className="sticky top-8 max-h-[calc(100dvh-140px)] overflow-y-auto pr-1">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-dim">学习状态</p>
                <button
                  onClick={() => setPanelOpen(false)}
                  title="收起状态面板"
                  aria-label="收起状态面板"
                  className="tap-target grid place-items-center rounded-md text-ink-dim/60 transition hover:text-ink cursor-pointer"
                >
                  <PanelLeftClose className="size-4" />
                </button>
              </div>
              {statusPanel}
            </div>
          </div>
        )}
      </div>
      {!panelOpen && (
        <button
          onClick={() => setPanelOpen(true)}
          className="fixed right-4 top-1/2 z-20 hidden -translate-y-1/2 flex-col items-center gap-1 rounded-l-xl border border-r-0 border-border bg-white px-1.5 py-4 text-[10px] text-ink-dim shadow-sm transition hover:text-ink cursor-pointer xl:flex"
        >
          <PanelLeftOpen className="size-4" />
          <span className="[writing-mode:vertical-rl] tracking-widest">学习状态</span>
        </button>
      )}

      {/* 节点小结（PRD 4.6）：以用户的话为主 */}
      <Modal open={!!recap} onClose={() => setRecap(null)} title="本节点小结">
        {recap && (
          <>
            <div className="max-h-[55vh] overflow-y-auto rounded-xl border border-border bg-surface-2/40 p-4">
              <Markdown text={recap.md} />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRecap(null)}>
                关闭
              </Button>
              <Button onClick={saveRecapToBrain}>
                <BookMarked className="size-4" /> 存入第二大脑
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* 让 AI 加节点（PRD 4.3） */}
      <Modal open={addNodeOpen} onClose={() => !addNodeBusy && setAddNodeOpen(false)} title="加一个节点">
        <p className="text-sm leading-relaxed text-ink-dim">
          说出你感兴趣的东西——教练会在书里找到能回应它的内容，编成一个可验收的节点。
        </p>
        <Input
          className="mt-3"
          placeholder="例如：书里怎么看待拖延？能不能讲讲它的实验方法？"
          value={addNodeInterest}
          onChange={(e) => setAddNodeInterest(e.target.value)}
          disabled={addNodeBusy}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setAddNodeOpen(false)} disabled={addNodeBusy}>
            取消
          </Button>
          <Button onClick={() => void addNodeByInterest()} loading={addNodeBusy}>
            生成节点
          </Button>
        </div>
      </Modal>
    </div>
  );
}
