"use client";

/* RAG trace 目前仅控制台诊断（见 AskCoach 内 [rag-trace]）；入库等 /api/track 白名单扩容后接 track() */

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { MASTERY_LABELS } from "@/lib/types";
import {
  Badge, Button, Card, Input, Modal, PageHeader, ProgressRing, StatusDot, Textarea, Skeleton } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { AgentTrace, type TracePhase } from "@/components/agent-trace";
import { useAppStore } from "@/lib/store";
import { useAuth, type AuthUser } from "@/lib/auth-client";
import Link from "next/link";
import { useHydrated } from "@/lib/use-chat";
import { PageBackBar } from "@/components/page-back-bar";
import { DOMAIN_LABELS } from "@/lib/types";
import type { DayPlan, Goal, QuizItemResult } from "@/lib/types";
import { extractJson, normalizeQuizGrade, quizGradeSchema, type QuizGrade } from "@/lib/ai/client";
import { cn, formatDate, uid, rankResources, KIND_LABEL } from "@/lib/utils";
import { buildStudyResourceQuery, refineResources } from "@/lib/resource-pipeline";
import { masteryFromQuiz } from "@/lib/store";
import { phaseName, planOutlineNoteTitle, planPhaseNoteTitle } from "@/lib/plan";
import { runGraduation } from "@/lib/graduation";
import { PLANS, priceLabel } from "@/lib/pricing";

