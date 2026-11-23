"use client";
import { BookEvidenceGate } from "@/components/book-evidence-gate";

/* RAG trace 目前仅控制台诊断（见 doSend 内 [rag-trace]）；入库等 /api/track 白名单扩容后接 track() */

/* 阅读系统 V1.0（PRD 2026-11-05）三栏工作台：
 * 顶部=书籍认知概览（四区域，可收起）｜左侧=阅读路线（节点状态机+验收+沉淀）
 * 中间=AI 阅读空间（五模式+AI 策略推荐）｜右侧=学习状态面板（目标/理解状态/待解决/验收进度）
 * 布局原则（PRD 3.3）：界面按需展开收起，避免信息过载。 */

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Input, Modal, PageHeader, Skeleton, Textarea } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { PageBackBar } from "@/components/page-back-bar";
import { AgentTrace, type TracePhase } from "@/components/agent-trace";
import { useAppStore } from "@/lib/store";
import { useChat, useHydrated, capChatHistoryByBytes } from "@/lib/use-chat";
import { extractJson, insightsSchema, readingAddNodeSchema, readingAssessGenSchema, readingAssessGradeSchema, readingGoalSchema, readingGraduationSchema, readingPlanSchema, readingStrategySchema, readingTransferGenSchema, readingTransferGradeSchema, readingTransferRecheckGradeSchema, readingTransferRecheckSchema } from "@/lib/ai/client";
import { READING_MODES, defaultReadingMode, type ReadingMode } from "@/lib/ai/reading-modes";
import {
  ASSESS_KIND_LABELS,
  DEPOSIT_TYPE_LABELS,
  READING_GOAL_LABELS,
  TRANSFER_OUTCOME_LABELS,
  TRANSFER_VERDICT_LABELS,
  type AssessKind,
  type BookChapter,
  type BookReadStatus,
  type BookTransfer,
  type DepositType,
  type ReadingGoal,
  type ReadingGoalType,
} from "@/lib/types";
import { ragContext, wikiRetrieve } from "@/lib/rag";
import { alignAssessResults } from "@/lib/reading-assess";
import { retrieveEnhanced } from "@/lib/rag-pipeline";
import { trackReading } from "@/lib/track";
import { useSyncStatus, retryCloudSync } from "@/lib/auth-client";
import { cn, uid } from "@/lib/utils";
import { toast } from "sonner";
import {
  Bot, BookMarked, BrainCircuit, Check, ChevronDown, CircleHelp, GraduationCap,
  Layers, Lightbulb, MessagesSquare, PanelLeftClose, PanelLeftOpen, Plus, Route, ShieldCheck,
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

/* 验收四级判定的统一展示口径（升级 PRD 3.5）：ungradable = 无法判定（问题歧义/答非所问，
 * 责任在出题方、必须换题重考），不得压回「未过」把它与答错同等标红——
 * 结果卡、最近验收摘要共用这两份映射，避免再出现两处口径漂移。 */
type AssessLevel = "mastered" | "partial" | "not" | "ungradable";
const ASSESS_LEVEL_LABELS: Record<AssessLevel, string> = {
  mastered: "通过",
  partial: "部分",
  not: "未过",
  ungradable: "无法判定",
};
const ASSESS_LEVEL_STYLES: Record<AssessLevel, string> = {
  mastered: "border-ok/30 bg-ok/[0.05]",
  partial: "border-warn/30 bg-warn/[0.05]",
  /* 无法判定用 warn 色（题目歧义，非用户之过）；not 才是红色未过 */
  ungradable: "border-warn/30 bg-warn/[0.05]",
  not: "border-bad/25 bg-bad/[0.04]",
};

/* chatMode 在 store 里是 string：用守卫收敛，不用 as 断言掩盖脏值 */
const isReadingMode = (v: string | undefined): v is ReadingMode =>
  READING_MODES.some((m) => m.id === v);

export default function BookPage() {
  const { id } = useParams<{ id: string }>();
  const owner = useAppStore((s) => s._storeUserId);
  return <BookDetail key={`${owner ?? "local"}:${id}`} id={id} owner={owner} />;
}

type TransferDraft = { task: string; why?: string; answer: string };
type RecheckDraft = { transferId: string; task: string; answer: string };

function BookDetail({ id, owner }: { id: string; owner: string | null }) {
  const hydrated = useHydrated();
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
  const addBookTransfer = useAppStore((s) => s.addBookTransfer);
  const attachTransferRecheck = useAppStore((s) => s.attachTransferRecheck);
  const removeBookDeposit = useAppStore((s) => s.removeBookDeposit);
  const updateBookLearning = useAppStore((s) => s.updateBookLearning);
  const setBookReadStatus = useAppStore((s) => s.setBookReadStatus);

  const { messages, setMessages, pending, streaming, error, send, stop, isBusy } = useChat();
  const [input, setInput] = useState("");
  const [phases, setPhases] = useState<TracePhase[]>([]);
  const [currentChapterId, setCurrentChapter] = useState<string | null>(null);
  /* undefined = 用户尚未做展开/收起选择（跟当前节点）；null = 显式收起；string = 显式展开 */
  const [expandedId, setExpandedId] = useState<string | null | undefined>(undefined);
  const [extracting, setExtracting] = useState(false);
  /* 阅读路线（PRD 3.3）：手机默认收起，桌面默认展开 */
  const [planOpen, setPlanOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 1024
  );
  /* 学习状态面板（右栏，PRD 3.3）：桌面默认展开、可收起；手机并入折叠条 */
  const [panelOpen, setPanelOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 1280
  );
  /* 认知地图（顶部）：默认收起（PRD READ-01——地图按需展开，不挤占主要阅读区） */
  const [mapOpen, setMapOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  /* 云端快照尚未拉回时，「书不存在」是误导：新设备/新浏览器经书签或历史直达本页，
   * 本地仓还没有这本书，而 bootSync（认证探测后才异步发起）的云端拉取慢于探测，
   * 几秒后快照落地组件本会自愈——用户在这个窗口看到的却是终态错误，可能点「返回书架」离开。
   * 已登录且首轮同步未落定时先呈现「同步中」，失败（error/conflict）则给出重试入口。
   * bootSync 自带幂等去重（bootSyncRuns），与 useAutoPush 的并发调用互不冲突。 */
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const syncStatus = useSyncStatus((s) => s.status);
  useEffect(() => {
    if (!hydrated || book) return;
    let alive = true;
    void (async () => {
      const { useAuthStore, bootSync } = await import("@/lib/auth-client");
      if (!alive || useAppStore.getState().books.some((b) => b.id === id)) return;
      if (!useAuthStore.getState().user) return; // 未登录：本地仓就是全部真相，书不存在是真
      setCloudSyncing(true);
      try { await bootSync(); } catch { /* 失败态由 useSyncStatus 呈现 */ }
      if (alive) setCloudSyncing(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, book?.id]);
  /* RAG 检索链路的中止器：useChat 的卸载 abort 管不到 send 之前的检索，
   * 卸载时不掐掉就是两次孤儿模型调用（改写+精排）。 */
  const ragAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => ragAbortRef.current?.abort(), []);
  /* 检索在飞标记：streaming 只覆盖 send 之后的模型流，send 之前的 RAG 检索
   * （预算可长达 20s，rag-pipeline）期间输入框未禁——旧实现此时再发一轮会把
   * 上一轮检索 abort 掉，上一条提问在 aborted 检查处静默退出：既不落库也不上屏，
   * 用户输入就此消失。检索期间不接收新一轮（发送按钮同步禁用给出可见反馈）。 */
  const [retrieving, setRetrieving] = useState(false);

  /* ---- 目标（PRD 4.1）---- */
  const [goalEditing, setGoalEditing] = useState(false);
  const [goalPrimary, setGoalPrimary] = useState<ReadingGoalType | null>(null);
  const [goalSecondary, setGoalSecondary] = useState<ReadingGoalType[]>([]);
  const [goalIntent, setGoalIntent] = useState("");
  const [goalBackground, setGoalBackground] = useState("");
  const [goalAiBusy, setGoalAiBusy] = useState(false);
  /* 编辑器里的目标是否来自 AI 推断的默认值（goal_confirmed 埋点的 inferred 语义）。
   * ref 而非 state：不参与渲染。打开编辑器时继承 book.goal.inferred（旧目标仍是推断值），
   * AI 推荐成功置 true，用户手动改任何字段置 false——「确认的是否为推断默认值」以
   * 提交那一刻编辑器的来源为准，避免埋点常量 false 让漏斗分析误读。 */
  const goalFromAiRef = useRef(false);

  /* ---- 三重验收（PRD 4.5）：按目标生成三题 → 作答 → 证据化判分 ---- */
  const [assess, setAssess] = useState<{ chapterId: string; questions: { kind: AssessKind; question: string }[]; answers: string[] } | null>(null);
  const [assessBusy, setAssessBusy] = useState(false);
  const [assessResult, setAssessResult] = useState<{ results: { kind: AssessKind; level: "mastered" | "partial" | "not" | "ungradable"; evidence: string; feedback: string }[]; suggestion?: string; chapterId: string } | null>(null);
  /* 升级 PRD 2.5 知识迁移：任务 → 独立作答 → 判定（区分会用/只会说） */
  const [transfer, setTransfer] = useState<TransferDraft | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferResult, setTransferResult] = useState<{ verdict: "used_correct" | "used_wrong" | "naming_only"; evidence: string; feedback: string; nextStep?: string } | null>(null);
  const [lastTransferId, setLastTransferId] = useState<string | null>(null);
  /* 升级 PRD 3.6 整本结业 */
  const [graduation, setGraduation] = useState<{ md: string; nextSteps: string[] } | null>(null);
  const [graduationBusy, setGraduationBusy] = useState(false);
  /* v26.1：学习会话 id（埋点关联）+ 迁移过程态（提示/复检）+ 流失问卷轻条 */
  const [sid] = useState(() => uid("rs"));
  const [hintShown, setHintShown] = useState(false);
  const [recheck, setRecheck] = useState<RecheckDraft | null>(null);
  const [recheckBusy, setRecheckBusy] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const practiceRef = useRef<HTMLDivElement>(null);
  const practiceKey = `mentora-reading-practice:${owner ?? "local"}:${id}`;
  useEffect(() => {
    if (!hydrated) return;
    const frame = requestAnimationFrame(() => {
      try {
        const draft = JSON.parse(localStorage.getItem(practiceKey) ?? "null") as {
          transfer?: TransferDraft; recheck?: RecheckDraft; hintShown?: boolean;
          assess?: { chapterId: string; questions: { kind: AssessKind; question: string }[]; answers: string[] };
        } | null;
        if (draft?.transfer) setTransfer(draft.transfer);
        if (draft?.recheck) {
          setRecheck(draft.recheck);
          setLastTransferId(draft.recheck.transferId);
        }
        setHintShown(draft?.hintShown === true);
        /* 三重验收作答同样持久化：三段 Textarea 写完误触返回/刷新即丢、只能对照可复用的
         * 题目重写——与 transfer/recheck 同等待遇。指向已不存在章节（路线重排换 id）的
         * 僵尸草稿不恢复，避免占位且无法提交。 */
        if (draft?.assess) {
          const chapterExists = useAppStore.getState().books
            .find((b) => b.id === id)?.chapters.some((c) => c.id === draft.assess!.chapterId);
          if (chapterExists) setAssess(draft.assess);
        }
      } catch { /* A missing or unavailable draft leaves the practice panel empty. */ }
      setDraftLoaded(true);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, practiceKey]);
  useEffect(() => {
    if (!draftLoaded) return;
    try {
      if (transfer || recheck || assess) localStorage.setItem(practiceKey, JSON.stringify({ transfer, recheck, hintShown, assess }));
      else localStorage.removeItem(practiceKey);
    } catch { /* The in-page draft remains available. */ }
  }, [draftLoaded, practiceKey, transfer, recheck, hintShown, assess]);
  const scrollToPractice = () => requestAnimationFrame(() => practiceRef.current?.scrollIntoView({ block: "start" }));
  const [exitSurvey, setExitSurvey] = useState(false);
  const [exitReason, setExitReason] = useState<string>("");
  useEffect(() => {
    try {
      sessionStorage.setItem(`reading-sid-${id}`, sid);
    } catch {
      /* 隐私模式忽略 */
    }
  }, [id, sid]);

  /* ---- 沉淀（PRD 4.6）---- */
  const [depositType, setDepositType] = useState<DepositType>("explanation");
  const [depositText, setDepositText] = useState("");
  /* ---- 节点小结 ---- */
  const [recap, setRecap] = useState<{ chapterId: string; md: string } | null>(null);
  const [recapBusy, setRecapBusy] = useState(false);
  /* ---- 路线重生成 / 加节点 ---- */
  const [regenBusy, setRegenBusy] = useState(false);
  const [routeMenuOpen, setRouteMenuOpen] = useState(false);
  /* 两个弹出菜单（路线选项/对话模式）的 Esc 关闭：与设计系统为对话框确立的基线一致
   * （ui.tsx Modal 无障碍补齐含 Esc）。两个菜单共用一个监听，挂载期才生效。 */
  useEffect(() => {
    if (!routeMenuOpen && !modeMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setRouteMenuOpen(false);
        setModeMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [routeMenuOpen, modeMenuOpen]);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [addNodeInterest, setAddNodeInterest] = useState("");
  const [addNodeBusy, setAddNodeBusy] = useState(false);
  /* ---- 待解决问题快速添加（右栏）---- */
  const [questionDraft, setQuestionDraft] = useState("");
  /* AI 策略推荐：每节点只调一次 */
  const strategyTried = useRef<Set<string>>(new Set());

  /* 自动滚到底：只在新增消息时做平滑滚动（流式期间 pending 每 token 变一次，
   * 若把它放进依赖会每 token 触发一次 smooth scrollIntoView，反复重启动画并叠加
   * Markdown 重排，低端机明显卡顿）。流式增量用 rAF 合并成每帧一次即时滚动跟随。 */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);
  useEffect(() => {
    if (!pending) return;
    const rid = requestAnimationFrame(() => bottomRef.current?.scrollIntoView());
    return () => cancelAnimationFrame(rid);
  }, [pending]);

  /* 恢复该书的历史对话。以「书 id + 条数 + 末条 id」为签名，而不是一次性置位：
   * 云端 bootSync / 多标签 adopt 会用整份快照替换 books（store.ts importData:books=clean.books??s.books、
   * adopt:st.books??cur.books），此时 book.id 不变但 chat 可能更新——旧实现只在首次挂载恢复，
   * 晚到的对话永远补不上，注释宣称的「云端数据晚到时补挂」实际只覆盖「书籍本身晚到」。
   * 本页正在流式输出、或已有比 store 更长的本地会话时不回灌，避免盖掉在途对话。 */
  const restoredChatSig = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated || !book) return;
    const chat = book.chat;
    const sig = `${book.id}:${chat.length}:${chat[chat.length - 1]?.id ?? ""}`;
    if (restoredChatSig.current === sig) return;
    if (streaming || messages.length > chat.length) return;
    restoredChatSig.current = sig;
    if (chat.length > 0) setMessages(chat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, book?.id, book?.chat, streaming]);

  /* 阅读状态机起点：进页即"阅读中"（未开始→阅读中） */
  useEffect(() => {
    if (!hydrated || !book) return;
    const rs: BookReadStatus = book.readStatus ?? (book.status === "done" ? "finished" : book.status === "reading" ? "reading" : "unread");
    if (rs === "unread") {
      trackReading("reading_started", { bookId: book.id, source: "first_open" });
      setBookReadStatus(book.id, "reading");
    }
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
    ? `主目标 ${READING_GOAL_LABELS[book.goal.primary].label}${book.goal.secondary?.length ? `（次目标 ${book.goal.secondary.map((g) => READING_GOAL_LABELS[g].label).join("、")}）` : ""}${book.goal.intent ? `，想解决：${book.goal.intent}` : ""}${book.goal.background ? `；已有基础：${book.goal.background}` : ""}`
    : "未设定";

  /* AI 策略推荐（PRD 4.4）：进节点时一次，cheap 任务，失败静默（知识类型默认兜底）。
   * 用户锁定了模式就不打扰（用户选择 > 系统推荐）。
   * ⚠️ 必须放在所有提前 return 之前——hook 顺序在渲染间不能变（v10.4 血泪教训）。 */
  useEffect(() => {
    if (!hydrated || !book || !chapter) return;
    if (book.verification !== "verified" && !(book.verification === "user_material" && book.pastedText?.trim())) return;
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
            background: book.goal?.background ?? "",
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

  if (hydrated && book && book.verification !== "verified" && !(book.verification === "user_material" && book.pastedText?.trim())) return <BookEvidenceGate book={book} />;
  if (!hydrated) {
    /* 水合骨架形状对齐真实工作台（返回栏 + 标题卡 + 三栏），加载完成布局不跳动；
     * 旧实现只有一块 h-40 灰条，水合完成整页展开、且慢网下数秒无任何可导航上下文
     * （ui.tsx Skeleton 规则：形状必须匹配真实内容）。 */
    return (
      <div>
        <Skeleton className="h-9 rounded-lg bg-surface/60" />
        <Skeleton className="mt-4 h-24 rounded-2xl bg-surface/60" />
        <div className="mt-6 grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_290px]">
          <Skeleton className="hidden h-96 rounded-2xl bg-surface/60 lg:block" />
          <div className="space-y-4">
            <Skeleton className="h-20 rounded-2xl bg-surface/60" />
            <Skeleton className="h-72 rounded-2xl bg-surface/60" />
          </div>
          <Skeleton className="hidden h-96 rounded-2xl bg-surface/60 xl:block" />
        </div>
      </div>
    );
  }
  if (!book) {
    /* 云端首轮同步还没落定：不是「不存在」，是「还没到」。给同步中骨架，别把用户推走。 */
    if (cloudSyncing) {
      return (
        <div className="py-20 text-center text-ink-dim">
          <p className="flex items-center justify-center gap-2 text-sm">
            <span className="size-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            正在从云端同步这本书…
          </p>
        </div>
      );
    }
    return (
      <div className="py-20 text-center text-ink-dim">
        书不存在。
        {syncStatus === "error" && (
          <p className="mt-3 text-xs">
            云端同步失败了——这本书可能还没拉回来。
            <Button variant="outline" className="ml-3" onClick={() => void retryCloudSync()}>
              重试同步
            </Button>
          </p>
        )}
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
        materialScope: book.verification === "user_material" ? "此条仅为用户提供的片段，依据 pastedExcerpt 回答。不要推断材料之外的书目、作者或章节" : undefined,
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

  const doSend = () => sendReadingQuestion(input.trim());

  const unanswered = book.chat.at(-1);
  const sendReadingQuestion = (text: string, retry = false) => {
    if (!text || streaming || retrieving || isBusy() || ragAbortRef.current) return;
    const rac = new AbortController();
    ragAbortRef.current = rac;
    const store = useAppStore.getState();
    const account = store._storeUserId;
    const storedBook = store.books.find((item) => item.id === book.id);
    if (!storedBook) {
      ragAbortRef.current = null;
      return;
    }
    /* 长聊书防 413：BOOK_CHAT_MAX=300 只限条数不限字节，整份 chat 原样发会把请求体
     * 顶过 /api/chat 的 1MB 硬闸（route.ts readTextBodyWithLimit），此后每轮发送与
     * 「继续回答」重试都固定失败且无恢复入口。按字节从最新往回裁剪，本地消息不受影响。 */
    let history = capChatHistoryByBytes(storedBook.chat);
    if (!retry) {
      const user = { id: uid("m"), role: "user" as const, content: text, at: new Date().toISOString() };
      setInput("");
      addBookMsg(book.id, user);
      history = [...history, user];
      setMessages(history);
    }
    setRetrieving(true);
    void (async () => {
      const t0 = performance.now();
      setPhases([{ label: "查找相关笔记", state: "running" }]);
      const notes = useAppStore
        .getState()
        .knowledge.filter((k) => !(k.tags ?? []).includes("MOC"))
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
          { context: `${chapter?.focusQuestion ?? ""} ${chapter?.coreIdea ?? ""}`.trim(), signal: rac.signal }
        );
        if (process.env.NODE_ENV !== "production") {
          /* 诊断用：trace.rewriteQueries 由用户原话改写而来，不得随生产构建输出到用户控制台 */
          console.info("[rag-trace]", { task: "reading-chat", ...enhanced.trace });
        }
        ragCtx = enhanced.context;
      } catch {
        ragCtx = ragContext(
          wikiRetrieve(
            `${text} ${chapter?.focusQuestion ?? ""} ${chapter?.coreIdea ?? ""}`,
            notes,
            3
          )
        );
      }
      if (rac.signal.aborted || useAppStore.getState()._storeUserId !== account) return;
      const t1 = performance.now();
      setPhases([
        {
          label: "查找相关笔记",
          state: "done",
          durationMs: t1 - t0,
          detail: ragCtx ? "已找到可参考的笔记" : undefined,
        },
        { label: "思考回答", state: "running" },
      ]);
      const p = send({
        args: { bookCtx: bookCtx(), ragCtx, mode: activeMode, modeSwitch: book.modeJustSwitched === true },
        history,
        task: "reading-chat",
        onDone: (full) => {
          if (!full.trim() || rac.signal.aborted || useAppStore.getState()._storeUserId !== account) return;
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
    }).finally(() => {
      if (ragAbortRef.current === rac) ragAbortRef.current = null;
      setRetrieving(false);
    });
  };

  /* ================= 目标管理（PRD 4.1） ================= */

  const openGoalEditor = () => {
    setGoalPrimary(book.goal?.primary ?? null);
    setGoalSecondary(book.goal?.secondary ?? []);
    setGoalIntent(book.goal?.intent ?? "");
    setGoalBackground(book.goal?.background ?? "");
    /* 表单初值继承自 book.goal：旧目标本身就是推断默认值时，原样确认仍算 inferred */
    goalFromAiRef.current = !!book.goal?.inferred;
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
      background: goalBackground.trim() || undefined,
      /* inferred 随保存路径写入：埋点与 goal.inferred（1298 行「AI 推断的默认目标」提示）共用一个真相 */
      inferred: goalFromAiRef.current,
      setAt: new Date().toISOString(),
    };
    const changed = book.goal?.primary !== goal.primary;
    trackReading("goal_confirmed", { bookId: book.id, goal: goal.primary, inferred: goal.inferred === true });
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
      goalFromAiRef.current = true;
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
          materialOnly: book.verification === "user_material",
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
      /* 与 agent 路径（tool-executors.ts rebuild_reading_route 2228-2230）同纪律：先快照
       * 旧路线再写入。regenerateBookRoute 会给新章节全换新 id、旧 chapters 整组丢弃，
       * 不快照则 routeHistory 里没有旧路线，restore_book_route 无法回滚这次手动重排——
       * 同一功能两条入口行为不一致，agent 侧还向用户承诺「旧路线已存入历史（可恢复）」。 */
      useAppStore.getState().snapshotBookRoute(
        book.id,
        `手动重排为${routeType === "full" ? "完整" : routeType === "core" ? "核心" : "目标导向"}路线`
      );
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
      trackReading("roadmap_generated", { bookId: book.id, routeType, nodes: plan.chapters.length, source: "regenerate" });
      toast.success(`路线已按「${routeType === "full" ? "完整" : routeType === "core" ? "核心" : "目标导向"}」重排。旧路线已存入历史（可恢复）；历史验收与沉淀都在。`);
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
      /* 写回前重读最新 books：本调用要等 10-60s 的 LLM，等待期间云端 bootSync /
       * 多标签 adopt 会整份替换 books（本页 222-226 行注释自认），渲染闭包里的
       * book.chapters 是发起请求那次的快照——用它整组写回会把等待期间其他来源
       * 带来的章节变更（新增/移动/状态推进）静默回滚。sendReadingQuestion 已有
       * 先重读的先例（384-389 行），agent 路径更有 EX-15 签名冲突检测；手动路径
       * 至少做到不拿旧数组覆盖新数据。书已不存在则如实报错、不写入。 */
      const cur = useAppStore.getState().books.find((b) => b.id === book.id);
      if (!cur) {
        toast.error("书已不存在（可能已在别处删除），本次加的节点没有写入。");
        return;
      }
      updateBook(book.id, { chapters: [...cur.chapters, node] });
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
    /* assess 是全局单份 state：在别的节点已有未提交作答时出题会整体覆盖，作答无声丢失。
     * 覆盖前明确确认（跨节点点击「开始验收」是常见误触路径）。 */
    if (assess && assess.chapterId !== c.id && assess.answers.some((a) => a.trim())) {
      if (!confirm("你在另一个节点还有没提交的验收作答，开始新验收会丢掉它。继续？")) return;
    }
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
      /* 判分结果与出题逐题按 kind 对齐（见 lib/reading-assess.ts：schema 只保证 ≥1 条、
       * 不校验数量/顺序，直接 slice 会让少回/错序扭曲通过阈值并张冠李戴）。
       * 对齐后长度恒等于题数，下面 passed 的 max(2, ceil(n*0.66)) 即保持三题 2/3 口径。 */
      const results = alignAssessResults(assess.questions, parsed.results);
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
      /* 升级 PRD 3.5：ungradable 不计入通过——「无法判定」必须换题重考 */
      const hasUngradable = results.some((r) => r.level === "ungradable");
      const passed = !hasNot && !hasUngradable && masteredN >= Math.max(2, Math.ceil(results.length * 0.66));
      setAssessResult({ chapterId: c.id, results, suggestion: parsed.suggestion || undefined });
      setAssess(null);
      /* 升级 PRD 2.4 误解接线：判分器提取的误解落档；节点通过 = 同概念误解澄清 */
      if (parsed.misconception?.concept) {
        updateBookLearning(book.id, {
          addMisconception: { concept: parsed.misconception.concept, note: parsed.misconception.note },
        });
      }
      if (passed) {
        markChapterMastered(book.id, c.id, results.map((r) => r.feedback).join(" "));
        if (parsed.misconception?.concept) updateBookLearning(book.id, { clarifyMisconception: parsed.misconception.concept });
        if ((c.keyConcepts ?? []).length) updateBookLearning(book.id, { knownConcepts: c.keyConcepts });
        toast.success(`验收通过（${masteredN}/${results.length} 要害命中）——这个节点算掌握了。`);
      } else if (hasUngradable) {
        toast("有一题无法判定（问题歧义或答非所问）——换个问法再考一次。");
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
    /* useChat 的并发守卫（busyRef）会让流式期间的第二条 send 静默返回 ""——补课消息
     * 会写进 store 但不上屏、等不到回复（刷新才凭空出现），setInput("") 还会清掉用户草稿。
     * 与 doSend 的 `if (!text || streaming) return` 同口径：先拦住并给出提示。 */
    if (streaming || retrieving) {
      toast("等这一轮回答完再帮你补课。");
      return;
    }
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

  /* ================= 知识迁移（升级 PRD 2.5）：目标驱动的真实场景应用 ================= */

  const masteredNodes = book.chapters.filter((c) => c.masteredAt);

  const genTransfer = async () => {
    if (transfer || recheck) {
      scrollToPractice();
      return;
    }
    if (transferBusy || masteredNodes.length === 0) return;
    setTransferBusy(true);
    /* 不在开头清 transferResult：那会让迁移卡片整卡卸载，三个入口按钮的 loading 随卡消失、
     * 生成期间页面像没反应。生成成功后再由 setTransfer 顶上新任务（旧结果自然被替换）。 */
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const full = await streamChat({
        task: "reading-transfer-gen",
        args: {
          book: book.title,
          goal: goalText,
          chapters: JSON.stringify(
            masteredNodes.map((c) => ({ id: c.id, title: c.title, keyConcepts: c.keyConcepts ?? [], coreIdea: c.coreIdea ?? "" }))
          ),
          learning: JSON.stringify({
            misconceptions: (book.learning?.misconceptions ?? []).filter((m) => !m.clarified).slice(0, 5),
            unresolvedQuestions: (book.learning?.unresolvedQuestions ?? []).slice(0, 5),
          }),
          pastTransfers: JSON.stringify((book.transfers ?? []).slice(0, 5).map((t) => ({ task: t.task, verdict: t.verdict }))),
        },
        messages: [{ role: "user", content: "出迁移任务。" }],
        temperature: 0.5,
        onDelta: () => {},
      });
      const parsed = readingTransferGenSchema.parse(extractJson(full));
      setTransferResult(null);
      setTransfer({ task: parsed.task, why: parsed.whyThisTask || undefined, answer: "" });
      setHintShown(false);
      scrollToPractice();
      trackReading("transfer_started", { bookId: book.id, source: "panel" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "出任务失败，稍后再试。");
    } finally {
      setTransferBusy(false);
    }
  };

  const submitTransfer = async () => {
    if (!transfer || transferBusy) return;
    if (!transfer.answer.trim()) {
      toast.error("先写下你的应用方案——空着没法判定。");
      return;
    }
    setTransferBusy(true);
    trackReading("transfer_submitted", { bookId: book.id, mode: hintShown ? "assisted" : "independent", chars: transfer.answer.length });
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const full = await streamChat({
        task: "reading-transfer-grade",
        args: {
          book: book.title,
          task: transfer.task,
          chapters: JSON.stringify(
            masteredNodes.map((c) => ({ title: c.title, keyConcepts: c.keyConcepts ?? [], assessFocus: c.assessFocus ?? "" }))
          ),
          answer: transfer.answer,
        },
        messages: [{ role: "user", content: "判定。" }],
        temperature: 0.2,
        onDelta: () => {},
      });
      const parsed = readingTransferGradeSchema.parse(extractJson(full));
      const result = {
        verdict: parsed.verdict,
        evidence: parsed.evidence ?? "",
        feedback: parsed.feedback ?? "",
        nextStep: parsed.nextStep || undefined,
      };
      const transferId = addBookTransfer(book.id, {
        chapterIds: masteredNodes.map((c) => c.id),
        task: transfer.task,
        answer: transfer.answer,
        verdict: parsed.verdict,
        evidence: result.evidence,
        feedback: result.feedback,
        mode: hintShown ? "assisted" : "independent",
        hintUsed: hintShown,
      });
      setTransferResult(result);
      setLastTransferId(transferId);
      setTransfer(null);
      toast(result.verdict === "used_correct" ? "迁移通过——这个概念现在是你的了。" : result.verdict === "used_wrong" ? "用到了但机制有偏——看反馈里错在哪一步。" : "还在复述概念——按引导把概念接到场景上。");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "判定失败——答案还在，可重交。");
    } finally {
      setTransferBusy(false);
    }
  };

  /** v26.1 G3：独立迁移复检——同概念换场景，assisted 不得计 independent */
  const openPracticeResult = (original: BookTransfer) => {
    if (transfer || recheck) { scrollToPractice(); return; }
    setLastTransferId(original.id);
    setTransferResult({ verdict: original.verdict, evidence: original.evidence, feedback: original.feedback });
    scrollToPractice();
  };

  const genRecheck = async (transferId: string) => {
    if (transfer || recheck) { scrollToPractice(); return; }
    if (recheckBusy || transferBusy) return;
    const original = (book.transfers ?? []).find((t) => t.id === transferId);
    if (!original || original.recheck || original.verdict !== "used_correct" || original.hintUsed || original.mode === "assisted") return;
    openPracticeResult(original);
    setRecheckBusy(true);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const full = await streamChat({
        task: "reading-transfer-recheck",
        args: {
          book: book.title,
          originalTask: original?.task ?? "",
          chapters: JSON.stringify(book.chapters.filter((c) => original.chapterIds.includes(c.id)).map((c) => ({ title: c.title, keyConcepts: c.keyConcepts ?? [] }))),
          goal: goalText,
        },
        messages: [{ role: "user", content: "出复检题。" }],
        temperature: 0.5,
        onDelta: () => {},
      });
      const parsed = readingTransferRecheckSchema.parse(extractJson(full));
      setRecheck({ transferId, task: parsed.task, answer: "" });
      scrollToPractice();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "复检出题失败");
    } finally {
      setRecheckBusy(false);
    }
  };

  const submitRecheck = async () => {
    if (!recheck || recheckBusy) return;
    if (!recheck.answer.trim()) {
      toast.error("先写下你的独立作答——空着没法判定。");
      return;
    }
    const original = book.transfers?.find((t) => t.id === recheck.transferId);
    if (!original) {
      toast.error("原迁移记录暂不可用，作答已保留在本机。");
      return;
    }
    setRecheckBusy(true);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const full = await streamChat({
        task: "reading-transfer-recheck-grade",
        args: {
          task: recheck.task,
          chapters: JSON.stringify(book.chapters.filter((c) => original.chapterIds.includes(c.id)).map((c) => ({ title: c.title, keyConcepts: c.keyConcepts ?? [] }))),
          answer: recheck.answer,
        },
        messages: [{ role: "user", content: "复检判定。" }],
        temperature: 0.2,
        onDelta: () => {},
      });
      const parsed = readingTransferRecheckGradeSchema.parse(extractJson(full));
      attachTransferRecheck(book.id, recheck.transferId, {
        task: recheck.task,
        answer: recheck.answer,
        verdict: parsed.verdict,
        evidence: parsed.evidence ?? "",
        feedback: parsed.feedback ?? undefined,
        at: new Date().toISOString(),
      });
      setTransferResult({
        verdict: original.verdict,
        evidence: original.evidence,
        feedback: original.feedback,
      });
      setRecheck(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "复检判定失败");
    } finally {
      setRecheckBusy(false);
    }
  };

  const activeTransferRecord = book.transfers?.find((item) => item.id === lastTransferId);
  const canRecheck = activeTransferRecord?.verdict === "used_correct" &&
    !activeTransferRecord.hintUsed && activeTransferRecord.mode !== "assisted" && !activeTransferRecord.recheck;

  /* ================= 整本结业（升级 PRD 3.6） ================= */

  const genGraduation = async () => {
    if (graduationBusy) return;
    setGraduationBusy(true);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const full = await streamChat({
        task: "reading-graduation",
        args: {
          book: book.title,
          goal: goalText,
          map: JSON.stringify(map ?? {}),
          stats: JSON.stringify({
            nodes: book.chapters.length,
            done: doneCount,
            mastered: masteredCount,
            assessments: (book.assessments ?? []).length,
            partialOrNot: (book.assessments ?? []).filter((a) => a.level === "partial" || a.level === "not").length,
          }),
          transfers: JSON.stringify((book.transfers ?? []).slice(0, 5)),
          deposits: JSON.stringify((book.deposits ?? []).slice(0, 15).map((d) => ({ type: DEPOSIT_TYPE_LABELS[d.type], text: d.text }))),
        },
        messages: [{ role: "user", content: "生成结业总结。" }],
        temperature: 0.3,
        onDelta: () => {},
      });
      const parsed = readingGraduationSchema.parse(extractJson(full));
      setGraduation({ md: parsed.noteMarkdown, nextSteps: parsed.nextSteps ?? [] });
      trackReading("graduation_generated", { bookId: book.id });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "结业总结生成失败");
    } finally {
      setGraduationBusy(false);
    }
  };

  const saveGraduationToBrain = () => {
    if (!graduation) return;
    addKnowledge(
      [{ title: `《${book.title}》· 结业`, body: graduation.md, domain: book.title }],
      "read",
      `《${book.title}》`
    );
    toast.success("结业笔记已入第二大脑，将进入复习队列。");
    setGraduation(null);
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
          <p className="mt-1 text-xs text-ink-dim">目标决定路线怎么排、用什么方式教、验收考什么。主目标必选，可加次目标；点目标卡右上「设为主目标」随时更换。</p>
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
            <div key={g} className="relative">
              <button
                onClick={() => {
                  /* 交互约定：第一个点的是主目标；已有主目标时再点其他目标 = 加为次目标；
                   * 点已选的次目标 = 取消。换主目标走右上「设为主目标」（见下方按钮）。 */
                  goalFromAiRef.current = false; // 用户手动改动：不再是 AI 推断的默认值
                  if (primary) return;
                  if (secondary) {
                    setGoalSecondary((p) => p.filter((x) => x !== g));
                    return;
                  }
                  if (goalPrimary) setGoalSecondary((p) => (p.includes(g) ? p : [...p, g]));
                  else setGoalPrimary(g);
                }}
                className={cn(
                  "w-full rounded-xl border p-3 text-left transition cursor-pointer",
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
              {/* 重设主目标：旧状态机只有「设主/加次/取消」三分支，主目标一经保存
                  在编辑器里永远不可更换（openGoalEditor 每次都用 book.goal.primary 预填），
                  saveGoal 的 changed 恒 false、按新目标重排的提示永不出现——与卡片文案
                  「之后随时改」直接矛盾。原主目标降为次目标（保留勾选），新主从次目标移除。 */}
              {goalPrimary && !primary && (
                <button
                  type="button"
                  onClick={() => {
                    if (!goalPrimary) return;
                    goalFromAiRef.current = false; // 用户手动换主目标
                    setGoalSecondary((p) => [...new Set([...p.filter((x) => x !== g), goalPrimary])]);
                    setGoalPrimary(g);
                  }}
                  className="absolute right-2 top-2 z-10 cursor-pointer rounded-md bg-white/90 px-1.5 py-0.5 text-[10px] text-ink-dim transition hover:text-accent"
                >
                  设为主目标
                </button>
              )}
            </div>
          );
        })}
      </div>
      <Input
        className="mt-3"
        placeholder="你想用这本书解决什么问题？（可选，一句话）"
        value={goalIntent}
        onChange={(e) => { goalFromAiRef.current = false; setGoalIntent(e.target.value); }}
      />
      <Input
        className="mt-2"
        placeholder="你已经有哪些相关基础？（可选——读过什么/做过什么，教练不会重复讲你懂的）"
        value={goalBackground}
        onChange={(e) => { goalFromAiRef.current = false; setGoalBackground(e.target.value); }}
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
        aria-expanded={mapOpen}
        aria-label="展开或收起认知地图"
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
            <p className="text-[10.5px] text-ink-dim/70">AI 记下的易混点（来自你的验收作答；补上就走）：</p>
            {book.learning!.misconceptions.slice(0, 4).map((m, i) => (
              <p
                key={i}
                className={cn(
                  "rounded-lg px-2 py-1.5 text-[11px] leading-relaxed",
                  m.clarified ? "bg-ok/[0.06] text-ink-dim/70" : "bg-warn/[0.06] text-ink-dim"
                )}
              >
                <b className={m.clarified ? "text-ok" : "text-ink/80"}>{m.concept}</b>：{m.note}
                {m.clarified && <span className="ml-1 rounded-full bg-ok/10 px-1.5 text-[9.5px] text-ok">已澄清</span>}
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
            {/* 快速添加与节点沉淀都是双写（unresolvedQuestions + deposits type=unresolved），
                同一条问题会在两个来源里各存一份——合并去重后只显示一行，别再分别渲染两份。
                unresolvedQuestions 是喂给 AI 的权威清单（bookCtx），排前；deposits 里只补
                不在清单里的旧数据。 */}
            {[
              ...new Set([
                ...(book.learning?.unresolvedQuestions ?? []),
                ...(book.deposits ?? []).filter((d) => d.type === "unresolved").map((d) => d.text),
              ]),
            ]
              .slice(0, 5)
              .map((q, i) => (
                <li key={`uq-${i}`} className="text-[11.5px] leading-relaxed text-ink-dim">· {q}</li>
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
              /* isComposing：中文输入法选词回车不算提交 */
              if (e.key === "Enter" && !e.nativeEvent.isComposing && questionDraft.trim()) {
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
            return `最近验收：${ASSESS_KIND_LABELS[last.kind]} · ${ASSESS_LEVEL_LABELS[last.level]}`;
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
              <Button size="sm" className="w-full" onClick={() => { trackReading("book_assessment_completed", { bookId: book.id, result: "mastered" }); setBookReadStatus(book.id, "mastered"); }}>
                <GraduationCap className="size-3.5" /> 复盘完成，标记已掌握
              </Button>
              <p className="text-[10.5px] leading-relaxed text-ink-dim/70">诚实原则：只在你能独立讲清这本书时点它。</p>
            </>
          )}
          {/* 迁移应用：有任一已掌握节点即可做（升级 PRD 2.5——不必等整本读完） */}
          {masteredCount > 0 && (
            <Button variant="outline" size="sm" className="w-full" onClick={() => void genTransfer()} loading={transferBusy} disabled={!draftLoaded || recheckBusy}>
              <Route className="size-3.5" /> {recheck ? "继续独立复验草稿" : transfer ? "继续迁移作答" : "迁移应用：用到你的真实问题"}
            </Button>
          )}
          {readStatus === "mastered" && (
            <>
              <p className="text-[11px] leading-relaxed text-ink-dim">
                {masteredCount > 0
                  ? "这本书你已验收掌握，可以生成结业总结存进第二大脑。"
                  : "通过任一阅读节点的验收后，即可做迁移应用。"}
              </p>
              <Button size="sm" className="w-full" onClick={() => void genGraduation()} loading={graduationBusy}>
                <GraduationCap className="size-3.5" /> 生成结业总结
              </Button>
            </>
          )}
          {readStatus === "unread" && (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setBookReadStatus(book.id, "reading")}>
              开始读
            </Button>
          )}
        </div>
        {/* 迁移历史（升级 PRD 2.5 第 5 步：记录应用结果） */}
        {(book.transfers ?? []).length > 0 && (
          <div className="mt-3 border-t border-border pt-2.5">
            <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-dim/70">
              迁移记录 {book.transfers!.length} 次
            </p>
            <div className="mt-1.5 space-y-1">
              {book.transfers!.map((t) => (
                <div key={t.id} className="rounded-lg bg-surface-2 px-2 py-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={t.verdict === "used_correct" ? "ok" : t.verdict === "used_wrong" ? "warn" : "default"}>
                      {t.recheck ? TRANSFER_OUTCOME_LABELS[t.recheck.verdict] : TRANSFER_VERDICT_LABELS[t.verdict]}
                    </Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-ink-dim">{t.task}</p>
                  <Button variant="ghost" size="sm" className="mt-1 min-h-9 px-1 text-xs" disabled={!draftLoaded || transferBusy || recheckBusy}
                    onClick={() => t.verdict === "used_correct" && !t.hintUsed && t.mode !== "assisted" && !t.recheck
                      ? void genRecheck(t.id) : openPracticeResult(t)}>
                    {t.recheck ? "查看独立复验" : t.verdict === "used_correct" && !t.hintUsed && t.mode !== "assisted" ? "继续独立复验" : "查看迁移结果"}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div>
      <PageBackBar title={`《${book.title}》`} parentLabel="书架" parentHref="/learn?tab=read" />

      <PageHeader
        title={`《${book.title}》`}
        desc={book.author}
        right={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* V26.2-H2：书籍核查状态如实标注（PRD §5.5——材料生成 ≠ 已核实完整书目） */}
            {book.verification === "user_material" && <Badge tone="warn">基于你的材料</Badge>}
            {book.verification === "unverified" && <Badge tone="warn">未经核实</Badge>}
            <Badge tone={READ_STATUS_META[readStatus].tone}>{READ_STATUS_META[readStatus].label}</Badge>
            {/* whitespace-nowrap：窄屏下按钮文字不得逐字竖排（390 走查实测的溢出根因） */}
            <Button variant="outline" className="whitespace-nowrap" onClick={() => void extract()} loading={extracting}>
              <Lightbulb className="size-4" /> 提炼洞见
            </Button>
          </div>
        }
      />

      {goalCard}
      {mapStrip}

      <div className={cn("grid min-w-0 gap-6", planOpen && "lg:grid-cols-[300px_minmax(0,1fr)]", panelOpen && "xl:grid-cols-[300px_minmax(0,1fr)_290px]")}>
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
                  aria-label="路线选项"
                  aria-expanded={routeMenuOpen}
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
              <>
                {/* 与模式菜单同款交互：遮罩任意处点击关闭（此前路线菜单只能再点一次按钮出去） */}
                <div className="fixed inset-0 z-20" onClick={() => setRouteMenuOpen(false)} />
                <div className="relative z-30 mb-3 space-y-2 rounded-xl border border-border bg-surface-2 p-3">
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
                </div>
              </>
            )}
            {/* 重排路线的等待提示：菜单在 regenerateRoute 开头即关闭，挂在菜单块内会永远渲染不出来。
                重排是 30-60 秒的无流式 LLM 调用，期间必须给出可见反馈（PRD：检索阶段可见，否则用户以为卡死）。 */}
            {regenBusy && (
              <p className="mb-2 flex items-center gap-1.5 rounded-lg border border-accent/25 bg-accent/[0.04] px-2.5 py-2 text-[11px] text-accent">
                <span className="size-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                正在重排路线…（约 30-60 秒）
              </p>
            )}
            {/* 目录独立滚动：长书翻目录不拖整页 */}
            <div className="relative ml-2 max-h-[calc(100dvh-260px)] space-y-1 overflow-y-auto border-l border-border pl-5 lg:pr-1">
              {book.chapters.map((c, i) => {
                /* 用户未手动选择时跟随「当前节点」自动展开；一旦选择就以 expandedId 为准，
                 * 所以再次点击当前节点能真正收起（旧实现 expanded = expandedId===c.id ||
                 * chapter?.id===c.id，任何被点节点都会先成为当前节点，收起分支永远无效果）。 */
                const expanded = expandedId === undefined ? chapter?.id === c.id : expandedId === c.id;
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
                        const follows = expandedId === undefined ? chapter?.id === c.id : expandedId === c.id;
                        setCurrentChapter(c.id);
                        if (c.status === "todo") {
                          trackReading("learning_node_started", { bookId: book.id, chapterId: c.id, source: "route_click" });
                          setChapterStatus(book.id, c.id, "reading");
                        }
                        /* 已展开 = 收起（置 null 显式抑制 chapter 匹配重开）；未展开 = 展开它 */
                        setExpandedId(follows ? null : c.id);
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
                              {/* 与 openAssess 覆盖确认（跨节点）同纪律：已作答内容静默清空无法找回，
                                  三题里有任何实际输入都先确认再放弃 */}
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  if (!assess.answers.some((a) => a.trim()) || confirm("放弃这次验收的作答？")) setAssess(null);
                                }}
                                disabled={assessBusy}
                              >
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
                                  ASSESS_LEVEL_STYLES[r.level]
                                )}
                              >
                                <p className="text-[10.5px] font-semibold text-ink-dim">{ASSESS_KIND_LABELS[r.kind]} · {ASSESS_LEVEL_LABELS[r.level]}</p>
                                {r.evidence && <p className="mt-0.5 text-[11px] text-ink-dim">依据：{r.evidence}</p>}
                                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-dim">{r.feedback}</p>
                              </div>
                            ))}
                            {assessResult.suggestion && <p className="text-[11px] text-ink-dim">下一步：{assessResult.suggestion}</p>}
                            <div className="flex gap-1.5">
                              <Button variant="outline" size="sm" className="flex-1" onClick={() => remediate(c)} disabled={streaming || retrieving}>
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
                            /* 已掌握节点再次验收同样要给 10-30s 出题期可见反馈（与未掌握分支、
                             * 全页其余长任务按钮的 loading 约定一致），不能只剩半透明禁用 */
                            loading={assessBusy}
                            onClick={() => void openAssess(c)}
                          >
                            <ShieldCheck className="size-3.5" /> {assessBusy ? "正在出题…" : verified ? "再次验收" : "开始验收（通过=掌握）"}
                          </Button>
                        )}

                        {/* 沉淀（PRD 4.6）：优先用户自己的话 */}
                        <div className="rounded-lg border border-border bg-white p-2.5">
                          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-dim/70">沉淀一句话</p>
                          <div className="mt-1.5 flex gap-1.5">
                            <select
                              value={depositType}
                              onChange={(e) => setDepositType(e.target.value as DepositType)}
                              aria-label="沉淀类型"
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
                              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && addDeposit(c.id)}
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

          {/* 知识迁移工作面板（升级 PRD 2.5）：AI 出真实场景任务 → 独立作答 → 判定 →（v26.1）独立复检 */}
          {(transfer || recheck || transferResult || exitSurvey) && (
            <div ref={practiceRef} className="scroll-mt-20">
            <Card className="mb-4 border-accent/30">
              {transfer ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <Route className="size-4 text-accent" />
                    <p className="text-[13px] font-bold text-ink">迁移应用</p>
                    {hintShown && <Badge tone="warn">已用提示·辅助模式</Badge>}
                    {/* 与独立复验「暂不做」同口径：已输入的应用方案一旦放弃即被清出 store、
                        practiceKey 草稿随 effect 删掉，静默丢弃无法找回——草稿非空必须先确认 */}
                    <Button variant="ghost" size="sm" className="ml-auto" onClick={() => {
                      if (!transfer.answer.trim() || confirm("放弃已经写好的应用方案？")) {
                        setTransfer(null);
                        setExitSurvey(true);
                      }
                    }}>
                      暂不做
                    </Button>
                  </div>
                  {transfer.why && <p className="mt-1 text-[11px] text-ink-dim/70">{transfer.why}</p>}
                  <p className="mt-2 rounded-xl bg-surface-2 p-3 text-[13px] leading-relaxed text-ink">{transfer.task}</p>
                  <Textarea
                    rows={5}
                    className="mt-2.5"
                    placeholder="写下你怎么想、怎么做——用上书里的概念，具体到步骤（3-5 句）…"
                    value={transfer.answer}
                    onChange={(e) => setTransfer({ ...transfer, answer: e.target.value })}
                  />
                  <div className="mt-2.5 flex items-center justify-between gap-2">
                    {/* v26.1 G3：提示=辅助模式。用了提示的迁移不会计为独立成功 */}
                    {!hintShown ? (
                      <Button variant="ghost" size="sm" onClick={() => setHintShown(true)}>
                        <Lightbulb className="size-3.5" /> 卡住了？要一点提示
                      </Button>
                    ) : (
                      <p className="text-[11px] leading-relaxed text-ink-dim">
                        提示：想一想 {(chapter?.keyConcepts ?? ["核心概念"]).slice(0, 2).join("、")}——它的触发条件是什么？在这一步谁先「给」？
                      </p>
                    )}
                    <Button size="sm" onClick={() => void submitTransfer()} loading={transferBusy}>
                      提交应用方案
                    </Button>
                  </div>
                </>
              ) : (transferResult || recheck) ? (
                recheck ? (
                  /* v26.1 G3：独立迁移复检作答——同概念换场景，作答后 submitRecheck 写回 recheck 字段 */
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <ShieldCheck className="size-4 text-accent" />
                      <p className="text-[13px] font-bold text-ink">独立复验</p>
                      <Badge tone="accent">换场景再答一次</Badge>
                      <Button variant="ghost" size="sm" className="ml-auto" disabled={recheckBusy} onClick={() => {
                        if (!recheck.answer.trim() || confirm("放弃这次独立复验的草稿？")) setRecheck(null);
                      }}>
                        暂不做
                      </Button>
                    </div>
                    <p className="mt-2 rounded-xl bg-surface-2 p-3 text-[13px] leading-relaxed text-ink">{recheck.task}</p>
                    <Textarea
                      rows={5}
                      className="mt-2.5"
                      placeholder="不看前面的答案，用你自己的话在新场景里再做一次…"
                      value={recheck.answer}
                      onChange={(e) => setRecheck({ ...recheck, answer: e.target.value })}
                    />
                    <div className="mt-2.5 flex justify-end gap-1.5">
                      <Button size="sm" onClick={() => void submitRecheck()} loading={recheckBusy}>
                        提交独立作答
                      </Button>
                    </div>
                  </>
                ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Route className="size-4 text-accent" />
                    <p className="text-[13px] font-bold text-ink">{activeTransferRecord?.recheck ? "独立复验结果" : "迁移判定"}</p>
                    <Badge tone={activeTransferRecord?.recheck
                      ? activeTransferRecord.recheck.verdict === "independent_success" ? "ok" : "warn"
                      : transferResult?.verdict === "used_correct" ? "ok" : transferResult?.verdict === "used_wrong" ? "warn" : "default"}>
                      {activeTransferRecord?.recheck ? TRANSFER_OUTCOME_LABELS[activeTransferRecord.recheck.verdict] : transferResult && TRANSFER_VERDICT_LABELS[transferResult.verdict]}
                    </Badge>
                  </div>
                  {activeTransferRecord?.recheck ? (
                    <div className="mt-2 space-y-2 break-words text-sm leading-relaxed text-ink-dim">
                      <p className="whitespace-pre-wrap">{activeTransferRecord.recheck.task}</p>
                      <p className="whitespace-pre-wrap">你的作答：{activeTransferRecord.recheck.answer}</p>
                      {activeTransferRecord.recheck.evidence && <p>判定依据：{activeTransferRecord.recheck.evidence}</p>}
                      {activeTransferRecord.recheck.feedback && <p>{activeTransferRecord.recheck.feedback}</p>}
                    </div>
                  ) : (
                    <>
                      {transferResult?.evidence && <p className="mt-2 break-words text-xs leading-relaxed text-ink-dim">依据：{transferResult.evidence}</p>}
                      <p className="mt-1 break-words text-sm leading-relaxed text-ink-dim">{transferResult?.feedback}</p>
                    </>
                  )}
                  {!activeTransferRecord?.recheck && transferResult?.nextStep && (
                    <p className="mt-2 rounded-lg bg-accent/[0.05] px-2.5 py-2 text-[11.5px] text-ink-dim">
                      <b className="text-ink/80">下一步：</b>{transferResult.nextStep}
                    </p>
                  )}
                  {/* v26.1 G3：独立检验——只有首轮独立模式通过才值得做；辅助模式先重做独立任务 */}
                  {canRecheck && (
                    <div className="mt-2.5 rounded-xl border border-ok/30 bg-ok/[0.04] p-2.5">
                      <p className="text-[12px] font-semibold text-ink">下一步：独立迁移检验</p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-dim">
                        换一个场景、换一种问法，看这个概念是不是真的归你了——独立通过才算真能力。
                      </p>
                    </div>
                  )}
                  <div className="mt-2.5 flex flex-wrap justify-end gap-1.5">
                    <Button variant="outline" size="sm" disabled={recheckBusy || transferBusy} onClick={() => setTransferResult(null)}>
                      收下
                    </Button>
                    {canRecheck && lastTransferId && (
                      <Button size="sm" onClick={() => void genRecheck(lastTransferId)} loading={recheckBusy} disabled={transferBusy}>
                        <ShieldCheck className="size-3.5" /> 开始独立检验
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => void genTransfer()} loading={transferBusy} disabled={recheckBusy}>
                      再来一个场景
                    </Button>
                  </div>
                </>
                )
              ) : exitSurvey ? (
                /* v26.1 G4：流失原因轻条（放弃迁移时页内出现，可跳过，不打断阅读） */
                <>
                  <p className="text-[13px] font-bold text-ink">是什么让你暂时不想做这个任务？</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {["不知道怎么使用", "没有解决我的问题", "AI 回答质量不满意", "任务太复杂", "时间不足", "已经获得需要的信息", "产品体验不够顺畅", "其他"].map((r) => (
                      <button
                        key={r}
                        onClick={() => setExitReason(r)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-[11px] transition cursor-pointer",
                          exitReason === r ? "border-accent/60 bg-accent/[0.07] text-accent" : "border-border bg-white text-ink-dim hover:border-accent/40"
                        )}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2.5 flex justify-end gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => { setExitSurvey(false); setExitReason(""); }}>
                      不想说
                    </Button>
                    <Button
                      size="sm"
                      disabled={!exitReason}
                      onClick={() => {
                        trackReading("reading_exit_survey", { bookId: book.id, stage: "transfer", reason: exitReason });
                        setExitSurvey(false);
                        setExitReason("");
                        toast("收到，谢谢——这会帮我们把任务改得更顺。");
                      }}
                    >
                      提交
                    </Button>
                  </div>
                </>
              ) : null}
            </Card>
            </div>
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
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm text-white">
                    {m.content}
                  </div>
                ) : (
                  <Card className="max-w-[92%] rounded-2xl rounded-bl-md py-4">
                    <Markdown text={m.content} className="prose-reading" />
                  </Card>
                )}
              </div>
            ))}
            {pending && (
              <Card aria-live="polite" className="max-w-[92%] rounded-2xl rounded-bl-md py-4">
                <Markdown text={pending} className="prose-reading" />
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
                className="flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1.5 text-[11.5px] text-ink-dim transition hover:border-accent/50 hover:text-accent"
                aria-expanded={modeMenuOpen}
              >
                <MessagesSquare className="size-3.5 shrink-0" />
                <span className="shrink-0 font-semibold">{activeModeMeta.label}</span>
                {/* 窄屏 390 实测：固定 max-w-[320px] 会把胶囊撑出视口——改弹性收缩 + 截断 */}
                <span className="min-w-0 flex-1 truncate text-ink-dim/60 sm:max-w-[320px]">{activeModeMeta.hint}</span>
                <ChevronDown className={cn("size-3.5 shrink-0 transition", modeMenuOpen && "rotate-180")} />
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
            {error && <p role="alert" className="mb-2 text-xs text-bad">{error}</p>}
            {!streaming && !retrieving && unanswered?.role === "user" && (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-dim">
                <span>上一条问题还没收到回复。</span>
                <Button size="sm" variant="outline" onClick={() => sendReadingQuestion(unanswered.content, true)}>继续回答</Button>
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && doSend()}
                placeholder="说说你的理解、困惑，或反驳…"
                disabled={streaming}
              />
              {(streaming || retrieving) && (
                <Button
                  variant="outline"
                  onClick={() => {
                    ragAbortRef.current?.abort();
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
              <Button onClick={doSend} loading={streaming} disabled={retrieving} className="h-11 shrink-0 sm:h-10">
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

      {/* 整本结业（升级 PRD 3.6）：成果/核心认知/仍不足/迁移结果/后续建议（仅建议） */}
      <Modal open={!!graduation} onClose={() => setGraduation(null)} title="结业总结">
        {graduation && (
          <>
            <div className="max-h-[55vh] overflow-y-auto rounded-xl border border-border bg-surface-2/40 p-4">
              <Markdown text={graduation.md} />
              {graduation.nextSteps.length > 0 && (
                <div className="mt-3 rounded-xl border border-accent/25 bg-accent/[0.04] p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-accent/80">下一步（仅建议）</p>
                  <ul className="mt-1.5 space-y-1">
                    {graduation.nextSteps.map((s, i) => (
                      <li key={i} className="text-[12px] leading-relaxed text-ink-dim">· {s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setGraduation(null)}>
                关闭
              </Button>
              <Button onClick={saveGraduationToBrain}>
                <BookMarked className="size-4" /> 存入第二大脑
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
