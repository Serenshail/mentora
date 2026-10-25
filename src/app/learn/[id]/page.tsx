"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { MASTERY_LABELS, MASTERY_ORDER } from "@/lib/types";
import {
  Badge, Button, Card, Input, Modal, PageHeader, ProgressRing, StatusDot, Textarea,
} from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { useAppStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { DOMAIN_LABELS } from "@/lib/types";
import type { DayPlan, Goal, QuizItemResult } from "@/lib/types";
import { extractJson, normalizeQuizGrade, quizGradeSchema, type QuizGrade } from "@/lib/ai/client";
import { cn, formatDate, uid, rankResources, KIND_LABEL } from "@/lib/utils";
import { refineResources } from "@/lib/resource-pipeline";
import { masteryFromQuiz } from "@/lib/store";
import { runGraduation } from "@/lib/graduation";

/* 链接体检徽章:复用资源管线的模块级缓存(refine 已体检过的不再重复请求) */
import type { LinkCheck } from "@/lib/resource-pipeline";
import { ensureCheck } from "@/lib/resource-pipeline";
function LinkStatus({ url }: { url?: string }) {
  const [st, setSt] = useState<LinkCheck | null>(null);
  useEffect(() => {
    if (!url) return;
    let on = true;
    void ensureCheck(url).then((r) => on && setSt(r));
    return () => {
      on = false;
    };
  }, [url]);
  if (!st) return null;
  if (st.dead) return <span className="shrink-0 text-[10px] text-bad" title={st.reason}>✗ 失效</span>;
  if (st.ad) return <span className="shrink-0 text-[10px] text-warn" title={st.reason}>⚠ 疑似广告</span>;
  return <span className="shrink-0 text-[10px] text-ok" title="链接可访问">✓</span>;
}
import { toast } from "sonner";
import {
  ArrowLeft, BookMarked, BookOpen, Check, ChevronRight, CircleX, ExternalLink, Flag, Globe,
  NotebookPen, Puzzle, Swords, Trophy,
} from "lucide-react";

/* ================= 即时答疑：学习中随时问教练 ================= */
function AskCoach({ goal, day }: { goal: Goal; day: DayPlan }) {
  const updateGoal = useAppStore((s) => s.updateGoal);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const qa = day.qa ?? [];
  const boxRef = useRef<HTMLDivElement>(null);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setStreamText("");
    const userMsg = { id: uid("m"), role: "user" as const, content: text, at: new Date().toISOString() };
    const newQa = [...qa, userMsg];
    updateGoal(goal.id, {
      plan: (() => {
        const plan = structuredClone(goal.plan!);
        plan.days[day.id].qa = newQa;
        return plan;
      })(),
    });
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const ctx = JSON.stringify({
        topic: goal.topic,
        today: day.title,
        knowledgePoints: day.knowledgePoints.map((k) => k.text),
        learnerProfile: goal.learnerProfile ?? [],
      });
      const full = await streamChat({
        task: "coach-qa",
        args: { ctx },
        messages: newQa.slice(-6).map((m) => ({ role: m.role, content: m.content })),
        onDelta: (d) => setStreamText((p) => p + d),
      });
      const finalQa = [...newQa, { id: uid("m"), role: "assistant" as const, content: full || streamText, at: new Date().toISOString() }];
      updateGoal(goal.id, {
        plan: (() => {
          const plan = structuredClone(goal.plan!);
          plan.days[day.id].qa = finalQa;
          return plan;
        })(),
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "答疑失败");
    } finally {
      setStreamText("");
      setBusy(false);
    }
  };

  return (
    <Card>
      <button className="flex w-full items-center justify-between cursor-pointer" onClick={() => setOpen(!open)}>
        <p className="text-sm font-bold text-ink">看不懂？问教练</p>
        <span className="text-xs text-ink-dim">{open ? "收起 ▲" : "展开 ▼"}</span>
      </button>
      {open && (
        <div className="mt-3">
          <div ref={boxRef} aria-live="polite" aria-label="教练答疑" className="max-h-64 space-y-2.5 overflow-y-auto">
            {qa.length === 0 && !streamText && (
              <p className="text-xs text-ink-dim/70">
                看不懂某个知识点？代码报错不知道为什么？直接问，教练即时解答。
              </p>
            )}
            {qa.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                {m.role === "user" ? (
                  <div className="max-w-[85%] rounded-xl rounded-br-sm bg-[#1d1d1f] px-3 py-2 text-xs text-white">
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
          </div>
          <div className="mt-3 flex gap-2">
            <input
              className="h-9 w-full rounded-[10px] border border-border bg-white px-3 text-sm outline-none transition focus:border-accent/50 focus:ring-[3px] focus:ring-accent/[0.12]"
              placeholder="输入你的疑问…（Enter 发送）"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              disabled={busy}
            />
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
    (k) => k.domain === goal.topic && k.sourceTitle.includes(day.title)
  );
  return (
    <Card>
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-ink">随手记</p>
        <span className="text-[11px] text-ink-dim">想到就记，直接进知识库</span>
      </div>
      <div className="mt-3">
        <input
          className="h-9 w-full rounded-[10px] border border-border bg-white px-3 text-sm outline-none transition focus:border-accent/50 focus:ring-[3px] focus:ring-accent/[0.12]"
          placeholder="记一条：今天踩的坑 / 顿悟 / 想追问的问题…（Enter 保存）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !text.trim()) return;
            addKnowledge(
              [{ title: text.trim().slice(0, 40), body: text.trim(), domain: `${goal.topic}/笔记` }],
              "manual",
              `${goal.topic} · ${day.title} · 随手记`
            );
            setText("");
            toast.success("已记入第二大脑");
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
export default function GoalDetailPage() {
  const hydrated = useHydrated();
  const { id } = useParams<{ id: string }>();
  const goal = useAppStore((s) => s.goals.find((g) => g.id === id));
  const settings = useAppStore((s) => s.settings);
  const router = useRouter();
  const [viewDayId, setViewDayId] = useState<string | null>(null);
  /* 日程投影（视图层，不进目标卡 schema）：用户给一个目标日期,反推每天节奏。
   * ⚠️ Hook 必须在一切条件 return 之前（踩坑 #9：hydrated/goal 翻转时钩子数量变化→React #310） */
  const [deadline, setDeadline] = useState<string>(() => {
    try { return localStorage.getItem(`mentora-deadline-${id}`) ?? ""; } catch { return ""; }
  });
  const setDeadlineDate = (v: string) => {
    setDeadline(v);
    try { localStorage.setItem(`mentora-deadline-${id}`, v); } catch { /* 忽略 */ }
  };

  const progress = useMemo(() => {
    if (!goal?.plan) return { ratio: 0, done: 0, total: 0 };
    const days = Object.values(goal.plan.days);
    const done = days.filter((d) => d.status === "passed" || d.status === "skipped").length;
    return { ratio: days.length ? done / days.length : 0, done, total: days.length };
  }, [goal]);

  if (!hydrated) return <div className="h-40 animate-pulse rounded-2xl bg-surface/60" />;
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

  const activeDay =
    Object.values(goal.plan?.days ?? {}).find((d) => d.status === "active") ??
    /* 迁移门（v17）：判过但未过门的当天顶替"当前任务"——否则无 active 日、视图空转，门卡无处显 */
    Object.values(goal.plan?.days ?? {}).find((d) => d.status === "passed" && d.pendingUnlock) ??
    null;
  const activePhase = goal.plan?.phases.find((p) => p.status === "active") ?? null;
  const viewDay = (viewDayId ? goal.plan?.days[viewDayId] : null) ?? activeDay;
  const remainingDays = goal.plan
    ? Object.values(goal.plan.days).filter((d) => d.status === "active" || d.status === "locked").length
    : 0;
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
      <button
        onClick={() => router.push("/learn")}
        className="mb-4 flex items-center gap-1.5 text-sm text-ink-dim hover:text-ink cursor-pointer"
      >
        <ArrowLeft className="size-4" /> 学习教练
      </button>

      <PageHeader
        title={goal.topic}
        desc={goal.direction}
        right={
          <div className="hidden sm:block">
            <ProgressRing value={progress.ratio} size={64} label={`${Math.round(progress.ratio * 100)}%`} />
          </div>
        }
      />

      {/* 日程投影（可选,视图层）：给有硬 deadline 的用户一个节奏反推,不改变 Day N 计划本身 */}
      <Card className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-bold text-ink">日程投影</p>
          <span className="text-[11px] text-ink-dim/70">可选：有硬截止日期才填,计划本身不承诺日期</span>
          <input
            type="date"
            value={deadline}
            onChange={(e) => setDeadlineDate(e.target.value)}
            className="ml-auto rounded-lg border border-border bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent/50"
          />
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
      </Card>

      <div className="mb-6 flex flex-wrap gap-2">
        <Badge tone="accent">{DOMAIN_LABELS[goal.domainKind]}</Badge>
        <Badge tone="dim">每周 {goal.weeklyHours} 小时</Badge>
        {goal.deadline && <Badge tone="warn">截止 {formatDate(goal.deadline)}</Badge>}
        <Badge tone="dim">
          {progress.done}/{progress.total} 天完成
        </Badge>
        {goal.plan && <Badge tone="dim">启动 {formatDate(goal.plan.startDate)}</Badge>}
      </div>

      {goal.plan && viewDay && (
        <div className="grid gap-6 lg:grid-cols-[300px_1fr] lg:items-start">
          <div className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            <PlanTimeline
              goal={goal}
              activeDayId={activeDay?.id ?? null}
              selectedDayId={viewDayId}
              onSelect={setViewDayId}
            />
          </div>
          <DayPanel key={viewDay.id} goal={goal} day={viewDay} readOnly={viewDay.id !== activeDay?.id} onGoToDay={setViewDayId} tone={settings.coachTone} />
        </div>
      )}
      {goal.plan && !viewDay && activePhase && !activePhase.planned && activePhase.dayIds.length === 0 && (
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
function PhasePlanPanel({ goal, phase }: { goal: Goal; phase: NonNullable<Goal["plan"]>["phases"][number] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const { streamChat, phasePlanSchema } = await import("@/lib/ai/client");
      const { phaseDraftToDays } = await import("@/lib/plan");
      const plan = goal.plan!;
      // 已掌握：所有已通过/跳过天的知识点
      const mastered = Object.values(plan.days)
        .filter((d) => d.status === "passed" || d.status === "skipped")
        .flatMap((d) => d.knowledgePoints.map((k) => k.text));
      // 薄弱点：最近未通过的验收
      const weakPoints = goal.quizLog
        .filter((q) => !q.passed)
        .slice(0, 5)
        .flatMap((q) => {
          const day = plan.days[q.dayId];
          return day ? [`${day.title}（${q.items.filter((i) => i.verdict === "incorrect").length} 题未过）`] : [];
        });
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
          },
          mastered,
          weakPoints,
        },
        null,
        1
      );
      const full = await streamChat({
        task: "plan",
        args: { mode: "phase", ctx },
        messages: [{ role: "user", content: "生成本阶段的天级计划（只要 JSON）。" }],
        onDelta: () => {},
      });
      const draft = phasePlanSchema.parse(extractJson(full));
      const rawDays = phaseDraftToDays(draft, phase.id);
      // 资源体检闭环:失效/广告的链接重新找替代,仍坏则丢弃——绝不把坏链推给用户
      const refinedEntries = await Promise.all(
        Object.entries(rawDays).map(async ([id, d]) => {
          const resources = await refineResources(d.resources, `${goal.topic}：${phase.title} — ${d.title}`);
          return [id, { ...d, resources }] as const;
        })
      );
      const days = Object.fromEntries(refinedEntries) as typeof rawDays;
      useAppStore.getState().setPhasePlan(goal.id, phase.id, draft.boundary ?? "", days);
      // 阶段计划入第二大脑关系链
      const masterNote = `${goal.topic} 学习计划 · 学习总纲要`;
      // d.title 本身已含 "Day N：",不再重复前缀;用项目符号列表,Markdown 才换行成结构化清单
      const daysOverview = Object.values(days)
        .map((d) => `- **${d.title.replace(/^Day\s*\d+[：:]\s*/, "")}** — ${d.knowledgePoints.map((k) => k.text).join("、")}`)
        .join("\n");
      useAppStore.getState().addKnowledge(
        [{
          title: `${goal.topic} 学习计划 · ${phase.title}`,
          body: `**阶段目标：**${phase.outcome}\n\n**边界：**${draft.boundary ?? phase.boundary ?? "—"}\n\n## 每日安排\n\n${daysOverview}\n\n关联：[[${masterNote}]]`,
          domain: `${goal.topic}/计划`,
        }],
        "learn",
        `${goal.topic} · 阶段计划`
      );
      toast.success("本阶段的天级计划已生成，从 Day 1 开始！");
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "生成失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-accent/25">
      <Badge tone="accent">下一程</Badge>
      <h2 className="mt-3 text-xl font-bold text-ink">{phase.title}</h2>
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
        天级计划现在才生成——因为它会结合你在前面阶段的真实表现（已掌握什么、哪里薄弱）和学习画像，
        比一开始就排死整个计划精准得多。
      </p>

      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <Button className="mt-5 w-full" onClick={generate} loading={busy}>
        生成「{phase.title}」的天级计划
      </Button>
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
        onDelta: () => {},
      });
      const draft = masterPlanSchema.parse(extractJson(full));
      useAppStore.getState().setPlan(goal.id, masterDraftToPlan(draft, { ...card, deadline: null }));
      toast.success("计划已生成，开始第一天！");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "生成失败，请重试（模型偶发超时）");
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
  activeDayId,
  selectedDayId,
  onSelect,
}: {
  goal: Goal;
  activeDayId: string | null;
  selectedDayId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const plan = goal.plan!;
  const viewDayId = selectedDayId ?? activeDayId;

  return (
    <Card>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-dim">
        路径设计
      </p>
      <p className="mb-4 text-sm text-ink-dim">{plan.summary}</p>

      <div className="space-y-4">
        {plan.phases.map((phase, pi) => (
          <div key={phase.id}>
            <div className="flex items-center gap-2">
              <StatusDot status={phase.status} />
              <p className="text-sm font-bold text-ink">
                阶段{pi + 1} · {phase.title}
              </p>
              {phase.status === "passed" && <Badge tone="ok">已通过</Badge>}
              {phase.status === "locked" && <Badge tone="dim">未解锁</Badge>}
            </div>
            <p className="mb-2 mt-1 flex items-center gap-1.5 pl-4 text-xs text-ink-dim">
              <Flag className="size-3 shrink-0" />
              {phase.outcome}
            </p>
            {phase.planned === false && phase.dayIds.length === 0 && phase.outline && (
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
              {phase.dayIds.map((dayId) => {
                const day = plan.days[dayId];
                const locked = day.status === "locked";
                return (
                  <button
                    key={dayId}
                    disabled={locked}
                    onClick={() => onSelect(dayId)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition",
                      locked
                        ? "cursor-not-allowed text-ink-dim/40"
                        : "cursor-pointer hover:bg-black/[0.04]",
                      viewDayId === dayId && "bg-accent/[0.09] font-medium text-accent",
                      day.status === "passed" && "text-ink-dim",
                      day.status === "skipped" && "text-warn/80"
                    )}
                  >
                    <StatusDot status={day.status} />
                    <span className="truncate">{day.title}</span>
                    {day.status === "passed" && <Check className="ml-auto size-3.5 text-ok" />}
                    {day.status === "skipped" && <ChevronRight className="ml-auto size-3.5 text-warn" />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
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

/* ================= 每日任务面板（含验收门） ================= */
type PanelMode = "learn" | "quiz" | "result";

function DayPanel({
  goal,
  day,
  readOnly = false,
  onGoToDay,
  tone = "standard" as "standard" | "gentle",
}: {
  goal: Goal;
  day: DayPlan;
  readOnly?: boolean;
  /** 严厉度：判分与讲义语气（判分标准不变） */
  tone?: "standard" | "gentle";
  /** 跳过成功后让父组件把视图切到新解锁的一天(传 null=回阶段视图) */
  onGoToDay?: (dayId: string | null) => void;
}) {
  const store = useAppStore;
  const [mode, setMode] = useState<PanelMode>("learn");
  const [lesson, setLesson] = useState(day.lesson ?? "");
  const [lessonLoading, setLessonLoading] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [grade, setGrade] = useState<QuizGrade | null>(null);
  const [grading, setGrading] = useState(false);
  const [skipConfirm, setSkipConfirm] = useState(false);
  const [skipText, setSkipText] = useState("");
  const [transferAnswer, setTransferAnswer] = useState<string | null>(null);
  const [transferDone, setTransferDone] = useState(false);

  const done = day.status === "passed" || day.status === "skipped";

  /* 生成今日学习文档 */
  const genLesson = async () => {
    setLessonLoading(true);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const mastered = Object.values(goal.plan?.days ?? {})
        .filter((d) => (d.status === "passed" || d.status === "skipped") && d.id !== day.id)
        .flatMap((d) => d.knowledgePoints.map((k) => k.text));
      const phase = goal.plan?.phases.find((ph) => ph.id === day.phaseId);
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
        args: { ctx },
        messages: [{ role: "user", content: "生成今天的学习文档。" }],
        temperature: 0.6,
        task: "lesson",
        onDelta: (d) => setLesson((p) => p + d),
      });
      if (full) {
        // 缓存进 store
        store.getState().updateGoal(goal.id, {
          plan: (() => {
            const plan = structuredClone(goal.plan!);
            plan.days[day.id].lesson = full;
            return plan;
          })(),
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "生成失败");
    } finally {
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
        args: { ctx },
        messages: [{ role: "user", content: "开始评分。" }],
        temperature: 0.3,
        task: "quiz-grade",
        onDelta: () => {},
      });
      /* v21：证据强制——没有引用讲义原文的正向判定会被降级为 ungradable，
       * overall 也随之重算。模型自己说 pass 不算，必须有可追溯的依据。 */
      const g = normalizeQuizGrade(quizGradeSchema.parse(extractJson(full)));
      setGrade(g);
      setMode("result");
      store.getState().incrementAttempts(goal.id, day.id);

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
          items: g.items.map((it): QuizItemResult => {
            const q = day.acceptance.find((a) => a.id === it.itemId);
            return {
              itemId: it.itemId,
              question: q?.question ?? "",
              userAnswer: answers[it.itemId] ?? "",
              verdict: it.verdict,
              feedback: it.feedback,
              hintLevel: it.hintLevel,
            };
          }),
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
        // 把掌握状态写回计划里的知识点（historicalHighest 保留历史最高证据）
        store.getState().updateGoal(goal.id, {
          plan: (() => {
            const plan = structuredClone(goal.plan!);
            for (const k of plan.days[day.id]?.knowledgePoints ?? []) {
              k.masteryStatus = mStatus;
              if (
                !k.historicalHighest ||
                MASTERY_ORDER.indexOf(mStatus) > MASTERY_ORDER.indexOf(k.historicalHighest)
              ) {
                k.historicalHighest = mStatus;
              }
            }
            return plan;
          })(),
        });
        toast.success(`验收判过了！回答下方的迁移题即解锁下一天（本天成绩已保存，不怕刷新）。本批掌握状态：${MASTERY_LABELS[mStatus]}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "评分失败，请重试");
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

  const forceSkip = () => {
    if (skipText !== "跳过") {
      setSkipText("");
      toast.error("请在上面的输入框输入「跳过」确认");
      return;
    }
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
    // 跳过成功后自动走到新解锁的一天,让用户明确"下一步在哪"(否则视图停在旧日,像没生效)
    const next = goal.plan?.phases
      .find((p) => p.id === day.phaseId)?.dayIds?.[(goal.plan?.phases.find((p) => p.id === day.phaseId)?.dayIds ?? []).indexOf(day.id) + 1];
    const nextDay = next ? goal.plan?.days[next] : undefined;
    if (nextDay && nextDay.status === "active" && next) {
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
          <textarea
            className="mt-2 min-h-[72px] w-full resize-y rounded-lg border border-border bg-white p-2.5 text-[13px] text-ink outline-none focus:border-accent/50"
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
          {!done && !readOnly && mode === "learn" && (
            <div className="flex items-center gap-2">
              <Button onClick={() => setMode("quiz")} variant="ok">
                <Swords className="size-4" /> 开始验收
              </Button>
              <button
                onClick={() => setSkipConfirm(true)}
                title="学不会也可以跳过这个阶段（会被记录）"
                className="cursor-pointer rounded-full border border-warn/40 bg-white px-3 py-2 text-xs font-medium text-warn transition hover:bg-warn/[0.08]"
              >
                跳过 →
              </button>
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
          <p className="text-xs font-semibold text-ink-dim">学习资源（选一个顺手的）</p>
          {(() => {
            const ranked = rankResources(day.resources);
            const online = ranked.filter((r) => r.url);
            const offline = ranked.filter((r) => !r.url);
            const row = (r: (typeof day.resources)[number], i: number) => (
              <div key={i} className="flex items-start gap-2 rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-sm">
                {r.url ? (
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-w-0 items-center gap-1 text-accent hover:underline"
                  >
                    <span className="truncate">{r.title}</span> <ExternalLink className="size-3.5 shrink-0" />
                  </a>
                ) : (
                  <span className="min-w-0 truncate text-ink">{r.title}</span>
                )}
                <LinkStatus url={r.url} />
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
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
                      <Globe className="size-3.5" /> 在线资源（可直接点开）
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
                {!ranked.length && <p className="text-xs text-ink-dim">本日暂无资源，以讲义正文「① 直接可学的资料」为准。</p>}
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
              {!lesson && (
                <Button size="sm" onClick={genLesson} loading={lessonLoading}>
                  生成今日讲解
                </Button>
              )}
            </div>
            {lesson ? (
              <div className="mt-3">
                <Markdown text={lesson} />
                {done && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-2"
                    onClick={() => {
                      setLesson("");
                      store.getState().updateGoal(goal.id, {
                        plan: (() => {
                          const plan = structuredClone(goal.plan!);
                          delete plan.days[day.id].lesson;
                          return plan;
                        })(),
                      });
                    }}
                  >
                    重新生成
                  </Button>
                )}
              </div>
            ) : (
              <p className="mt-3 text-xs text-ink-dim">
                将按「{DOMAIN_LABELS[goal.domainKind]}」的教法生成：知识点讲解{" "}
                {goal.domainKind === "coding" ? "+ 完整项目例子拆解" : ""} + 常见的坑 + 验收前练习。
              </p>
            )}
            {lessonLoading && lesson && <span className="stream-cursor mt-2" />}
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
                <pre className="mt-3 overflow-x-auto rounded-xl border border-[#26262b] bg-[#18181b] p-4 text-xs leading-relaxed text-[#d4d4d8]">
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
                    第{i + 1}题 · {a.kind}
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
                />
              </div>
            ))}
          </div>
          <div className="mt-5 flex items-center justify-between">
            <Button variant="ghost" size="sm" onClick={() => setMode("learn")}>
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
                  <textarea
                    className="mt-2 min-h-[72px] w-full resize-y rounded-lg border border-border bg-white p-2.5 text-[13px] text-ink outline-none focus:border-accent/50"
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

      {skipConfirm && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => setSkipConfirm(false)}
        >
          <Card
            className="animate-rise max-w-sm w-full"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <p className="text-lg font-bold text-ink">跳过这一阶段？</p>
            <p className="mt-2 text-sm text-ink-dim">
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
          </Card>
        </div>
      )}
    </div>
  );
}