/* Link checks also protect resources saved by older versions. */
import type { LinkCheck } from "@/lib/resource-pipeline";
import { ensureCheck, requiresVideoResources } from "@/lib/resource-pipeline";
function CheckedResourceLink({ url, title, videoOnly = false }: { url: string; title: string; videoOnly?: boolean }) {
  const [result, setResult] = useState<{ url: string; check: LinkCheck | null }>();
  useEffect(() => {
    let active = true;
    void ensureCheck(url).then((check) => { if (active) setResult({ url, check }); });
    return () => { active = false; };
  }, [url]);
  const current = result?.url === url ? result : undefined;
  const check = current?.check;
  if (!check?.ok || check.dead || check.ad || (videoOnly && !check.video)) {
    return (
      <span className="min-w-0 break-words text-ink-dim">
        {title} <span className="ml-1 text-xs" title={check?.reason}>{!current ? "检查中" : check?.dead || check?.ad ? "链接不可用" : videoOnly && check?.ok && !check.video ? "未确认是可播放的视频" : "暂未确认可访问"}</span>
      </span>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-accent hover:underline">
      <span className="break-words">{check.title || title}</span> <ExternalLink className="size-3.5 shrink-0" />
    </a>
  );
}

import { toast } from "sonner";
import {
  ArrowLeft, BookMarked, BookOpen, Check, ChevronRight, CircleX, ExternalLink, Flag, Globe,
  ListOrdered, Loader2, Lock, NotebookPen, Puzzle, Swords, Trophy,
} from "lucide-react";

/* 验收题 kind 的中文标签（schema 实际取值：explain/apply/oral/essay/build） */
const ACCEPTANCE_KIND_LABEL: Record<string, string> = {
  explain: "讲解",
  apply: "应用",
  oral: "口述",
  essay: "论述",
  build: "构建",
  transfer: "迁移",
};

/* 付费墙口径与剩余天数统计：GoalDetailInner（头部闸）与 LearnBody（时间线徽章）共用一份。
 * 此前 freeTier / FREE_PHASE_LIMIT / remainingDays 在父子组件各抄一份——改 FREE_PHASE_LIMIT
 * 或到期判定口径时漏改一处，头部 paywall 闸与时间线锁定逻辑就会对同一用户给出不同判定。
 * 收口成一份，理由同下方 regenPhaseFlow 的注释。 */
const FREE_PHASE_LIMIT = 2;
const isFreeTier = (user: AuthUser | null | undefined): boolean => user?.entitlement?.status === "expired";
const countRemainingDays = (goal: Pick<Goal, "plan"> | null | undefined): number =>
  goal?.plan
    ? Object.values(goal.plan.days).filter((d) => d.status === "active" || d.status === "locked").length
    : 0;

/* ================= 即时答疑：学习中随时问教练 ================= */
function AskCoach({ goal, day }: { goal: Goal; day: DayPlan }) {
  const appendDayQa = useAppStore((s) => s.appendDayQa);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [phases, setPhases] = useState<TracePhase[]>([]);
  const qa = day.qa ?? [];
  const boxRef = useRef<HTMLDivElement>(null);
  const qaRequestRef = useRef<AbortController | null>(null);
  useEffect(() => () => qaRequestRef.current?.abort(), [goal.id, day.id]);
  /* 多轮后回答在滚动视口外生长：跟随滚底（容器自身要用 scrollTop，scrollIntoView 只滚外层） */
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [qa.length, streamText]);

  const unanswered = qa.at(-1);
  const send = () => void respond(input.trim());
  const respond = async (text: string, reuseQuestion = false) => {
    if (!text || qaRequestRef.current) return;
    const request = new AbortController();
    qaRequestRef.current = request;
    const account = useAppStore.getState()._storeUserId;
    const sameRequest = () => !request.signal.aborted && useAppStore.getState()._storeUserId === account;
    setBusy(true);
    setStreamText("");
    const newQa = [...qa];
    if (!reuseQuestion) {
      setInput("");
      const userMsg = { id: uid("m"), role: "user" as const, content: text, at: new Date().toISOString() };
      newQa.push(userMsg);
      appendDayQa(goal.id, day.id, userMsg);
    }
    /* UI 状态规范（R1/R2/R3）：首 token 前必须有可见阶段，不能黑屏等 */
    const t0 = performance.now();
    setPhases([{ label: "检索笔记", state: "running" }]);
    /* 流式节流：旧实现每个 delta 都 setStreamText——每次增量都重渲染整个 AskCoach
     * （连带整个 qa 列表），Markdown 对已累积全文重新 parse，成本随文本长度×chunk
     * 数累乘。80ms 批量刷新把重渲染频率钳到人眼无感的量级；收尾时 flushNow
     * 兜底最后一个窗口内的增量，出错路径由 finally 清掉未触发的定时器（防幽灵刷新）。 */
    let buf = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushNow = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (sameRequest()) setStreamText(buf);
    };
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const ctx = JSON.stringify({
        topic: goal.topic,
        today: day.title,
        knowledgePoints: day.knowledgePoints.map((k) => k.text),
        learnerProfile: goal.learnerProfile ?? [],
      });
      /* 学习答疑也接第二大脑检索（2026-10-26）：这是最高频的对话入口，
       * 用户问的多是老知识的延伸——把他自己记过的相关笔记当证据带上，回答才接得上。
       * 检索失败/为空则不加，绝不影响答疑本身。 */
      let ragCtx = "";
      let ragFailed = false;
      try {
        const { retrieveEnhanced } = await import("@/lib/rag-pipeline");
        const notes = useAppStore
          .getState()
          .knowledge.filter((k) => !(k.tags ?? []).includes("MOC"))
          .map((k) => ({
            id: k.id, title: k.title, body: k.body, domain: k.domain,
            links: k.links, version: k.version, updatedAt: k.updatedAt, tags: k.tags,
          }));
        const r = await retrieveEnhanced(text, notes, 3, { context: day.title, rewrite: false, signal: request.signal });
        if (process.env.NODE_ENV !== "production") console.info("[rag-trace]", { task: "coach-qa", ...r.trace });
        ragCtx = r.context;
      } catch { ragFailed = true; /* 检索是增强项，失败不阻塞答疑 */ }
      if (!sameRequest()) return;
      const t1 = performance.now();
      setPhases([
        {
          label: "检索笔记",
          state: ragFailed ? "failed" : "done",
          durationMs: t1 - t0,
          detail: ragFailed ? "检索失败，改用通识回答" : ragCtx ? "已带上你的相关笔记" : "没有相关笔记",
        },
        { label: "思考回答", state: "running" },
      ]);
      const full = await streamChat({
        task: "coach-qa",
        args: { ctx, ragCtx },
        signal: request.signal,
        messages: newQa.slice(-6).map((m) => ({ role: m.role, content: m.content })),
        onDelta: (d) => {
          buf += d;
          if (!flushTimer) flushTimer = setTimeout(flushNow, 80);
        },
      });
      if (!sameRequest()) return;
      const t2 = performance.now();
      setPhases((prev) =>
        prev.map((p) => (p.state === "running" ? { ...p, state: "done", durationMs: t2 - t1 } : p))
      );
      flushNow(); // 兜底最后一个 80ms 窗口内的增量
      /* 模型 200 但正文为空（BYOK 自定义端点的现实场景）：旧实现仍向持久化 qa 追加
       * 一条空 assistant 消息——界面出现空气泡、无任何报错，这条空消息还会占用
       * 后续 newQa.slice(-6) 的历史窗口稀释上下文。与 use-chat 的空回复守卫
       * （setError「模型返回了空回复，请重试」）同口径：不落库、显式报错。 */
      const content = full || buf;
      if (content) {
        appendDayQa(goal.id, day.id, {
          id: uid("m"),
          role: "assistant" as const,
          content,
          at: new Date().toISOString(),
        });
      } else {
        toast.error("模型返回了空回复，请重试");
      }
    } catch (e) {
      flushNow(); // 中断保留的内容要完整可见（含最后一个窗口内的增量）
      /* 与讲义生成（genLesson catch）同口径：答疑带 RAG 上下文同样可能长答，断网/点停止
       * 时已流出的部分不整段丢弃——继续回答=从头重新生成、重新计费。阈值对齐讲义的
       * 200 字符：太短的残句没有保留价值，走原报错路径。账号已切换时不落库
       * （不能把上一个账号的回答写进当前账号的库）。 */
      const accountUnchanged = useAppStore.getState()._storeUserId === account;
      if (accountUnchanged && buf.trim().length > 200) {
        appendDayQa(goal.id, day.id, {
          id: uid("m"),
          role: "assistant" as const,
          content: buf,
          at: new Date().toISOString(),
        });
        setPhases((prev) =>
          prev.map((p) => (p.state === "running" ? { ...p, state: "cancelled", detail: "中断，已保留已生成内容" } : p))
        );
        toast.error("回答中断，已保留已生成的部分；想看完整回答请重新提问。");
      } else {
        setPhases((prev) => prev.map((p) => (p.state === "running" ? { ...p, state: "failed" } : p)));
        if (sameRequest()) toast.error(friendlyGenError(e, "答疑失败"));
      }
    } finally {
      // 清掉未触发的节流定时器：否则它会在 setStreamText("") 之后 firing，半截回复复活成幽灵气泡
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (qaRequestRef.current === request) qaRequestRef.current = null;
      setStreamText("");
      setBusy(false);
    }
  };

  return (
    <Card>
      <button
        className="flex w-full items-center justify-between cursor-pointer"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="ask-coach-panel"
      >
        <p className="text-sm font-bold text-ink">看不懂？问教练</p>
        <span className="text-xs text-ink-dim">{open ? "收起 ▲" : "展开 ▼"}</span>
      </button>
      {open && (
        <div id="ask-coach-panel" className="mt-3">
          {/* 流式正文逐 token 增长：live 区域包住它会让读屏把增长中的半句话反复重播（比不加更糟）。
              只对阶段变化做礼貌播报——开始/完成由下方独立 status 行承担；
              aria-label 挂在无 role 的 div 上会被读屏忽略，补 role="region" 名称才生效。 */}
          <div ref={boxRef} role="region" aria-label="教练答疑" className="max-h-64 space-y-2.5 overflow-y-auto">
            {qa.length === 0 && !streamText && (
              <p className="text-xs text-ink-dim/70">
                看不懂某个知识点？代码报错不知道为什么？直接问，教练即时解答。
              </p>
            )}
            {qa.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                {m.role === "user" ? (
                  /* 用户气泡走主题令牌 bg-ink（--color-ink），别写死 #1d1d1f——与 learn/new 的同语义气泡同源 */
                  <div className="max-w-[85%] rounded-xl rounded-br-sm bg-ink px-3 py-2 text-xs text-white">
                    {m.content}
                  </div>
                ) : (
                  <div className="max-w-[92%] rounded-xl rounded-bl-sm bg-surface-2 border border-border px-3 py-2">
                    <Markdown text={m.content} className="text-xs" />
                  </div>
                )}
              </div>
            ))}
            {streamText && (
              <div className="max-w-[92%] rounded-xl rounded-bl-sm bg-surface-2 border border-border px-3 py-2">
                <Markdown text={streamText} className="text-xs" />
                <span className="stream-cursor" />
              </div>
            )}
            {/* 思考轨迹：首 token 前也有可见阶段（检索→思考），完成后折叠为耗时摘要 */}
            <AgentTrace phases={phases} className="max-w-[92%]" />
          </div>
          {/* 阶段播报走独立 status 行：开始回答/回答完成各一次，不随流式增量反复触发；失败由 toast 报 */}
          <p role="status" className="sr-only">
            {busy
              ? "教练正在回答…"
              : qa.length > 0 && qa[qa.length - 1].role === "assistant"
                ? "教练已回答"
                : ""}
          </p>
          {!busy && unanswered?.role === "user" && (
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void respond(unanswered.content, true)}>继续回答</Button>
          )}
          <div className="mt-3 flex items-center gap-2">
            <Input
              placeholder="输入你的疑问…（Enter 发送）"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // isComposing：中文输入法选词回车不算发送（与 council / learn/new / agent-home 同守卫）
                if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
              }}
              disabled={busy}
            />
            {busy && (
              <Button size="sm" variant="outline" onClick={() => {
                qaRequestRef.current?.abort();
                setPhases((current) => current.map((phase) => phase.state === "running" ? { ...phase, state: "cancelled" } : phase));
              }}>停止</Button>
            )}
            <Button size="sm" onClick={send} loading={busy} className="shrink-0">
              问
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ================= 随手记：学习中直接入第二大脑 ================= */
function QuickNotes({ goal, day }: { goal: Goal; day: DayPlan }) {
  const knowledge = useAppStore((s) => s.knowledge);
  const addKnowledge = useAppStore((s) => s.addKnowledge);
  const [text, setText] = useState("");
  const notes = knowledge.filter(
    /* 过滤条件与写入的 domain 对齐（本面板/验收写入均为 `${topic}/笔记`），否则列表恒空 */
    (k) => k.domain === `${goal.topic}/笔记` && k.sourceTitle.includes(day.title)
  );
  return (
    <Card>
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-ink">随手记</p>
        <span className="text-[11px] text-ink-dim">想到就记，直接进知识库</span>
      </div>
      <div className="mt-3">
        <Input
          placeholder="记一条：今天踩的坑 / 顿悟 / 想追问的问题…（Enter 保存）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // isComposing：中文输入法选词回车不算保存，否则半截笔记会落库并清空输入框
            if (e.key !== "Enter" || e.nativeEvent.isComposing || !text.trim()) return;
            /* addKnowledge 按标题全库去重（同名整条丢弃），返回实际新增条数：
             * 旧实现不消费返回值无条件报「已记入」并清空输入——随手记标题取前 40 字符，
             * 极易与验收通过时按知识点原文写入的标题撞车，笔记实际没存却收到成功确认。 */
            const added = addKnowledge(
              [{ title: text.trim().slice(0, 40), body: text.trim(), domain: `${goal.topic}/笔记` }],
              "manual",
              `${goal.topic} · ${day.title} · 随手记`
            );
            if (added > 0) {
              setText("");
              toast.success("已记入第二大脑");
            } else {
              // 撞名被去重丢弃：如实报错并保留输入，用户换个更具体的说法再记
              toast.error("第二大脑里已有同名笔记，这条没有重复入库——换个更具体的说法再记");
            }
          }}
        />
      </div>
      {notes.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {notes.map((n) => (
            <p key={n.id} className="flex items-center gap-1.5 truncate rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-ink-dim">
              <NotebookPen className="size-3 shrink-0" />
              <span className="truncate">{n.title}</span>
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ================= 页面 ================= */
function GoalDetailInner() {
  const hydrated = useHydrated();
  const { id } = useParams<{ id: string }>();
  const goal = useAppStore((s) => s.goals.find((g) => g.id === id));
  const settings = useAppStore((s) => s.settings);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [viewDayId, setViewDayId] = useState<string | null>(null);
  /* 学习窗口：由计划页 window.open 打开的新标签页（?day=<id>&focus=1），
   * 只渲染当天学习视图。计划页留在原标签不动，退出学习窗口不会丢计划。 */
  const focusParam = searchParams.get("day");
  const isFocus = searchParams.get("focus") === "1";
  /* 在窗口内切到下一天时用本地覆盖值，不必为 URL 参数再同步一次 state */
  const [focusOverride, setFocusOverride] = useState<string | null>(null);
  const focusDayId = focusOverride ?? focusParam;
  /* 日程投影（视图层，不进目标卡 schema）：用户给一个目标日期,反推每天节奏。
   * ⚠️ Hook 必须在一切条件 return 之前（踩坑 #9：hydrated/goal 翻转时钩子数量变化→React #310） */
  const [deadline, setDeadline] = useState<string>(() => {
    try { return localStorage.getItem(`mentora-deadline-${id}`) ?? ""; } catch { return ""; }
  });
  const setDeadlineDate = (v: string) => {
    setDeadline(v);
    try { localStorage.setItem(`mentora-deadline-${id}`, v); } catch { /* 忽略 */ }
  };

  /* E2 验收 2：完成 / 跳过 / 掌握分别统计（掌握只认知识点 masteryStatus 证据） */
  const progress = useMemo(() => {
    if (!goal?.plan) return { ratio: 0, done: 0, total: 0, passed: 0, skipped: 0, mastered: 0 };
    const days = Object.values(goal.plan.days);
    const passed = days.filter((d) => d.status === "passed").length;
    const skipped = days.filter((d) => d.status === "skipped").length;
    const mastered = days.filter((d) =>
      (d.knowledgePoints ?? []).some((k) => k.masteryStatus && k.masteryStatus !== "unknown" && k.masteryStatus !== "exposed")
    ).length;
    const done = passed + skipped;
    return { ratio: days.length ? done / days.length : 0, done, total: days.length, passed, skipped, mastered };
  }, [goal]);

  const activeDay =
    Object.values(goal?.plan?.days ?? {}).find((d) => d.status === "active") ??
    /* 迁移门（v17）：判过但未过门的当天顶替"当前任务"——否则无 active 日、视图空转，门卡无处显 */
    Object.values(goal?.plan?.days ?? {}).find((d) => d.status === "passed" && d.pendingUnlock) ??
    null;
  const activePhase = goal?.plan?.phases.find((p) => p.status === "active") ?? null;
  const viewDay = (viewDayId ? goal?.plan?.days[viewDayId] : null) ?? activeDay;
  const focusDay = (focusDayId ? goal?.plan?.days[focusDayId] : null) ?? activeDay;
  /* 免费版阶段付费墙（PRD §4）：前两个阶段免费，第三个阶段起需会员。
   * 只拦"新内容"，已完成/已通过的阶段和全部数据照常可看。 */
  const { user } = useAuth();
  const freeTier = isFreeTier(user);
  const phaseIndexOf = (day: DayPlan | null | undefined): number => {
    if (!goal?.plan || !day) return -1;
    return goal.plan.phases.findIndex((p) => p.id === day.phaseId);
  };
  /* 付费墙只拦"新内容"：已完成/已跳过的天豁免回看（契约三处一致：本注释、
   * PhasePaywall 文案「你已经完成的阶段…随时可以回看」、PlanTimeline 已通过阶段可点）。
   * 豁免看"天"的 status 而非 phase.status——重排（setPhaseCatalog）不会重置已通过
   * 阶段的 status，但会引入 locked/active 的新目录天（store.ts:656-667,679）；标题对齐
   * 沿用旧 id 的天保留 status:"passed"（phase-regen.ts alignPhaseDayIds）。
   * 按天豁免才能精确放行"已学过的内容"、同时拦住重排进来的新内容。 */
  const dayViewExempt = (day: DayPlan | null | undefined): boolean => {
    if (!day) return false;
    return day.status === "passed" || day.status === "skipped";
  };
  const viewDayLocked =
    freeTier && !!viewDay && phaseIndexOf(viewDay) >= FREE_PHASE_LIMIT && !dayViewExempt(viewDay);
  const activePhaseLocked =
    freeTier && !!activePhase && !!goal?.plan && goal.plan.phases.findIndex((p) => p.id === activePhase.id) >= FREE_PHASE_LIMIT;


  /* 内容自动补齐（无需用户点「生成」）：
   *   阶段没目录 → 先出全目录；当天还是目录占位 → 展开当天；当天已展开 → 预取后面两天。
   * 失败不狂重试：错误留在对应面板上，用户可手动重试；刷新后这里会自动续跑。 */
  const catalogLen = activePhase?.catalog?.length ?? 0;
  const activePhaseStatus = activePhase?.status;
  useEffect(() => {
    if (!hydrated || !goal?.plan || !activePhase || activePhaseStatus !== "active") return;
    if (activePhaseLocked) return; // 免费版：锁定的阶段不自动生成内容
    if (catalogLen === 0) {
      ensurePhaseCatalog(goal.id, activePhase.id);
      return;
    }
    if (activeDay?.stub) {
      ensureDayDetail(goal.id, activeDay.id);
      return;
    }
    if (activeDay) prefetchUpcoming(goal.id, activeDay.id, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只按 id/stub 变化驱动
  }, [hydrated, goal?.id, activePhase?.id, activePhaseStatus, catalogLen, activeDay?.id, activeDay?.stub]);

  if (!hydrated) return <Skeleton className="h-40 rounded-2xl bg-surface/60" />;
  if (!goal) {
    return (
      <div className="py-20 text-center text-ink-dim">
        目标不存在。
        <Button variant="outline" className="ml-3" onClick={() => router.push("/learn")}>
          返回
        </Button>
      </div>
    );
  }

  const closeStudyWindow = () => {
    router.push(`/learn/${goal.id}`);
  };

  /* 学习窗口：只留当天内容，窄栏居中；不再渲染计划侧栏/日程投影等管理信息 */
  if (isFocus) {
    /* 与普通视图同闸（旧实现完全绕过）：①免费版付费墙——手拼 ?day=<付费阶段目录日>&focus=1
     * 会让 DayStubPanel 的兜底 effect 无条件生成付费内容（正是 activePhaseLocked 刻意阻止的
     * 事），计算口径与 viewDayLocked 一致；②推进门——非当前任务天一律 readOnly，
     * 否则预取出来的 locked 未解锁天也能直接提交验收、setDayStatus 落库。 */
    const focusLocked =
      freeTier && !!focusDay && phaseIndexOf(focusDay) >= FREE_PHASE_LIMIT && !dayViewExempt(focusDay);
    return (
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <button
            onClick={closeStudyWindow}
            className="flex items-center gap-1.5 text-sm text-ink-dim hover:text-ink cursor-pointer"
          >
            <ArrowLeft className="size-4" /> 返回计划
          </button>
          <span className="truncate text-xs text-ink-dim">{goal.topic}</span>
          <Button variant="outline" size="sm" onClick={closeStudyWindow}>
            关闭学习窗口
          </Button>
        </div>
        {focusDay ? (
          focusLocked ? (
            <PhasePaywall phaseIndex={phaseIndexOf(focusDay)} />
          ) : focusDay.stub ? (
            <DayStubPanel goal={goal} day={focusDay} />
          ) : (
            <DayPanel
              key={focusDay.id}
              goal={goal}
              day={focusDay}
              readOnly={focusDay.id !== activeDay?.id}
              tone={settings.coachTone ?? "standard"}
              openWindow={false}
              onGoToDay={(next) => {
                if (next && goal.plan?.days[next]) {
                  setFocusOverride(next);
                  window.history.replaceState(null, "", `/learn/${goal.id}?day=${next}&focus=1`);
                } else {
                  closeStudyWindow();
                }
              }}
            />
          )
        ) : (
          <Card>
            <p className="text-sm text-ink-dim">这一天不在计划里（可能已被删除）。</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={closeStudyWindow}>
              返回计划
            </Button>
          </Card>
        )}
      </div>
    );
  }

  const remainingDays = countRemainingDays(goal);
  const projection = (() => {
    if (!deadline || !remainingDays) return null;
    // 截止日按"当天结束"算：date-input 语义是当天仍可交付，此前按 UTC 午夜算，东八区当天上午 8 点后就判"已过期"
    // eslint-disable-next-line react-hooks/purity -- 日程投影按"天"粒度，同帧内时间戳无副作用，重排一毫秒都不影响结论
    const days = Math.ceil((new Date(`${deadline}T23:59:59`).getTime() - Date.now()) / 86400000);
    if (days <= 0) return { verdict: "已过期", perDay: 0, days: 0 };
    const perDay = remainingDays / days;
    return {
      verdict: perDay <= 1 ? "按正常节奏可达" : perDay <= 1.6 ? "偏紧——需要加时间或砍范围" : "以现在的节奏到不了",
      perDay: Math.round(perDay * 10) / 10,
      days,
    };
  })();

  return (
    <div>
      <PageBackBar title={goal.topic} parentLabel="学习教练" parentHref="/learn" />

      <PageHeader
        title={goal.topic}
        desc={goal.direction}
        right={
          <div className="hidden sm:block">
            <ProgressRing value={progress.ratio} size={64} label={`${Math.round(progress.ratio * 100)}%`} />
          </div>
        }
      />

      {/* 日程投影（可选,视图层）：E2 降为次要信息——默认折叠，不占首屏（有 deadline 才用） */}
      <details className="mb-6 rounded-2xl border border-border bg-white px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-ink-dim">
          日程投影（可选）
          {deadline ? <span className="ml-2 text-xs text-accent">已设截止 {deadline}</span> : null}
        </summary>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm font-bold text-ink">按截止日期反推节奏</p>
          <span className="text-[11px] text-ink-dim/70">可选：有硬截止日期才填,计划本身不承诺日期</span>
          {/* ml-auto 包一层宽度自适应的壳：Input 基类是 w-full，直接写 w-auto 覆盖
              会在无 tailwind-merge 的 cn 里靠样式表发射顺序赌胜负（Skeleton rounded 教训） */}
          <div className="ml-auto">
            <Input
              type="date"
              value={deadline}
              onChange={(e) => setDeadlineDate(e.target.value)}
            />
          </div>
        </div>
        {projection && (
          <p className="mt-2.5 text-[13px] leading-relaxed text-ink-dim">
            剩 <b className="tabular text-ink">{remainingDays}</b> 个学习日，距 {deadline} 还有{" "}
            <b className="tabular text-ink">{projection.days}</b> 天 → 平均每天要完成{" "}
            <b className={cn("tabular", projection.perDay > 1.6 ? "text-bad" : projection.perDay > 1 ? "text-warn" : "text-ok")}>
              {projection.perDay}
            </b>{" "}
            个学习日。{projection.verdict}。
          </p>
        )}
      </details>

      {/* E2 验收 2：完成 / 跳过 / 掌握分别标注，不用一个百分比混为一谈 */}
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone="accent">{DOMAIN_LABELS[goal.domainKind]}</Badge>
        <Badge tone="dim">每周 {goal.weeklyHours} 小时</Badge>
        {goal.deadline && <Badge tone="warn">截止 {formatDate(goal.deadline)}</Badge>}
        <Badge tone="ok">已完成 {progress.passed} 天</Badge>
        <Badge tone="warn">已跳过 {progress.skipped} 天</Badge>
        <Badge tone="accent">含掌握证据 {progress.mastered} 天</Badge>
        <Badge tone="dim">共 {progress.total} 天</Badge>
        {goal.plan && <Badge tone="dim">启动 {formatDate(goal.plan.startDate)}</Badge>}
      </div>

      {/* E2：当前阶段 + 当前任务作为主区域的引导条（进入即知道在哪、下一步做什么） */}
      {activePhase && (
        <Card className="mb-4 border-accent/30 bg-accent/[0.04]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">
                当前阶段 · {phaseName(activePhase.title)}
              </p>
              <p className="mt-1 break-words text-base font-semibold text-ink">
                {activeDay?.title ?? "下一步：展开本阶段第一个学习日"}
              </p>
              {activePhase.outcome && (
                <p className="mt-1 break-words text-sm text-ink-dim">阶段目标：{activePhase.outcome}</p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  document.getElementById("plan-timeline")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                完整路线
              </Button>
            </div>
          </div>
        </Card>
      )}

      {goal.plan && viewDay && viewDayLocked && (
        <PhasePaywall phaseIndex={phaseIndexOf(viewDay)} />
      )}
      {goal.plan && viewDay && !viewDayLocked && (
        <LearnBody
          goal={goal}
          viewDay={viewDay}
          activeDayId={activeDay?.id ?? null}
          selectedDayId={viewDayId}
          onSelect={setViewDayId}
          readOnly={viewDay.id !== activeDay?.id}
          tone={settings.coachTone ?? "standard"}
        />
      )}
      {/* 阶段还没目录：先给阶段概览 + 自动生成进度（生成完会自动进入第一天） */}
      {goal.plan && !viewDay && activePhase && activePhaseLocked && (
        <PhasePaywall phaseIndex={goal.plan.phases.findIndex((p) => p.id === activePhase.id)} />
      )}
      {goal.plan && !viewDay && activePhase && !activePhaseLocked && (
        <PhasePlanPanel goal={goal} phase={activePhase} />
      )}
      {goal.plan && !viewDay && !activePhase && (
        <GraduationPanel goal={goal} />
      )}
      {!goal.plan && (
        <RegeneratePlan goal={goal} />
      )}
    </div>
  );
}

export default function GoalDetailPage() {
  return (
    <Suspense fallback={<Skeleton className="h-40 rounded-2xl bg-surface/60" />}>
      <GoalDetailInner />
      {/* 重排确认 Modal 的宿主：挂在根部，计划视图/学习窗口/新标签页都能唤起 */}
      <PhaseRegenNoteHost />
      {/* 恢复历史版本确认 Modal 的宿主：同上（window.confirm 的阻塞式原语替代） */}
      <PlanRestoreConfirmHost />
    </Suspense>
  );
}

/* ================= 目标详情主体：手机当前日优先，路径折叠为任务导航（PRD §5.3） ================= */
function LearnBody({
  goal,
  viewDay,
  activeDayId,
  selectedDayId,
  onSelect,
  readOnly,
  tone,
}: {
  goal: Goal;
  viewDay: DayPlan;
  activeDayId: string | null;
  selectedDayId: string | null;
  onSelect: (id: string | null) => void;
  readOnly: boolean;
  tone: "standard" | "gentle";
}) {
  /* 手机：任务导航默认收起（当前日才是主任务）；桌面始终双栏 */
  const [navOpen, setNavOpen] = useState(false);
  const { user } = useAuth();
  const freeTier = isFreeTier(user);
  const remainingDays = countRemainingDays(goal);

  return (
    <>
      {/* 手机任务导航条：一眼可见当前进度 + 展开/收起（M1 可发现性） */}
      <button
        onClick={() => setNavOpen((v) => !v)}
        aria-expanded={navOpen}
        className="mb-4 flex w-full cursor-pointer items-center gap-2 rounded-xl border border-border bg-white px-3.5 py-2.5 text-left text-[13px] text-ink transition hover:bg-black/[0.02] lg:hidden"
      >
        <ListOrdered className="size-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate font-medium">任务导航 · {goal.topic}</span>
        <span className="tabular shrink-0 text-xs text-ink-dim">
          {Object.values(goal.plan?.days ?? {}).filter((d) => d.status === "passed" || d.status === "skipped").length}
          /{Object.values(goal.plan?.days ?? {}).length} 天
        </span>
        <ChevronRight className={cn("size-4 shrink-0 text-ink-dim transition", navOpen && "rotate-90")} />
      </button>

      <div className="grid gap-6 lg:grid-cols-[300px_1fr] lg:items-start">
        {/* 手机 = 可折叠面板；桌面 = sticky 侧栏（行为不变） */}
        <div className={cn("lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto", navOpen ? "block" : "hidden lg:block")}>
          <PlanTimeline
            goal={goal}
            freeTier={freeTier}
            freePhaseLimit={FREE_PHASE_LIMIT}
            activeDayId={activeDayId}
            selectedDayId={selectedDayId}
            onSelect={(id) => {
              onSelect(id);
              setNavOpen(false); // 选完当天收起导航，正文立刻占据首屏
            }}
          />
          {/* 手机折叠态的收起出口；桌面隐藏 */}
          {navOpen && (
            <Button variant="ghost" size="sm" className="mt-2 w-full lg:hidden" onClick={() => setNavOpen(false)}>
              收起导航
            </Button>
          )}
          {remainingDays === 0 && <p className="mt-2 text-center text-xs text-ink-dim lg:hidden">全部学习日已完成。</p>}
        </div>
        {viewDay.stub ? (
          <DayStubPanel goal={goal} day={viewDay} />
        ) : (
          <DayPanel key={viewDay.id} goal={goal} day={viewDay} readOnly={readOnly} onGoToDay={onSelect} tone={tone} />
        )}
      </div>
    </>
  );
}

/* ================= 结业面板：最后一个阶段过门后的成就回路 ================= */
function GraduationPanel({ goal }: { goal: Goal }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const graduated = Boolean(goal.graduatedAt);
  const nextSteps = goal.nextSteps ?? [];

  const days = goal.plan ? Object.values(goal.plan.days) : [];
  const done = days.filter((d) => d.status === "passed" || d.status === "skipped").length;
  const skipped = days.filter((d) => d.status === "skipped").length;
  const points = days.flatMap((d) => d.knowledgePoints || []);
  const durable = points.filter((k) => k.historicalHighest === "durable").length;
  const transferable = points.filter((k) => k.historicalHighest === "transferable").length;

  const generate = async () => {
    setBusy(true);
    setError(null);
    const r = await runGraduation(goal.id);
    setBusy(false);
    if (!r.ok) {
      setError(r.error || "生成失败");
      toast.error("结业总结没生成成功：" + (r.error || "未知错误"));
      return;
    }
    toast.success("结业笔记已写入第二大脑");
  };

  return (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        <Trophy className="mt-0.5 size-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-ink">这个目标走完了</h2>
          <p className="mt-1 text-sm text-ink-dim">
            {done}/{days.length} 天完成
            {skipped > 0 ? `（其中强制跳过 ${skipped} 天）` : ""} · 知识点 {points.length} 条
            {durable > 0 ? ` · 长期保持 ${durable}` : ""}
            {transferable > 0 ? ` · 能迁移 ${transferable}` : ""}
          </p>

          {!graduated && (
            <div className="mt-4">
              <p className="text-sm text-ink-dim">
                再补一份结业总结：把你真正学会的能力、走过的坑、仍然薄弱的地方写进第二大脑，
                并给出最多三条下一步建议（只建议，不会自动创建新目标）。
              </p>
              <Button className="mt-3" size="sm" onClick={generate} disabled={busy}>
                {busy ? "生成中…" : "生成结业笔记与下一步"}
              </Button>
              {error && <p className="mt-2 text-xs text-bad">{error}</p>}
            </div>
          )}

          {graduated && (
            <div className="mt-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {goal.graduationNoteId && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => router.push(`/brain?note=${encodeURIComponent(goal.graduationNoteId!)}`)}
                  >
                    <BookMarked className="mr-1.5 size-3.5" />
                    打开结业笔记
                  </Button>
                )}
                <Badge tone="ok">结业于 {formatDate(goal.graduatedAt!.slice(0, 10))}</Badge>
              </div>
              {nextSteps.length > 0 && (
                <div className="rounded-xl border border-border bg-surface-2/60 p-3.5">
                  <p className="text-xs font-bold text-ink-dim">下一步建议（选一个再说，不自动创建）</p>
                  <ul className="mt-2 space-y-1.5">
                    {nextSteps.map((s, i) => (
                      <li key={i} className="flex gap-2 text-sm text-ink">
                        <span className="text-ink-3">{i + 1}.</span>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ================= 阶段天级计划面板（两级计划的第二级） ================= */
/* 长任务的小步重试：每批请求本身很短，偶发断连重发一次即可，不必让用户重走完整流程 */
async function chatWithRetry(tries: number, run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (e) {
    if (tries <= 1) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    return chatWithRetry(tries - 1, run);
  }
}

/** 弱网/隧道掐断长连接时浏览器抛 TypeError("Failed to fetch"/"network error")，直译给用户是懵的。
 *  本页全部生成入口（目录/细节/讲义/判分/答疑/重排/重新生成总纲）统一走这里，
 *  别再写 `toast.error(e instanceof Error ? e.message : …)`——断网/Zod 转储会原样甩给用户。
 *  networkHint：目录/细节流程拆了小批可以补充说明；单请求流程用默认句。 */
function friendlyGenError(
  e: unknown,
  fallback = "生成失败，请重试",
  networkHint = "再点一次按钮重试即可。"
): string {
  const msg = e instanceof Error ? e.message : "";
  if (e instanceof TypeError || /failed to fetch|network error|load failed/i.test(msg)) {
    return `网络中断了，这次没生成完。${networkHint}`;
  }
  /* AbortSignal.timeout 触发抛 TimeoutError（本页生成调用现已带客户端总预算，
   * 上游/网关挂死被掐断时用户看到的应该是「可重试」而不是裸的 "signal timed out"） */
  if (e instanceof Error && (e.name === "TimeoutError" || /timed? ?out/i.test(msg))) {
    return `等太久了，这次没生成完。${networkHint}`;
  }
  /* ZodError.message 是英文校验字段转储（形状不符=模型偶发跑偏），直译同样让人懵 */
  if (e instanceof Error && e.name === "ZodError") {
    return "AI 这次返回的内容格式不对，再点一次重试即可（偶发，不影响已保存的进度）。";
  }
  return msg || fallback;
}

/* ================= 生成流程：目录一次出全，单日按需展开 =================
 * 旧实现的痛点是「等整阶段细节全部生成完」：一次请求几分钟、退出即断、刷新只剩前两天还没目录。
 * 现在分三步，每一步都可单独重试、都可落盘：
 *   ① 目录：一次生成全阶段的天标题+目录级知识点（小请求，几十秒）→ 立刻完整可见；
 *   ② 前两天：目录落盘后马上展开第 1、2 天细节（用户马上要学）；
 *   ③ 滚动：每学完/跳过一天，就把后面 2 天展开好；剩下的天永远是「目录里的待生成」。
 * 资源链接体检改为异步补做，不再挡在生成主链路上。 */

const dayNo = (title: string) => title.replace(/^Day\s*\d+[：:]\s*/, "");

/** AI 原始输出的资源 URL 落库前过闸：只放行 http(s)，
 *  免得 refine 链路失败时把 javascript: 之类的原始值永久留在档里。 */
function sanitizeResUrls(resources: DayPlan["resources"]): DayPlan["resources"] {
  return resources.map((r) => (r.url && !/^https?:\/\//i.test(r.url) ? { ...r, url: undefined } : r));
}

/** 生成用的学习背景（目录/细节共用） */
function genCtx(goal: Goal, phase: NonNullable<Goal["plan"]>["phases"][number]) {
  const plan = goal.plan!;
  const mastered = Object.values(plan.days)
    .filter((d) => d.status === "passed" || d.status === "skipped")
    .flatMap((d) => d.knowledgePoints.map((k) => k.text));
  const weakPoints = goal.quizLog
    .filter((q) => !q.passed)
    .slice(0, 5)
    .flatMap((q) => {
      const d = plan.days[q.dayId];
      return d ? [`${d.title}（${q.items.filter((i) => i.verdict === "incorrect").length} 题未过）`] : [];
    });
  const maxDays = Math.min(Math.max(phase.estDays ?? 6, 2), 8);
  const ctx = JSON.stringify(
    {
      goal: {
        topic: goal.topic,
        direction: goal.direction,
        background: goal.background,
        domainKind: goal.domainKind,
        weeklyHours: goal.weeklyHours,
        learnerProfile: goal.learnerProfile ?? [],
      },
      masterSummary: plan.summary,
      phase: {
        title: phase.title,
        outcome: phase.outcome,
        outline: phase.outline ?? [],
        boundary: phase.boundary ?? "",
        estDays: phase.estDays ?? null,
        maxDays,
      },
      mastered,
      weakPoints,
    },
    null,
    1
  );
  return { ctx, maxDays };
}

/* 后台任务注册表（模块级，不随组件卸载丢失）：切页不中断，回来自动接上；
 * 每完成一步立即落盘，整页刷新也只丢正在跑的那一次调用。 */
type BgEntry = {
  busy: boolean;
  progress: string;
  thinking: boolean;
  error: string | null;
  doneAt: number | null;
};
const bgGen = new Map<string, BgEntry>();
const dayRuns = new Map<string, Promise<void>>();
/* 阶段重排的在途信号（模块级，与 bgGen 同寿命）：让「正在重排」的等待行能提供
 * 取消入口——重排是整段 LLM 目录生成（几秒到几十秒），旧实现只能干等。 */
const phaseRegenAbort = new Map<string, AbortController>();
const genKey = (kind: "catalog" | "detail", goalId: string, id: string) => `${kind}:${goalId}:${id}`;

/** 订阅某个后台任务的状态（700ms 轮询，字段不变不重渲染） */
function useGenState(key: string) {
  const [snap, setSnap] = useState<BgEntry | undefined>(() => bgGen.get(key));
  useEffect(() => {
    const sync = () => {
      const st = bgGen.get(key);
      const next = st ? { ...st } : undefined;
      setSnap((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    sync();
    const t = setInterval(sync, 700);
    return () => clearInterval(t);
  }, [key]);
  return snap;
}

/** 展开单日细节（目录 id 复用；同一天并发去重） */
function runDayDetail(goalId: string, dayId: string): Promise<void> {
  const k = `${goalId}:${dayId}`;
  const running = dayRuns.get(k);
  if (running) return running;
  const p = (async () => {
    const { streamChat, phasePlanSchema } = await import("@/lib/ai/client");
    const { phaseDraftToDay } = await import("@/lib/plan");
    const initial = useAppStore.getState();
    const goal = initial.goals.find((g) => g.id === goalId);
    const day = goal?.plan?.days[dayId];
    const phase = goal?.plan?.phases.find((ph) => ph.id === day?.phaseId);
    if (!goal?.plan || !day || !phase || !day.stub) return;
    const { ctx } = genCtx(goal, phase);
    const daysJson = JSON.stringify([
      { title: day.title, knowledgePoints: day.knowledgePoints.map((kp) => kp.text) },
    ]);
    const raw = await chatWithRetry(2, () =>
      streamChat({
        task: "plan",
        args: { mode: "phase-detail", ctx, boundary: phase.boundary ?? "", days: daysJson },
        messages: [{ role: "user", content: "为指定的这一天写出完整细节（只要 JSON）。" }],
        /* 流中段挂起 → bgGen 的 busy 恒真、占位日永卡「生成中」（重试入口被
         * `if (bgGen.get(key)?.busy) return` 拒绝），只能整页刷新。graduation.ts:87
         * 的同款客户端兜底；长任务服务端头部预算 120s，放宽到 180s 只兜死挂。
         * 信号在 chatWithRetry 的重试回调里创建：每次尝试各自有全新预算。 */
        signal: AbortSignal.timeout(180_000),
        onDelta: () => {},
      })
    );
    const parsed = phasePlanSchema.parse(extractJson(raw)).days[0];
    if (!parsed) throw new Error("这一天没拿到细节，请重试");
    const built = phaseDraftToDay(parsed, phase.id, dayId);
    const current = useAppStore.getState();
    const latest = current.goals.find((item) => item.id === goalId)?.plan;
    if (current._storeUserId !== initial._storeUserId || latest?.days[dayId] !== day) return;
    const resources = sanitizeResUrls(built.resources);
    current.setDayDetail(goalId, phase.id, dayId, { ...built, resources });
    /* 链接体检/替换异步补做：绝不挡「今天能不能开始学」，坏链发现后再静默换掉 */
    const resourceContext = [goal.topic, goal.direction, goal.background, ...(goal.learnerProfile ?? []), ...(goal.intakeTranscript ?? []).filter((turn) => turn.role === "user").map((turn) => turn.content), phase.title, built.title, built.method, ...built.knowledgePoints.map((point) => point.text)].filter(Boolean).join("\n");
    const resourceQuery = requiresVideoResources(resourceContext)
      ? buildStudyResourceQuery(goal.topic, built.title, built.knowledgePoints.map((point) => point.text))
      : undefined;
    void refineResources(built.resources, resourceContext, resourceQuery)
      .then((rs) => {
        const store = useAppStore.getState();
        const saved = store.goals.find((item) => item.id === goalId)?.plan?.days[dayId];
        if (store._storeUserId === initial._storeUserId && saved?.resources === resources) {
          store.updateDayResources(goalId, dayId, rs);
        }
      })
      .catch(() => {});
  })();
  dayRuns.set(k, p);
  void p.then(
    () => dayRuns.delete(k),
    () => dayRuns.delete(k)
  );
  return p;
}

/** 单日展开的可见任务（错误可重试；与目录流程共享 runDayDetail 去重） */
function ensureDayDetail(goalId: string, dayId: string): void {
  const key = genKey("detail", goalId, dayId);
  if (bgGen.get(key)?.busy) return;
  const goal = useAppStore.getState().goals.find((g) => g.id === goalId);
  const day = goal?.plan?.days[dayId];
  if (!goal?.plan || !day?.stub) return;
  const st: BgEntry = { busy: true, progress: "正在展开这一天的内容…", thinking: false, error: null, doneAt: null };
  bgGen.set(key, st);
  void (async () => {
    try {
      await runDayDetail(goalId, dayId);
    } catch (e) {
      console.error(e);
      st.error = friendlyGenError(e, "生成失败，请重试", "天级计划已按「天」拆成小批生成——再点一次按钮重试即可，不会再卡在单个长请求上。");
    } finally {
      st.busy = false;
      st.progress = "";
      st.doneAt = Date.now();
    }
  })();
}

/** 阶段目录：一次排齐全阶段的天（只出目录，细节留给按天展开） */
function ensurePhaseCatalog(goalId: string, phaseId: string): void {
  const key = genKey("catalog", goalId, phaseId);
  if (bgGen.get(key)?.busy) return;
  const goal = useAppStore.getState().goals.find((g) => g.id === goalId);
  const phase = goal?.plan?.phases.find((ph) => ph.id === phaseId);
  if (!goal?.plan || !phase || phase.catalog?.length) return;
  const st: BgEntry = { busy: true, progress: "正在排出本阶段的全部学习日…", thinking: false, error: null, doneAt: null };
  bgGen.set(key, st);
  void (async () => {
    try {
      const { streamChat, phaseListSchema } = await import("@/lib/ai/client");
      const { ctx, maxDays } = genCtx(goal, phase);
      const raw = await chatWithRetry(2, () =>
        streamChat({
          task: "plan",
          args: { mode: "phase-list", ctx, maxDays },
          messages: [{ role: "user", content: `先只输出这个阶段的学习日目录（最多 ${maxDays} 天，只要 JSON）。` }],
          /* 客户端总预算（graduation.ts:87 同款兜底）：流中段挂起时 busy 恒真。
           * 每次重试各自新建信号，预算互不共享。 */
          signal: AbortSignal.timeout(180_000),
          onDelta: () => {},
          onThink: () => {
            st.thinking = true;
          },
        })
      );
      const list = phaseListSchema.parse(extractJson(raw));
      const boundary = list.boundary?.trim() || phase.boundary || "";
      const days = list.days.slice(0, maxDays);
      /* 老数据（此前只生成过前两天、没有目录）也能无损续上：已展开的天按顺序沿用 id */
      const fresh = useAppStore.getState().goals.find((g) => g.id === goalId);
      const freshPhase = fresh?.plan?.phases.find((ph) => ph.id === phaseId);
      if (!fresh?.plan || !freshPhase) return;
      const detailed = freshPhase.dayIds
        .map((id) => fresh.plan!.days[id])
        .filter((d) => d && !d.stub);
      const catalog = days.map((d, i) => {
        /* 老数据已展开的天：沿用原 id/标题/知识点，保证目录与正文一致；
         * 只有目录里新补的天才用模型这次的标题。 */
        const old = detailed[i];
        if (old) {
          return { id: old.id, title: old.title, knowledgePoints: old.knowledgePoints.map((kp) => kp.text) };
        }
        return {
          id: freshPhase.catalog?.[i]?.id ?? uid("day"),
          title: `Day ${i + 1}：${dayNo(d.title)}`,
          knowledgePoints: d.knowledgePoints
            .map((kp) => (typeof kp === "string" ? kp : kp.text))
            .slice(0, 8),
        };
      });
      /* 目录比已展开的天还短（模型这次排少了）：把多出来的天追加回去，绝不丢已完成/已展开的进度 */
      for (let i = catalog.length; i < detailed.length; i++) {
        catalog.push({
          id: detailed[i].id,
          title: detailed[i].title,
          knowledgePoints: detailed[i].knowledgePoints.map((kp) => kp.text),
        });
      }
      useAppStore.getState().setPhaseCatalog(goalId, phaseId, boundary, catalog);
      /* 前两天的细节先展开（用户马上要学），之后保持「当前天 + 下一天」两天就绪 */
      st.progress = "目录已就绪，正在展开第 1 天…";
      ensureDayDetail(goalId, catalog[0].id);
      await runDayDetail(goalId, catalog[0].id);
      if (catalog[1]) {
        st.progress = "正在展开第 2 天…";
        ensureDayDetail(goalId, catalog[1].id);
        await runDayDetail(goalId, catalog[1].id);
      }
      /* 阶段目录进第二大脑（用目录本身，不依赖细节是否展开）。
       * 标题契约走 plan.ts 唯一真源：learn/new 纲要笔记的 [[wikilink]] 按同样的
       * 函数拼标题，失配即链接静默悬空。 */
      const masterNote = planOutlineNoteTitle(goal.topic);
      useAppStore.getState().addKnowledge(
        [{
          title: planPhaseNoteTitle(goal.topic, phase.title),
          body: `**阶段目标：**${phase.outcome}\n\n**边界：**${boundary || "—"}\n\n## 学习日目录\n\n${catalog
            .map((c) => `- **${dayNo(c.title)}** — ${c.knowledgePoints.join("、")}`)
            .join("\n")}\n\n关联：[[${masterNote}]]`,
          domain: `${goal.topic}/计划`,
        }],
        "learn",
        `${goal.topic} · 阶段目录`
      );
    } catch (e) {
      console.error(e);
      st.error = friendlyGenError(e, "生成失败，请重试", "天级计划已按「天」拆成小批生成——再点一次按钮重试即可，不会再卡在单个长请求上。");
    } finally {
      st.busy = false;
      st.thinking = false;
      st.progress = "";
      st.doneAt = Date.now();
    }
  })();
}

/** 滚动预取：保持「当前天 + 下一天」两天是展开好的。
 *  阶段开始只备第 1、2 天；用户学到第 2 天时，才把第 3 天展开，不会提前把整阶段跑完。 */
function prefetchUpcoming(goalId: string, fromDayId: string, count = 1): void {
  const goal = useAppStore.getState().goals.find((g) => g.id === goalId);
  const day = goal?.plan?.days[fromDayId];
  const phase = goal?.plan?.phases.find((ph) => ph.id === day?.phaseId);
  if (!goal?.plan || !day || !phase) return;
  const ids = (phase.catalog ?? phase.dayIds.map((id) => ({ id }))).map((c) => c.id);
  const idx = ids.indexOf(fromDayId);
  if (idx < 0) return;
  // 下一天已经展开 → 缓冲够了，不再往后预取
  if (ids[idx + 1] && !goal.plan.days[ids[idx + 1]]?.stub) return;
  const targets = ids
    .slice(idx + 1, idx + 1 + count)
    .filter((id) => goal.plan!.days[id]?.stub);
  if (!targets.length) return;
  void (async () => {
    for (const id of targets) {
      try {
        await runDayDetail(goalId, id);
      } catch {
        /* 预取失败：用户真正学到那天时再自动重试 */
      }
    }
  })();
}

/* 免费版阶段付费墙（PRD §4.2）：讲清楚已有成果 + 解锁什么 + 数据不会消失 */
function PhasePaywall({ phaseIndex }: { phaseIndex: number }) {
  return (
    <Card className="mb-6">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-white text-warn">
          <Lock className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">阶段 {phaseIndex + 1} 起为会员内容</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-dim">
            免费版包含<b className="text-ink">前两个完整阶段</b>——足够走完一个从目标到验收的最小学习闭环。
            你已经完成的阶段、笔记和全部历史都还在，随时可以回看；升级会员即可解锁后面的阶段继续深入。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/membership">
              {/* 价格读 pricing.ts（唯一真源），别写死数字——改价只改 pricing.ts 一个文件 */}
              <Button size="sm">
                查看会员（¥{priceLabel(PLANS.month.price)}/月 · ¥{priceLabel(PLANS.year.price)}/年）
              </Button>
            </Link>
            <Link href="/membership">
              <Button variant="outline" size="sm">已有激活码？去兑换</Button>
            </Link>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* 重排确认对话框（页面根部挂载一份）：window.prompt 的替代。
 * prompt 单行、阻塞主线程、排不下破坏性警示长文案，且被浏览器策略禁用后返回
 * null 直接 return——重排功能静默失效、点击无任何响应。Modal 走设计系统
 * （role=dialog/焦点陷阱/Esc/滚动锁），用户意见经 Promise 桥交回模块级的
 * regenPhaseFlow（它不是组件，拿不到 state）。 */
let askPhaseRegenNote: ((label: string, doneDays: number) => Promise<string | null>) | null = null;

function PhaseRegenNoteHost() {
  const [ask, setAsk] = useState<{
    label: string;
    doneDays: number;
    resolve: (note: string | null) => void;
  } | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    askPhaseRegenNote = (label, doneDays) =>
      new Promise<string | null>((resolve) => {
        setNote("");
        setAsk({ label, doneDays, resolve });
      });
    return () => {
      askPhaseRegenNote = null;
    };
  }, []);
  const close = (v: string | null) => {
    ask?.resolve(v);
    setAsk(null);
  };
  return (
    <Modal open={!!ask} onClose={() => close(null)} title={ask ? `重排「${ask.label}」` : "重排"}>
      <p className="text-sm text-ink-dim">说说你不满意什么 / 想怎么换（留空 = 换一批角度）。</p>
      <Textarea
        className="mt-3 resize-y"
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="例：进度太碎、想多练实战、每天负担太重…"
      />
      {ask && ask.doneDays > 0 && (
        <p className="mt-3 rounded-xl border border-warn/40 bg-warn/[0.06] p-3 text-xs leading-relaxed text-warn">
          ⚠ 该阶段已有 {ask.doneDays} 个完成的学习日。标题相同的天会保留学习记录，其余会被替换（旧目录会存进历史版本，可回看）。
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={() => close(null)}>
          取消
        </Button>
        <Button onClick={() => close(note)}>开始重排</Button>
      </div>
    </Modal>
  );
}

/* 恢复计划历史版本的确认对话框：window.confirm 的替代（与 PhaseRegenNoteHost 同一模式）。
 * confirm 是阻塞式原语——被浏览器策略禁用（跨域 iframe 未带 allow-modals、sandbox 容器）后
 * 返回 false 直接 return，「恢复」按钮表现为点击无任何响应；同文件 1160-1164 行注释记录的
 * 正是这一失效模式，重排路径已为此专门建了 Modal + Promise 桥，恢复路径同一环境同一问题。
 * Modal 走设计系统（role=dialog/焦点陷阱/Esc/滚动锁），结果经 Promise 桥交回 PlanTimeline。 */
let askRestoreConfirm: ((label: string) => Promise<boolean>) | null = null;

function PlanRestoreConfirmHost() {
  const [ask, setAsk] = useState<{ label: string; resolve: (ok: boolean) => void } | null>(null);
  useEffect(() => {
    askRestoreConfirm = (label) =>
      new Promise<boolean>((resolve) => {
        setAsk({ label, resolve });
      });
    return () => {
      askRestoreConfirm = null;
    };
  }, []);
  const close = (ok: boolean) => {
    ask?.resolve(ok);
    setAsk(null);
  };
  return (
    <Modal open={!!ask} onClose={() => close(false)} title="恢复此历史版本？">
      <p className="text-sm text-ink-dim">
        恢复会把该阶段计划结构改回旧目录；之后新增的笔记/成绩保留，只回退这次计划变更。
      </p>
      {ask && (
        <p className="mt-3 rounded-xl border border-warn/40 bg-warn/[0.06] p-3 text-xs leading-relaxed text-warn">
          ⚠ 即将恢复：{ask.label}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={() => close(false)}>
          取消
        </Button>
        <Button onClick={() => close(true)}>确认恢复</Button>
      </div>
    </Modal>
  );
}

/* 重排本阶段的确认与执行（PhasePlanPanel / PlanTimeline 共用）：
 * 旧实现两处各写一份 window.prompt → toast → regeneratePhase 的异步 handler，
 * 且文案已漂移——PhasePlanPanel 版缺「同名天保留学习记录/旧目录进历史版本」的
 * 破坏性操作警示，同一 regeneratePhase 调用从不同入口进入得到的删除风险提示不一致。
 * 收口成一份：确认文案、执行与结果提示只维护在这一处。 */
async function regenPhaseFlow(
  goal: Goal,
  phase: NonNullable<Goal["plan"]>["phases"][number],
  label: string
): Promise<void> {
  /* 重入守卫 + 进行中状态：regeneratePhase 是几十秒级的 AI 长调用，旧实现唯一反馈是
   * 一条几秒即消失的 toast（sonner 默认时长），期间无 spinner/禁用态、两个入口按钮均可
   * 再点——重复点击会并发跑两个 regeneratePhase（双份费用、两次 snapshotPhase、后者
   * setPhaseCatalog 覆盖前者）。复用 ensurePhaseCatalog 的 bgGen 通道：PhasePlanPanel
   * 已订阅 catalog 键，busy/progress/error 直接有全套展示。 */
  const key = genKey("catalog", goal.id, phase.id);
  if (bgGen.get(key)?.busy) {
    toast("这个阶段已经在重排/生成中，等它完成。");
    return;
  }
  const ids = phase.catalog?.length ? phase.catalog.map((c) => c.id) : phase.dayIds;
  const doneDays = ids.filter((id) => {
    const d = goal.plan!.days[id];
    return d && (d.status === "passed" || d.status === "skipped");
  }).length;
  if (!askPhaseRegenNote) {
    toast.error("重排确认框没就绪，请刷新页面后重试。");
    return;
  }
  const note = await askPhaseRegenNote(label, doneDays);
  if (note === null) return; // 用户取消
  const st: BgEntry = { busy: true, progress: "正在重排这一阶段的学习日…", thinking: false, error: null, doneAt: null };
  bgGen.set(key, st);
  toast("正在重排…");
  /* 取消入口：整段 LLM 目录生成可跑几十秒，用户必须能中止（否则只能等）。
   * 信号同时充当客户端总预算兜底：流中段挂起时 busy 恒真、无恢复入口。 */
  const ac = new AbortController();
  phaseRegenAbort.set(key, ac);
  try {
    const { regeneratePhase } = await import("@/lib/agent/phase-regen");
    /* 等待反馈：整段目录生成可达数十秒，toast 4 秒即消失。onThink 把思考心跳透进
     * bgGen.thinking，PhasePlanPanel 的进度行才会显示「模型思考中——通常一分钟内返回」。
     * 重入由上方 bgGen.busy 守卫拦（两个入口按钮点击都会先撞这道闸）。 */
    const r = await regeneratePhase(goal.id, phase.id, note.trim(), true, ac.signal, {
      onThink: () => {
        st.thinking = true;
      },
    });
    if (r.ok) toast.success(r.summary + "——目录已重排，逐天进入时重新展开。");
    else if (ac.signal.aborted) {
      /* regeneratePhase 内部把 AbortError 收成 ok:false 返回——用户主动取消不是失败。 */
      toast("已取消重排，原目录未动");
    } else {
      st.error = r.content;
      toast.error(r.content);
    }
  } catch (e) {
    if (ac.signal.aborted) {
      /* 用户主动取消：不是失败，不落错误态（原目录未动）。 */
      toast("已取消重排，原目录未动");
    } else {
      /* 部署后旧页面加载不到已不存在的 chunk 时，动态 import 同样会 reject（use-chat.ts
       * 记载的同款 stale-chunk 场景）——不接住就变成未捕获 rejection，「正在重排…」
       * 永不收敛、无错误提示无恢复入口，表现为点了没反应。 */
      st.error = friendlyGenError(e, "重排失败，请重试");
      toast.error(st.error);
    }
  } finally {
    phaseRegenAbort.delete(key);
    st.busy = false;
    st.progress = "";
    st.thinking = false;
    st.doneAt = Date.now();
  }
}

/** 时间线里的「重排本阶段」入口：订阅 bgGen 的 busy 态，进行中禁用并改文案。
 *  两个入口（阶段卡/时间线）共用同一 bgGen 键，重入守卫在 regenPhaseFlow 内部；
 *  这里只负责把「正在跑」如实显示出来，避免用户以为没点上而反复点。 */
function PhaseRegenEntry({
  goal,
  phase,
  pi,
  className,
}: {
  goal: Goal;
  phase: NonNullable<Goal["plan"]>["phases"][number];
  pi: number;
  className?: string;
}) {
  const st = useGenState(genKey("catalog", goal.id, phase.id));
  const busy = st?.busy ?? false;
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      aria-busy={busy}
      onClick={() => void regenPhaseFlow(goal, phase, `阶段${pi + 1} · ${phase.title}`)}
    >
      {busy ? "正在重排…" : "重排本阶段"}
    </button>
  );
}

function PhasePlanPanel({ goal, phase }: { goal: Goal; phase: NonNullable<Goal["plan"]>["phases"][number] }) {
  const st = useGenState(genKey("catalog", goal.id, phase.id));
  const busy = st?.busy ?? false;
  const error = st?.error ?? null;
  const thinking = st?.thinking ?? false;
  const progress = st?.progress ?? "";
  const hasCatalog = (phase.catalog?.length ?? 0) > 0;

  return (
    <Card className="border-accent/25">
      <Badge tone="accent">下一程</Badge>
      <h2 className="mt-3 text-xl font-bold text-ink">{phaseName(phase.title)}</h2>
      <p className="mt-1.5 flex items-center gap-1.5 text-sm text-accent">
        <Flag className="size-3.5 shrink-0" />
        {phase.outcome}
      </p>
      {phase.estDays && (
        <p className="mt-1 text-xs text-ink-dim">预估 {phase.estDays} 天（按你的实际节奏走）</p>
      )}

      {phase.outline && phase.outline.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
            本阶段要学的（总纲要）
          </p>
          <ul className="space-y-1.5">
            {phase.outline.map((o, i) => (
              <li key={i} className="flex gap-2 text-sm text-ink-dim">
                <span className="tabular text-accent/70">{String(i + 1).padStart(2, "0")}</span>
                {o}
              </li>
            ))}
          </ul>
        </div>
      )}

      {phase.boundary && (
        <p className="mt-4 rounded-xl border border-border bg-surface-2 p-3 text-xs leading-relaxed text-ink-dim">
          <b className="text-ink">边界：</b>{phase.boundary}
        </p>
      )}

      <p className="mt-4 text-xs leading-relaxed text-ink-dim/80">
        进入阶段先一次性排出全部学习日目录（几秒到几十秒），你马上要学的第 1、2 天会立刻展开细节；
        往后每学完一天，系统自动补好后面两天。不必等整个阶段生成完才能开始。
      </p>

      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      {busy && (
        <p className="mt-3 flex items-center gap-2 text-xs text-ink-dim" aria-live="polite">
          <Loader2 className="size-3.5 animate-spin text-accent" />
          {progress || (thinking ? "模型思考中——通常一分钟内返回" : "正在生成…")}
          {/* 重排等待期的取消入口：长生成（几十秒）不得只能干等。只有重排会登记
              phaseRegenAbort（目录生成没有取消手柄，行为不变）。 */}
          {phaseRegenAbort.has(genKey("catalog", goal.id, phase.id)) && (
            <button
              type="button"
              className="ml-auto shrink-0 cursor-pointer font-semibold text-ink-dim hover:text-ink"
              onClick={() => phaseRegenAbort.get(genKey("catalog", goal.id, phase.id))?.abort()}
            >
              取消
            </button>
          )}
        </p>
      )}
      <Button className="mt-5 w-full" onClick={() => ensurePhaseCatalog(goal.id, phase.id)} loading={busy}>
        {busy
          ? "正在生成…"
          : hasCatalog
            ? `目录已就绪（${phase.catalog!.length} 天）· 继续`
            : `生成「${phase.title}」的学习日目录`}
      </Button>
      {hasCatalog && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-2 w-full"
          /* 进行中禁用：regenPhaseFlow 的 bgGen.busy 守卫会拦第二次点击，但按钮保持可点
           * 会让用户以为没点上而反复点（每次都弹确认框）——视觉上也要给出「正在跑」。 */
          disabled={busy}
          onClick={() => void regenPhaseFlow(goal, phase, phase.title)}
        >
          {busy ? "正在重排…" : "重排本阶段（换一批学习日）"}
        </Button>
      )}
    </Card>
  );
}

/* ================= 计划缺失：重新生成 ================= */
function RegeneratePlan({ goal }: { goal: Goal }) {
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const { masterPlanSchema } = await import("@/lib/ai/client");
      const { masterDraftToPlan } = await import("@/lib/plan");
      const card = {
        topic: goal.topic,
        direction: goal.direction || `系统学习${goal.topic}并完成实战`,
        domainKind: goal.domainKind,
        motivation: goal.motivation,
        background: goal.background,
        weeklyHours: goal.weeklyHours,
        learnerProfile: goal.learnerProfile ?? [],
        successCriteria: goal.successCriteria,
        assumptions: goal.assumptions ?? [],
      };
      const full = await streamChat({
        task: "plan",
        args: { mode: "master", cardJson: JSON.stringify(card, null, 2) },
        messages: [{ role: "user", content: "请生成总学习纲要（只要 JSON）。" }],
        /* 客户端总预算（graduation.ts:87 同款兜底）：流中段挂起时 busy 恒真、按钮
         * loading 永不收敛。长任务服务端头部预算 120s，放宽到 180s 只兜死挂。 */
        signal: AbortSignal.timeout(180_000),
        onDelta: () => {},
      });
      const draft = masterPlanSchema.parse(extractJson(full));
      const plan = masterDraftToPlan(draft, { ...card, deadline: null });
      for (const d of Object.values(plan.days)) d.resources = sanitizeResUrls(d.resources);
      useAppStore.getState().setPlan(goal.id, plan);
      toast.success("计划已生成，开始第一天！");
    } catch (e) {
      toast.error(friendlyGenError(e, "生成失败，请重试（模型偶发超时）"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="flex flex-col items-center justify-center border-accent/25 py-14 text-center">
      <p className="text-lg font-bold text-ink">计划还没有生成</p>
      <p className="mt-2 max-w-md text-sm text-ink-dim">
        可能是上次生成超时或解析失败（目标已保存）。点下面重新生成——计划不设日历日期，按你的节奏推进。
      </p>
      <Button className="mt-5" onClick={generate} loading={busy}>
        生成学习计划
      </Button>
    </Card>
  );
}

/* ================= 阶段时间线 ================= */
function PlanTimeline({
  goal,
  freeTier,
  freePhaseLimit,
  activeDayId,
  selectedDayId,
  onSelect,
}: {
  goal: Goal;
  freeTier: boolean;
  freePhaseLimit: number;
  activeDayId: string | null;
  selectedDayId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const plan = goal.plan!;
  const viewDayId = selectedDayId ?? activeDayId;

  return (
    <Card id="plan-timeline">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-dim">
        路径设计
      </p>
      <p className="mb-4 text-sm text-ink-dim">{plan.summary}</p>

      <div className="space-y-4">
        {plan.phases.map((phase, pi) => {
          const paywalled = freeTier && pi >= freePhaseLimit && phase.status !== "passed";
          /* 目录优先：阶段一开始就能看到全部学习日（未展开的标「待生成」） */
          const entries: { id: string; title: string }[] = phase.catalog?.length
            ? phase.catalog
            : phase.dayIds.map((id) => ({ id, title: plan.days[id]?.title ?? "" }));
          const phaseDone = entries.filter((e) => {
            const d = plan.days[e.id];
            return d && (d.status === "passed" || d.status === "skipped");
          }).length;
          return (
            <div key={phase.id}>
              <div className="flex items-center gap-2">
                <StatusDot status={phase.status} />
                <p className="text-sm font-bold text-ink">
                  阶段{pi + 1} · {phaseName(phase.title)}
                </p>
                {phase.status === "passed" && <Badge tone="ok">已通过</Badge>}
                {phase.status === "locked" && <Badge tone="dim">未解锁</Badge>}
                {paywalled && <Badge tone="warn">会员</Badge>}
              </div>
              <p className="mb-1 mt-1 flex items-center gap-1.5 pl-4 text-xs text-ink-dim">
                <Flag className="size-3 shrink-0" />
                {phase.outcome}
              </p>
              {entries.length > 0 && (
                <p className="mb-1.5 pl-4 text-[10px] text-ink-dim/70">
                  目录 {entries.length} 天 · 已完成 {phaseDone} 天
                </p>
              )}
              {/* V26.2-H6（PRD §6.1）：每个阶段都有可见的修改入口——此前只有当前活动阶段
                  能重排，已通过/未解锁阶段零入口。重排语义见 phase-regen.ts（快照+成绩保留）。 */}
              {phase.catalog?.length ? (
                <div className="mb-1.5 pl-4">
                  <PhaseRegenEntry
                    goal={goal}
                    phase={phase}
                    pi={pi}
                    className="cursor-pointer rounded-lg px-2 py-1 text-[11px] text-ink-dim transition hover:bg-surface-2 hover:text-ink disabled:opacity-50 disabled:cursor-default"
                  />
                </div>
              ) : null}
              {/* V26.2-H5：重排历史版本（PRD §6.4/D7——可以找到旧版本） */}
              {(goal.planHistory ?? []).filter((h) => h.phaseId === phase.id).length > 0 && (
                <details className="mb-1.5 ml-4 text-[11px] text-ink-dim">
                  <summary className="cursor-pointer select-none">
                    历史版本（{(goal.planHistory ?? []).filter((h) => h.phaseId === phase.id).length}）
                  </summary>
                  {(goal.planHistory ?? [])
                    .filter((h) => h.phaseId === phase.id)
                    .slice()
                    .reverse()
                    .map((h, hi) => (
                      <div key={h.id ?? hi} className="mt-1 flex items-start gap-1 pl-2 leading-relaxed">
                        <p className="min-w-0 flex-1">
                          {h.at.slice(0, 10)} · {h.reason} · 旧目录 {h.dayIds.length} 天：
                          {h.days.map((d) => d.title).join("、") || "（无天记录）"}
                        </p>
                        {h.id && (
                          <button
                            type="button"
                            className="shrink-0 underline hover:text-accent"
                            onClick={async () => {
                              if (!askRestoreConfirm) {
                                toast.error("恢复确认框没就绪，请刷新页面后重试。");
                                return;
                              }
                              const confirmed = await askRestoreConfirm(
                                `${h.at.slice(0, 10)} · ${h.reason} · 旧目录 ${h.dayIds.length} 天`
                              );
                              if (!confirmed) return; // 用户取消
                              const ok = useAppStore.getState().restorePlanVersion(goal.id, h.id!);
                              if (ok) toast.success("已恢复该版本——只回退了这次计划结构，之后的成绩/笔记未被覆盖。");
                              else toast.error("恢复失败：目标或版本不存在。");
                            }}
                          >
                            恢复
                          </button>
                        )}
                      </div>
                    ))}
                </details>
              )}
              {entries.length === 0 && phase.outline && (
                <ul className="mb-2 ml-1 space-y-1 border-l border-border pl-3">
                  {phase.outline.slice(0, 6).map((o, i) => (
                    <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed text-ink-dim/80">
                      <span className="text-accent/60">{i + 1}.</span>
                      {o}
                    </li>
                  ))}
                  {phase.outline.length > 6 && (
                    <li className="pl-5 text-[11px] text-ink-dim/50">…共 {phase.outline.length} 项</li>
                  )}
                </ul>
              )}
              <div className="ml-1 space-y-1 border-l border-border pl-3">
                {entries.map((entry) => {
                  const day = plan.days[entry.id];
                  const stub = !day || day.stub;
                  /* 锁定与父层 viewDayLocked 同口径：已完成/已跳过的天豁免付费墙；
                   * 重排进来的 locked 新天在已通过阶段里也要上墙（dayViewExempt 为 false）。 */
                  const locked =
                    (!day || day.status === "locked") ||
                    (paywalled && day.status !== "passed" && day.status !== "skipped");
                  return (
                    <button
                      key={entry.id}
                      disabled={locked}
                      onClick={() => onSelect(entry.id)}
                      title={stub ? "已排进目录，学到这天时自动展开讲义与资源" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition",
                        locked
                          ? "cursor-not-allowed text-ink-dim/40"
                          : "cursor-pointer hover:bg-black/[0.04]",
                        viewDayId === entry.id && "bg-accent/[0.09] font-medium text-accent",
                        day?.status === "passed" && "text-ink-dim",
                        day?.status === "skipped" && "text-warn/80"
                      )}
                    >
                      {stub ? (
                        <span aria-hidden className="size-1.5 shrink-0 rounded-full border border-dashed border-ink-dim/60" />
                      ) : (
                        <StatusDot status={day.status} />
                      )}
                      <span className="truncate">{entry.title}</span>
                      {stub ? (
                        <span className="ml-auto shrink-0 text-[10px] text-ink-dim/60">待生成</span>
                      ) : day.status === "passed" ? (
                        <Check className="ml-auto size-3.5 text-ok" />
                      ) : day.status === "skipped" ? (
                        <ChevronRight className="ml-auto size-3.5 text-warn" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {selectedDayId && selectedDayId !== activeDayId && (
        <button
          onClick={() => onSelect(null)}
          className="mt-4 w-full cursor-pointer rounded-lg border border-border py-2 text-xs text-ink-dim hover:bg-black/[0.04]"
        >
          回到当前任务
        </button>
      )}
    </Card>
  );
}

/* ================= 目录占位日：还没展开细节的那一天 ================= */
function DayStubPanel({ goal, day }: { goal: Goal; day: DayPlan }) {
  const st = useGenState(genKey("detail", goal.id, day.id));
  const phase = goal.plan?.phases.find((p) => p.id === day.phaseId);
  const idx = phase?.catalog?.findIndex((c) => c.id === day.id) ?? -1;

  /* 兜底自动展开：进入占位日时后台没在跑（刷新/离线回来）就补一次；失败不自动重试 */
  useEffect(() => {
    if (day.stub && !st?.busy && !st?.error) ensureDayDetail(goal.id, day.id);
  }, [goal.id, day.id, day.stub, st?.busy, st?.error]);

  return (
    <Card className="border-accent/25">
      <div className="flex items-center gap-2">
        <Badge tone="accent">{idx >= 0 ? `目录第 ${idx + 1} 天` : "目录中的一天"}</Badge>
        <Badge tone="dim">待生成</Badge>
      </div>
      <h2 className="mt-2 text-lg font-bold text-ink">{day.title}</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {day.knowledgePoints.map((k) => (
          <Badge key={k.id} tone="dim">
            ◆ {k.text}
          </Badge>
        ))}
      </div>

      {st?.busy ? (
        <p className="mt-4 flex items-center gap-2 text-xs text-ink-dim" aria-live="polite">
          <Loader2 className="size-3.5 animate-spin text-accent" />
          {st.progress || (st.thinking ? "模型思考中——通常一分钟内返回" : "正在生成本日的讲义、资源与验收题…")}
        </p>
      ) : st?.error ? (
        <div className="mt-4">
          <p className="text-xs text-bad">{st.error}</p>
          <Button size="sm" className="mt-2" onClick={() => ensureDayDetail(goal.id, day.id)}>
            重试生成
          </Button>
        </div>
      ) : (
        <p className="mt-4 text-xs text-ink-dim">这一天已排进目录，正在准备内容…</p>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-ink-dim/70">
        目录与进度都已保存：离开、刷新、换设备回来都不用重新生成；前一天验收通过或跳过后，
        这一天会自动展开。
      </p>
    </Card>
  );
}

/* ================= 每日任务面板（含验收门） ================= */
type PanelMode = "learn" | "quiz" | "result";

function RefreshDayResources({ goal, day }: { goal: Goal; day: DayPlan }) {
  const [busy, setBusy] = useState(false);
  const search = async () => {
    if (busy) return;
    const account = useAppStore.getState()._storeUserId;
    const points = day.knowledgePoints.map((point) => point.text);
    const context = [goal.topic, goal.direction, goal.background, ...(goal.learnerProfile ?? []), ...(goal.intakeTranscript ?? []).filter((turn) => turn.role === "user").map((turn) => turn.content), day.title, day.method, ...points].filter(Boolean).join("\n");
    const query = buildStudyResourceQuery(goal.topic, day.title, points);
    setBusy(true);
    try {
      const updated = await refineResources(day.resources, context, query);
      const store = useAppStore.getState();
      const latest = store.goals.find((item) => item.id === goal.id)?.plan?.days[day.id];
      if (store._storeUserId !== account || latest?.resources !== day.resources) return;
      if (updated.every((item) => day.resources.some((old) => old.url === item.url))) {
        toast("暂未找到新的可用资料，可先用当天讲义练习");
        return;
      }
      store.updateDayResources(goal.id, day.id, updated);
      toast.success("已更新当天的学习资料");
    } catch {
      toast.error("暂时无法更新资料，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  return <Button size="sm" variant="outline" loading={busy} onClick={() => void search()}>搜索当天资料</Button>;
}

function DayPanel({
  goal,
  day,
  readOnly = false,
  onGoToDay,
  tone = "standard" as "standard" | "gentle",
  openWindow = true,
}: {
  goal: Goal;
  day: DayPlan;
  readOnly?: boolean;
  /** 严厉度：判分与讲义语气（判分标准不变） */
  tone?: "standard" | "gentle";
  /** 跳过成功后让父组件把视图切到新解锁的一天(传 null=回阶段视图) */
  onGoToDay?: (dayId: string | null) => void;
  /** 是否显示「新窗口学习」入口（学习窗口自身不再显示，避免套娃） */
  openWindow?: boolean;
}) {
  const store = useAppStore;
  const [mode, setMode] = useState<PanelMode>("learn");
  const [lesson, setLesson] = useState(day.lesson ?? "");
  const [lessonLoading, setLessonLoading] = useState(false);
  /* 同步重入守卫（与 loading state 并存）：setLessonLoading 要到重渲染才生效，
   * 同一 tick 内的第二次点击（双击 Enter/极速连点）看不到新 state。 */
  const lessonGenRef = useRef(false);
  /* 验收答案草稿持久化（与 deadline 的 localStorage 草稿同一模式）：DayPanel 以
   * key={viewDay.id} 挂载，切日期/刷新即卸载——验收是长文作答（提交校验明确鼓励
   * 「哪怕写『不知道』」），仅存组件内存时已作答内容会无提示消失。按 goal+day 分键，
   * 判过（pass）后清除（submitQuiz 里的 clearQuizDraft）。onChange 保持原样，
   * 持久化由下方 effect 承担（learn-quiz-grading-locked 的回归锁锚定 onChange 形状）。 */
  const quizDraftKey = `mentora-quiz-draft-${goal.id}-${day.id}`;
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(quizDraftKey);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(quizDraftKey, JSON.stringify(answers)); } catch { /* 忽略 */ }
  }, [answers, quizDraftKey]);
  const clearQuizDraft = () => {
    try { localStorage.removeItem(quizDraftKey); } catch { /* 忽略 */ }
  };
  const [grade, setGrade] = useState<QuizGrade | null>(null);
  const [grading, setGrading] = useState(false);
  /* UI 状态规范（§4.5）：最长等待的两处也要有可见阶段 */
  const [lessonPhases, setLessonPhases] = useState<TracePhase[]>([]);
  const [quizPhases, setQuizPhases] = useState<TracePhase[]>([]);
  const [skipConfirm, setSkipConfirm] = useState(false);
  const [skipText, setSkipText] = useState("");
  const [transferAnswer, setTransferAnswer] = useState<string | null>(null);
  const [transferDone, setTransferDone] = useState(false);

  const done = day.status === "passed" || day.status === "skipped";
  /* store 里的讲义晚到时（云端/另一标签页同步回来）直接用，不必让用户重新生成；
   * 组件内 state 只承载"本次流式生成"的增量，避免在 effect 里同步 setState。 */
  const lessonText = lesson || (day.lesson ?? "");

  /* 生成今日学习文档 */
  const genLesson = async () => {
    /* 重入守卫：讲义是全站最贵的生成且无 AbortController——旧实现流式期间每点一次
     * 「重新生成」就叠加一条完整 streamChat 流（双倍 BYOK 计费），两条流的 flushNow
     * 把各自 buf 交替灌进同一个 lesson state（显示内容来回跳变），结束前两次
     * saveLesson+pushCloud 竞态、后完成者覆盖。 */
    if (lessonGenRef.current) return;
    lessonGenRef.current = true;
    setLessonLoading(true);
    const lessonT0 = performance.now();
    setLessonPhases([{ label: "生成讲义", state: "running", detail: "按今日目标与教学模板撰写" }]);
    // 流式增量也留一份：长生成中途被刷新/断网打断时，至少把已生成的部分保住
    let buf = "";
    /* 流式节流：讲义是产品里最贵最长的生成（数千 token、几百个 chunk）。旧实现每个
     * delta 都 setLesson——整个 DayPanel 以 delta 频率重渲染，<Markdown> 对已累积的
     * 全文重新 parse（成本随文本线性增长、按 chunk 次数累乘，弱设备后半段明显卡顿）。
     * 80ms 批量刷新钳住重渲染频率；收尾 flushNow 兜底最后一个窗口内的增量。 */
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushNow = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      setLesson(buf);
    };
    const saveLesson = async (text: string) => {
      // 以**当前** plan 为基线（生成耗时较长，期间目录/细节可能已更新，
      // 用渲染时闭包里的旧 plan 克隆会把那些更新冲掉）
      const cur = store.getState().goals.find((g) => g.id === goal.id)?.plan ?? goal.plan;
      if (cur) {
        store.getState().updateGoal(goal.id, {
          plan: (() => {
            const plan = structuredClone(cur);
            if (plan.days[day.id]) plan.days[day.id].lesson = text;
            return plan;
          })(),
        });
      }
      // 讲义是最贵的一次生成：立刻上云，不等 2.5s 防抖（刷新/关页就不会再丢）
      const { useAuthStore, pushCloud } = await import("@/lib/auth-client");
      if (useAuthStore.getState().user) void pushCloud();
    };
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const mastered = Object.values(goal.plan?.days ?? {})
        .filter((d) => (d.status === "passed" || d.status === "skipped") && d.id !== day.id)
        .flatMap((d) => d.knowledgePoints.map((k) => k.text));
      const phase = goal.plan?.phases.find((ph) => ph.id === day.phaseId);
      /* 当日主知识类型（取知识点里出现最多的一种）：服务端 DAILY_LESSON 据此
       * 优先按类型选教学模板（prompts.ts:397 的 knowledgeType 路由）。旧实现
       * ctx 只带 knowledgePoints 的纯文本，类型路由在生产链路永不生效——
       * fact 型日子（如雅思词汇）会落到领域模板而非 FACT_LESSON。 */
      const kpTypeTally = new Map<string, number>();
      for (const k of day.knowledgePoints) {
        if (k.knowledgeType) kpTypeTally.set(k.knowledgeType, (kpTypeTally.get(k.knowledgeType) ?? 0) + 1);
      }
      let mainKnowledgeType: string | undefined;
      for (const [t, n] of kpTypeTally) if (!mainKnowledgeType || n > (kpTypeTally.get(mainKnowledgeType) ?? 0)) mainKnowledgeType = t;
      const ctx = JSON.stringify(
        {
          goal: {
            topic: goal.topic,
            direction: goal.direction,
            background: goal.background,
            domainKind: goal.domainKind,
            learnerProfile: goal.learnerProfile ?? [],
          },
          mastered,
          phaseBoundary: phase?.boundary ?? "",
          knowledgeType: mainKnowledgeType,
          today: {
            title: day.title,
            knowledgePoints: day.knowledgePoints.map((k) => k.text),
            method: day.method,
            example: day.example,
          },
        },
        null,
        1
      );
      const full = await streamChat({
        /* tone 必须随 args 上行：设置页的「标准/温和」经三层透传进 DayPanel，
         * 服务端 route.ts 按 s("tone")==="gentle" 切换讲义语气分支——
         * 旧实现 args 只带 ctx，全仓无任何调用方传 tone，语气设置在本页静默失效。 */
        args: { ctx, tone },
        messages: [{ role: "user", content: "生成今天的学习文档。" }],
        temperature: 0.6,
        task: "lesson",
        /* 流中段连接挂起时 UI 会永久 busy，只能整页刷新恢复（服务端超时只保证服务端
         * 侧收尾，收尾字节同样到不了客户端）。graduation.ts:87 的同款客户端兜底；
         * 讲义是长生成任务（服务端头部预算 120s），总预算放宽到 180s 只兜死挂。 */
        signal: AbortSignal.timeout(180_000),
        onDelta: (d) => {
          buf += d;
          if (!flushTimer) flushTimer = setTimeout(flushNow, 80);
        },
      });
      flushNow(); // 兜底最后一个 80ms 窗口内的增量
      /* 模型 200 但正文为空（BYOK 自定义端点的现实场景）：streamChat 按约定返回 ""。
       * 旧实现跳过保存后仍把轨迹标成 done——用户等完整个生成周期只看到成功轨迹、
       * 讲义区空白且无解释，反复重试同样静默。与 AskCoach / use-chat 的空回复守卫
       * （「模型返回了空回复，请重试」）同口径。 */
      const content = full || buf;
      if (content.trim()) {
        await saveLesson(content);
        setLessonPhases([{ label: "生成讲义", state: "done", durationMs: performance.now() - lessonT0 }]);
      } else {
        setLessonPhases([{ label: "生成讲义", state: "failed", durationMs: performance.now() - lessonT0, detail: "模型返回了空回复" }]);
        toast.error("模型返回了空回复，请重试");
      }
    } catch (e) {
      flushNow(); // 中断保留的内容要完整可见（含最后一个窗口内的增量）
      if (buf.trim().length > 200) {
        await saveLesson(buf);
        setLessonPhases([
          { label: "生成讲义", state: "cancelled", durationMs: performance.now() - lessonT0, detail: "中断，已保留已生成内容" },
        ]);
        toast.error("生成中断，已保留已生成的内容（可点「重新生成」继续）。");
      } else {
        setLessonPhases([{ label: "生成讲义", state: "failed", durationMs: performance.now() - lessonT0 }]);
        toast.error(friendlyGenError(e, "生成失败"));
      }
    } finally {
      // 清掉未触发的节流定时器：否则它会在收尾之后 firing，把旧 buf 重灌进 lesson state
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      lessonGenRef.current = false;
      setLessonLoading(false);
    }
  };

  /* 提交验收 */
  const submitQuiz = async () => {
    const answered = day.acceptance.every((a) => (answers[a.id] ?? "").trim());
    if (!answered) {
      toast.error("每一条验收都要回答（哪怕写『不知道』也比空着诚实）。");
      return;
    }
    setGrading(true);
    const gradeT0 = performance.now();
    setQuizPhases([{ label: "逐条判分", state: "running", detail: "对照今日讲义核对你的依据" }]);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      /* v17：判分必须带参照物——当日讲义原文与知识点随 ctx 上行，
       * 验收官据此核对"依据对不对"，而非凭模型内建知识盲判（旧实现只发题目+答案）。 */
      const ctx = JSON.stringify({
        day: day.title,
        knowledgePoints: day.knowledgePoints.map((k) => k.text),
        lesson: (day.lesson ?? "").slice(0, 8000),
        items: day.acceptance.map((a) => ({ itemId: a.id, kind: a.kind, question: a.question })),
        answers,
      });
      const full = await streamChat({
        /* 判分语气同讲义：服务端 quiz-grade 分支按 tone 切换反馈口吻，必须随 args 上行 */
        args: { ctx, tone },
        messages: [{ role: "user", content: "开始评分。" }],
        temperature: 0.3,
        task: "quiz-grade",
        /* 流中段挂起 → grading 恒真，验收 UI（含全部输入框与返回按钮）锁死只能整页刷新。
         * 客户端总预算 90s：判分是小 JSON 非流式展示，服务端同任务预算 45s+45s。 */
        signal: AbortSignal.timeout(90_000),
        onDelta: () => {},
      });
      /* v21：证据强制——没有引用讲义原文的正向判定会被降级为 ungradable，
       * overall 也随之重算。模型自己说 pass 不算，必须有可追溯的依据。 */
      const g = normalizeQuizGrade(quizGradeSchema.parse(extractJson(full)));
      setGrade(g);
      setQuizPhases([{ label: "逐条判分", state: "done", durationMs: performance.now() - gradeT0 }]);
      setMode("result");
      store.getState().incrementAttempts(goal.id, day.id);

      /* 判分明细快照（带用户提交时的回答），pass / fail 两条分支共用 */
      const gradedItems: QuizItemResult[] = g.items.map((it) => {
        const q = day.acceptance.find((a) => a.id === it.itemId);
        return {
          itemId: it.itemId,
          question: q?.question ?? "",
          userAnswer: answers[it.itemId] ?? "",
          verdict: it.verdict,
          feedback: it.feedback,
          hintLevel: it.hintLevel,
        };
      });

      if (g.overall === "pass") {
        // 真门（v17）：passed 照常记录，但下一天要等迁移题作答才解锁
        store.getState().setDayStatus(goal.id, day.id, "passed", {
          pendingUnlock: true,
          transferQuestion: g.transferQuestion ?? "",
        });
        store.getState().logQuiz(goal.id, {
          dayId: day.id,
          date: new Date().toISOString().slice(0, 10),
          passed: true,
          forced: false,
          items: gradedItems,
        });
        // 知识点进入第二大脑 + 间隔复习队列；掌握状态按本次判分证据推进（Learn Anything）。
        // v17：把每题的验收 kind 一起交给状态机——apply/build 无提示判对 = 迁移证据，可达 transferable
        const mStatus = masteryFromQuiz(
          g.items.map((it) => ({
            verdict: it.verdict,
            hintLevel: it.hintLevel,
            kind: day.acceptance.find((a) => a.id === it.itemId)?.kind,
          }))
        );
        store.getState().addKnowledge(
          day.knowledgePoints.map((k) => ({
            title: k.text,
            domain: `${goal.topic}/笔记`,
            knowledgeType: k.knowledgeType,
            masteryStatus: mStatus,
          })),
          "learn",
          `${goal.topic} · ${day.title}`
        );
        // 把掌握状态写回计划里的知识点（historicalHighest 保留历史最高证据）。
        // 必须走 store 的定点 patch：这里如果拿渲染闭包里的 goal.plan 整体回写，
        // 会把上面刚落库的 passed/pendingUnlock/attempts 全部冲掉（下一天永不解锁）。
        store.getState().setDayKnowledgeMastery(goal.id, day.id, mStatus);
        // 判过即清草稿：本天已 passed，残留的 localStorage 草稿没有任何再读的路径
        clearQuizDraft();
        toast.success(`验收判过了！回答下方的迁移题即解锁下一天（本天成绩已保存，不怕刷新）。本批掌握状态：${MASTERY_LABELS[mStatus]}`);
      } else {
        /* 未通过也必须落库：旧实现只记 pass 与强制跳过，quizLog 里查不到任何失败——
         * ① genCtx 的 weakPoints 用 goal.quizLog.filter(q => !q.passed) 提取弱项给 AI，
         *   能落到 !passed 的只有 items 为空的强制跳过记录，弱项特征实际恒空；
         * ② 回看「验收记录」面板查 quizLog，失败次数恒 0，与头部「验收 N 次」
         *   徽章（attempts 含失败）互相矛盾。 */
        store.getState().logQuiz(goal.id, {
          dayId: day.id,
          date: new Date().toISOString().slice(0, 10),
          passed: false,
          forced: false,
          items: gradedItems,
        });
      }
    } catch (e) {
      setQuizPhases([{ label: "逐条判分", state: "failed", durationMs: performance.now() - gradeT0 }]);
      toast.error(friendlyGenError(e, "评分失败，请重试"));
    } finally {
      setGrading(false);
    }
  };

  /* 迁移题过门：作答 → 解锁下一天 → 视图切到新一天（v17 真门，答案落档当日记录） */
  const commitTransfer = (answer: string) => {
    store.getState().completeTransfer(goal.id, day.id, answer);
    setTransferDone(true);
    setGateAnswer(answer);
    toast.success("过关。迁移题回答已存入当日记录，下一天已解锁。");
    const ph = goal.plan?.phases.find((p) => p.id === day.phaseId);
    const nx = ph?.dayIds?.[(ph?.dayIds ?? []).indexOf(day.id) + 1];
    onGoToDay?.(nx ?? null);
  };
  const [gateAnswer, setGateAnswer] = useState(day.transferAnswer ?? "");

  /* 只有 Modal 里两击确认的「我确认，跳过」会调用（该按钮仅在 skipText === "跳过" 时渲染）。
   * 旧「输入框打字确认」的守卫（skipText 校验 + 「请在上面的输入框输入『跳过』」toast）
   * 已随输入框一起删除——留着会成为不可达死代码，误导后来调整确认交互的人。 */
  const forceSkip = () => {
    store.getState().setDayStatus(goal.id, day.id, "skipped");
    store.getState().logQuiz(goal.id, {
      dayId: day.id,
      date: new Date().toISOString().slice(0, 10),
      passed: false,
      forced: true,
      items: [],
    });
    setSkipConfirm(false);
    setSkipText("");
    // 跳过成功后自动走到新解锁的一天。必须取 store 最新状态：渲染闭包里的 plan 还是旧快照，
    // nextDay.status 恒为 locked，「自动走到新一天」分支会变成死代码。
    const fresh = store.getState().goals.find((g) => g.id === goal.id);
    const ph = fresh?.plan?.phases.find((p) => p.id === day.phaseId);
    const next = ph?.dayIds?.[(ph?.dayIds ?? []).indexOf(day.id) + 1];
    const nextDay = next ? fresh?.plan?.days[next] : undefined;
    if (next && nextDay && nextDay.status === "active") {
      onGoToDay?.(next);
    } else {
      onGoToDay?.(null); // 阶段完成,回阶段视图看解锁的下一阶段
    }
    toast.success("已跳过。解锁了下一天，继续。");
  };

  return (
    <div className="min-w-0 space-y-5">
      {/* 刷新/换设备后的迁移题门（v17）：判分已过、门未过——从 day 持久字段重建，不依赖会话内 grade */}
      {!readOnly && day.status === "passed" && day.pendingUnlock && !grade && (
        <Card className="border-ok/30 bg-ok/[0.03]">
          <p className="text-sm font-bold text-ink">过关前，还差一道迁移题</p>
          <p className="mt-1 text-xs text-ink-dim">本日判分已保存。作答下方迁移题，下一天才解锁。</p>
          <p className="mt-2 text-[13px] leading-relaxed text-ink">
            {day.transferQuestion || "用你自己的话，把本日核心概念讲给一个没学过的人听，并说明它在什么情况下不适用。"}
          </p>
          <Textarea
            className="mt-2 min-h-[72px] resize-y"
            placeholder="凭记忆作答（这不是评分，是帮你把知识焊牢）"
            value={gateAnswer}
            onChange={(e) => setGateAnswer(e.target.value)}
          />
          <div className="mt-2 flex justify-end">
            <Button size="sm" disabled={!gateAnswer.trim()} onClick={() => commitTransfer(gateAnswer.trim())}>
              提交，完成过关
            </Button>
          </div>
        </Card>
      )}
      {/* 今日头部 */}
      <Card className={readOnly ? "" : "border-accent/25"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              {readOnly ? (
                <Badge tone="dim">回看</Badge>
              ) : (
                <Badge tone="accent">今日任务</Badge>
              )}
              {day.status === "skipped" && <Badge tone="warn">已跳过</Badge>}
              {day.status === "passed" && <Badge tone="ok">已通过</Badge>}
              {day.attempts > 0 && <Badge tone="dim">验收 {day.attempts} 次</Badge>}
            </div>
            <h2 className="mt-2 text-lg font-bold text-ink">{day.title}</h2>
            <p className="mt-1 text-xs text-ink-dim">{day.method}</p>
          </div>
          {!readOnly && mode === "learn" && (
            <div className="flex flex-wrap items-center gap-2">
              {!done && (
                <>
                  <Button onClick={() => setMode("quiz")} variant="ok">
                    <Swords className="size-4" /> 开始验收
                  </Button>
                  <button
                    onClick={() => setSkipConfirm(true)}
                    title="学不会也可以跳过这一天（会被记录）"
                    className="cursor-pointer rounded-full border border-warn/40 bg-white px-3 py-2 text-xs font-medium text-warn transition hover:bg-warn/[0.08]"
                  >
                    跳过 →
                  </button>
                </>
              )}
              {openWindow && (
                <button
                  onClick={() =>
                    window.open(`/learn/${goal.id}?day=${day.id}&focus=1`, "_blank", "noopener,noreferrer")
                  }
                  title="在新标签页打开专注学习界面：计划页留在原处，退出学习窗口不会丢进度"
                  className="flex cursor-pointer items-center gap-1 rounded-full border border-border bg-white px-3 py-2 text-xs font-medium text-ink-dim transition hover:border-accent/50 hover:text-accent"
                >
                  <ExternalLink className="size-3.5" /> 新窗口学习
                </button>
              )}
            </div>
          )}
        </div>

        {/* 知识点 */}
        <div className="mt-4 flex flex-wrap gap-2">
          {day.knowledgePoints.map((k) => (
            <Badge key={k.id} tone="dim">
              ◆ {k.text}
            </Badge>
          ))}
        </div>

        {/* 资源 */}
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-ink-dim">当天的学习资料</p>
            <RefreshDayResources goal={goal} day={day} />
          </div>
          {(() => {
            /* 渲染侧与写入侧同口径过闸：sanitizeResUrls 只盖本页两条生成写入路径，
             * 到达这里 <a href> 的值还可能来自 agent 工具直写、旧版本数据经云端同步回流、
             * refineResources 失败时的原样返回——原生 <a> 没有 react-markdown 的
             * urlTransform 防护，非 http(s) 协议（javascript: 等）一律降级为纯文本条目。 */
            const videoOnly = requiresVideoResources([goal.direction, goal.background, ...(goal.learnerProfile ?? []), ...(goal.intakeTranscript ?? []).filter((turn) => turn.role === "user").map((turn) => turn.content)].join("\n"));
            const ranked = rankResources(day.resources).filter((r) => !videoOnly || (r.url && /(?:bilibili\.com\/video\/|youtube\.com\/watch\?|youtu\.be\/)/i.test(r.url))).map((r) =>
              r.url && !/^https?:\/\//i.test(r.url) ? { ...r, url: undefined } : r
            );
            const online = ranked.filter((r) => r.url);
            const offline = ranked.filter((r) => !r.url);
            const row = (r: (typeof day.resources)[number], i: number) => (
              <div key={i} className="flex flex-wrap items-start gap-2 rounded-lg border border-border/60 bg-surface px-2.5 py-2 text-sm">
                {r.url ? <CheckedResourceLink url={r.url} title={r.title} videoOnly={videoOnly} /> : (
                  <span className="min-w-0 break-words text-ink">{r.title}</span>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {r.verified && (
                    <span
                      className="rounded bg-ok/[0.08] px-1.5 py-0.5 text-[10px] font-medium text-ok"
                      title={r.author ? `已用平台接口实测存在 · ${r.author}` : "已用平台接口实测存在"}
                    >
                      视频已验证
                    </span>
                  )}
                  {(r.kind || r.year || r.evergreen) && (
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-dim">
                      {r.evergreen ? "经典补充" : (KIND_LABEL[r.kind ?? ""] ?? r.kind)}
                      {r.year ? ` · ${r.year}` : ""}
                    </span>
                  )}
                </span>
                <span className="basis-full text-xs leading-relaxed text-ink-dim">{r.why}</span>
              </div>
            );
            return (
              <>
                {online.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="flex items-center gap-1 text-[11px] font-medium text-ink-dim">
                      <Globe className="size-3.5" /> 在线资源
                    </p>
                    {online.map(row)}
                  </div>
                )}
                {offline.length > 0 && (
                  <div className="mt-2.5 space-y-1.5">
                    <p className="flex items-center gap-1 text-[11px] font-medium text-ink-dim">
                      <BookOpen className="size-3.5" /> 书籍 / 线下补充
                    </p>
                    {offline.map(row)}
                  </div>
                )}
                {!ranked.length && <p className="text-xs text-ink-dim">{videoOnly ? "暂未找到符合要求的视频，可点击搜索当天资料重试。" : "本日暂无资源，以讲义正文「① 直接可学的资料」为准。"}</p>}
              </>
            );
          })()}
        </div>
      </Card>

      {/* ===== 学习模式 ===== */}
      {mode === "learn" && (
        <>
          <Card>
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-2 text-sm font-bold text-ink">
                <BookMarked className="size-4 text-accent" /> 学习文档
              </p>
              {!lessonText && (
                <Button size="sm" onClick={genLesson} loading={lessonLoading}>
                  生成今日讲解
                </Button>
              )}
            </div>
            {lessonText ? (
              <div className="mt-3">
                <Markdown text={lessonText} className="prose-reading" />
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  /* 流式生成期间必须禁用（与上方「生成今日讲解」的 loading 门控同口径）：
                   * 生成开始约 80ms 后 lessonText 非空、生成按钮被卸载，整个生成期间
                   * 页面上唯一可点的就是这颗按钮——不放门控等于邀请用户点出并发生成。 */
                  loading={lessonLoading}
                  onClick={() => {
                    setLesson("");
                    const cur = store.getState().goals.find((g) => g.id === goal.id)?.plan ?? goal.plan;
                    if (cur) {
                      store.getState().updateGoal(goal.id, {
                        plan: (() => {
                          const plan = structuredClone(cur);
                          if (plan.days[day.id]) delete plan.days[day.id].lesson;
                          return plan;
                        })(),
                      });
                    }
                    void import("@/lib/auth-client").then(({ useAuthStore, pushCloud }) => {
                      if (useAuthStore.getState().user) void pushCloud();
                    });
                    /* 清空后立即重新生成：旧实现只删不生成——生成中断的 toast 承诺
                     * 「可点『重新生成』继续」，用户照点却把刻意保留的中断产物删掉，
                     * 还得再点一次「生成今日讲解」从头来（两步且自相矛盾）。 */
                    void genLesson();
                  }}
                >
                  重新生成
                </Button>
              </div>
            ) : (
              <p className="mt-3 text-xs text-ink-dim">
                将按「{DOMAIN_LABELS[goal.domainKind]}」的教法生成：知识点讲解{" "}
                {goal.domainKind === "coding" ? "+ 完整项目例子拆解" : ""} + 常见的坑 + 验收前练习。
              </p>
            )}
            {lessonLoading && lessonText && <span className="stream-cursor mt-2" />}
            <AgentTrace phases={lessonPhases} className="mt-3" />
          </Card>

          {/* 项目例子 */}
          {day.example && (
            <Card>
              <p className="flex items-center gap-1.5 text-sm font-bold text-ink">
                <Puzzle className="size-4 text-accent" />
                {day.example.title}
              </p>
              <p className="mt-1 text-xs text-ink-dim">{day.example.description}</p>
              {day.example.code && (
                /* 深底代码块配方统一走 globals.css 的 .code-block-dark（与讲义 Markdown 的
                   .prose-mentora pre 是同一份规则）——别把 #18181b/#26262b/#d4d4d8 抄进 JSX，
                   否则代码块配色一调，同屏两种代码块必然漂移 */
                <pre className="code-block-dark mt-3 text-xs">
                  <code>{day.example.code}</code>
                </pre>
              )}
            </Card>
          )}

          {/* 随手记：学习过程中直接记进第二大脑 */}
          <QuickNotes goal={goal} day={day} />

          {/* 即时答疑：学习中随时问教练 */}
          <AskCoach goal={goal} day={day} />
        </>
      )}

      {/* ===== 验收模式 ===== */}
      {mode === "quiz" && !readOnly && (
        <Card className="border-warn/30">
          <p className="flex items-center gap-1.5 text-sm font-bold text-ink">
            <Swords className="size-4 text-warn" />
            验收关卡 —— 逐条通过才能解锁下一阶段
          </p>
          <p className="mt-1 text-xs text-ink-dim">
            讲解测试用自己的话讲；变体测试是新条件下的应用题。答不上来可以回头再学，验收不计时。
          </p>
          <div className="mt-4 space-y-4">
            {day.acceptance.map((a, i) => (
              <div key={a.id}>
                <p className="text-sm text-ink">
                  <Badge tone="warn" className="mr-2">
                    第{i + 1}题 · {ACCEPTANCE_KIND_LABEL[a.kind] ?? a.kind}
                  </Badge>
                  {a.question}
                </p>
                {a.hint && <p className="mt-1 text-xs text-ink-dim/70">考察点：{a.hint}</p>}
                <Textarea
                  className="mt-2"
                  rows={3}
                  placeholder="写下你的回答…"
                  value={answers[a.id] ?? ""}
                  onChange={(e) => setAnswers({ ...answers, [a.id]: e.target.value })}
                  /* 判分往返期间锁定编辑：送判的是提交时刻的 answers 快照，结果页展示的
                   * 也是当前 answers——放行编辑会出现「答非所判」（反馈针对旧答案，
                   * 展示的却是新答案）。 */
                  disabled={grading}
                />
              </div>
            ))}
          </div>
          <AgentTrace phases={quizPhases} className="mt-4" />
          <div className="mt-5 flex items-center justify-between">
            <Button variant="ghost" size="sm" onClick={() => setMode("learn")} disabled={grading}>
              返回学习
            </Button>
            <Button variant="ok" onClick={submitQuiz} loading={grading}>
              提交验收
            </Button>
          </div>
        </Card>
      )}

      {/* ===== 结果模式 ===== */}
      {mode === "result" && grade && (
        <Card
          className={cn(
            "animate-rise relative overflow-hidden",
            grade.overall === "pass" ? "border-ok/30 pass-glow" : "border-bad/30"
          )}
        >
          {grade.overall === "pass" && (
            /* 即时正反馈：一次性"印章"式盖章,1.2s 后静止,不彩带不喧哗 */
            <span aria-hidden className="pass-stamp select-none">
              过
            </span>
          )}
          <div className="flex items-center gap-2">
            {grade.overall === "pass" ? (
              <Badge tone="ok">验收通过</Badge>
            ) : (
              <Badge tone="bad">未通过</Badge>
            )}
            <p className="text-sm font-bold text-ink">{grade.summary}</p>
          </div>
          <div className="mt-4 space-y-3">
            {day.acceptance.map((a, i) => {
              const r = grade.items.find((it) => it.itemId === a.id);
              if (!r) return null;
              return (
                <div key={a.id} className="rounded-xl border border-border bg-surface-2/70 p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm text-ink">
                      <span className="mr-2 text-ink-dim">第{i + 1}题</span>
                      {a.question}
                    </p>
                    {r.verdict === "correct" ? (
                      <Check className="mt-0.5 size-4 shrink-0 text-ok" />
                    ) : r.verdict === "partially_correct" ? (
                      <span className="mt-0.5 size-4 shrink-0 text-warn font-bold text-xs">~</span>
                    ) : (
                      <CircleX className="mt-0.5 size-4 shrink-0 text-bad" />
                    )}
                  </div>
                  {answers[a.id] && (
                    <p className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-white p-2.5 text-xs text-ink-dim">
                      你的回答：{answers[a.id]}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-ink-dim">
                    <span className={
                      r.verdict === "correct" ? "text-ok" :
                      r.verdict === "partially_correct" ? "text-warn" : "text-bad"
                    }>
                      {r.verdict === "correct" ? "✓ " : r.verdict === "partially_correct" ? "~ " : "✗ "}
                    </span>
                    {r.feedback}
                  </p>
                  {r.evidence && (
                    <p className="mt-1.5 border-l-2 border-border pl-2.5 text-[11px] leading-relaxed text-ink-3">
                      依据（讲义原文）：{r.evidence}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-4 rounded-xl border border-accent/20 bg-accent/[0.05] p-3.5 text-sm text-accent">
            {grade.reviewAdvice}
          </div>
          {grade.overall === "pass" && (
            /* 即时复习门（Learn Anything 硬规则）：先合上材料主动回忆，再做一道迁移题，完成后才算真正过门 */
            <div className="mt-4 rounded-xl border border-ok/25 bg-ok/[0.04] p-3.5">
              <p className="text-sm font-bold text-ink">过关前，最后一步：合上材料，回答这道迁移题</p>
              {transferAnswer === null && (
                <>
                  <p className="mt-1.5 text-xs text-ink-dim">
                    先花 10 秒回忆本日核心内容，再作答。回忆不出来的部分，正是该回炉的地方。
                  </p>
                  <Button size="sm" className="mt-2.5" onClick={() => setTransferAnswer("")}>
                    我准备好了，看题
                  </Button>
                </>
              )}
              {transferAnswer !== null && (
                <>
                  <p className="mt-2 text-[13px] leading-relaxed text-ink">
                    {grade.transferQuestion || "用你自己的话，把本日核心概念讲给一个没学过的人听，并说明它在什么情况下不适用。"}
                  </p>
                  <Textarea
                    className="mt-2 min-h-[72px] resize-y"
                    placeholder="凭记忆作答（这不是评分，是帮你把知识焊牢）"
                    value={transferAnswer}
                    onChange={(e) => setTransferAnswer(e.target.value)}
                  />
                  <div className="mt-2 flex justify-end">
                    <Button
                      size="sm"
                      disabled={!transferAnswer.trim()}
                      onClick={() => commitTransfer(transferAnswer.trim())}
                    >
                      提交，完成过关
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
          {grade.overall === "pass" ? (
            transferDone ? (
              <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-sm text-ok">
                <Check className="size-4" /> 已过关并解锁下一任务，左侧时间线可查看。
              </p>
            ) : (
              <p className="mt-4 text-center text-sm text-ink-dim">
                还差一道迁移题：作答后下一天才解锁（判分已保存，随时回来答）。
              </p>
            )
          ) : (
            <div className="mt-4 flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setGrade(null);
                  setMode("learn");
                }}
              >
                回去补课，稍后再验收
              </Button>
              <Button variant="outline" size="sm" onClick={() => setMode("quiz")}>
                重新验收
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* 回看：历史验收记录 */}
      {readOnly && day.status === "passed" && goal.quizLog.filter((q) => q.dayId === day.id).length > 0 && (
        <Card>
          <p className="mb-3 text-sm font-bold text-ink">验收记录</p>
          <div className="space-y-3">
            {goal.quizLog
              .filter((q) => q.dayId === day.id)
              .map((q, i) => (
                <div key={i} className="rounded-xl border border-border bg-surface-2/70 p-3 text-xs text-ink-dim">
                  <div className="flex items-center gap-2">
                    {q.passed ? <Badge tone="ok">通过</Badge> : <Badge tone="bad">未通过</Badge>}
                    {q.forced && <Badge tone="warn">强制跳过</Badge>}
                    <span>{q.date}</span>
                  </div>
                  {q.items.slice(0, 3).map((it, j) => (
                    <p key={j} className="mt-2 truncate">· {it.question} → {it.feedback}</p>
                  ))}
                </div>
              ))}
          </div>
        </Card>
      )}

      {/* 跳过确认：改用设计系统的 Modal——手搓 overlay 没有 role=dialog/焦点陷阱/Esc/滚动锁，
          键盘用户能 Tab 到背景控件，读屏也读不出这是个对话框 */}
      <Modal
        open={skipConfirm}
        onClose={() => {
          setSkipConfirm(false);
          setSkipText("");
        }}
        title="跳过这一天？"
      >
        <p className="text-sm text-ink-dim">
          本日知识点<b className="text-ink">不会</b>存入第二大脑，也不会进入复习队列。
          跳过会被记录 —— 这是你的选择，系统尊重它。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => { setSkipConfirm(false); setSkipText(""); }}>
            我再学学
          </Button>
          {/* 两击确认：第一击变为红色警示,第二击执行——替代旧的打字确认(要拉很远找不到输入框) */}
          {skipText !== "跳过" ? (
            <Button
              variant="outline"
              onClick={() => setSkipText("跳过")}
              className="border-warn/50 text-warn"
            >
              确认跳过（再点一次）
            </Button>
          ) : (
            <Button variant="danger" onClick={forceSkip}>
              我确认，跳过
            </Button>
          )}
        </div>
      </Modal>
    </div>
  );
}
