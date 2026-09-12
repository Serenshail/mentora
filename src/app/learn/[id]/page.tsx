"use client";

import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Badge, Button, Card, Input, Modal, PageHeader, ProgressRing, StatusDot, Textarea,
} from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { useAppStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { DOMAIN_LABELS } from "@/lib/types";
import type { DayPlan, Goal, QuizItemResult } from "@/lib/types";
import { DAILY_LESSON, QUIZ_GRADE } from "@/lib/ai/prompts";
import { extractJson, quizGradeSchema, type QuizGrade } from "@/lib/ai/client";
import { cn, formatDate } from "@/lib/utils";
import { toast } from "sonner";
import {
  ArrowLeft, BookMarked, Check, ChevronRight, CircleX, ExternalLink, Sparkles, Swords,
} from "lucide-react";

/* ================= 页面 ================= */
export default function GoalDetailPage() {
  const hydrated = useHydrated();
  const { id } = useParams<{ id: string }>();
  const goal = useAppStore((s) => s.goals.find((g) => g.id === id));
  const router = useRouter();
  const [viewDayId, setViewDayId] = useState<string | null>(null);

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
    Object.values(goal.plan?.days ?? {}).find((d) => d.status === "active") ?? null;
  const viewDay = (viewDayId ? goal.plan?.days[viewDayId] : null) ?? activeDay;

  return (
    <div>
      <button
        onClick={() => router.push("/learn")}
        className="mb-4 flex items-center gap-1.5 text-sm text-ink-dim hover:text-ink cursor-pointer"
      >
        <ArrowLeft className="size-4" /> 学习教练
      </button>

      <PageHeader
        icon={<Sparkles className="size-5" />}
        title={goal.topic}
        desc={goal.direction}
        right={
          <div className="hidden sm:block">
            <ProgressRing value={progress.ratio} size={64} label={`${Math.round(progress.ratio * 100)}%`} />
          </div>
        }
      />

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
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          <PlanTimeline
            goal={goal}
            activeDayId={activeDay?.id ?? null}
            selectedDayId={viewDayId}
            onSelect={setViewDayId}
          />
          <DayPanel key={viewDay.id} goal={goal} day={viewDay} readOnly={viewDay.id !== activeDay?.id} />
        </div>
      )}
      {goal.plan && !viewDay && (
        <Card className="flex items-center justify-center py-16 text-ink-dim">
          🎉 全部阶段完成！去「第二大脑」看看你积累了什么。
        </Card>
      )}
    </div>
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
    <Card className="h-fit lg:sticky lg:top-8">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-dim">
        路径设计
      </p>
      <p className="mb-4 text-sm text-ink-dim">{plan.summary}</p>

      <div className="space-y-4">
        {plan.phases.map((phase, pi) => (
          <div key={phase.id}>
            <div className="flex items-center gap-2">
              <StatusDot status={phase.status} />
              <p className="text-sm font-bold text-white">
                阶段{pi + 1} · {phase.title}
              </p>
              {phase.status === "passed" && <Badge tone="ok">已通过</Badge>}
              {phase.status === "locked" && <Badge tone="dim">🔒 未解锁</Badge>}
            </div>
            <p className="mb-2 mt-1 pl-4 text-xs text-ink-dim">🏁 {phase.outcome}</p>
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
                        : "cursor-pointer hover:bg-white/5",
                      viewDayId === dayId && "bg-accent/15 text-white",
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
          className="mt-4 w-full cursor-pointer rounded-lg border border-border py-2 text-xs text-ink-dim hover:bg-white/5"
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
}: {
  goal: Goal;
  day: DayPlan;
  readOnly?: boolean;
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

  const done = day.status === "passed" || day.status === "skipped";

  /* 生成今日学习文档 */
  const genLesson = async () => {
    setLessonLoading(true);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const ctx = JSON.stringify(
        {
          goal: {
            topic: goal.topic,
            direction: goal.direction,
            background: goal.background,
            domainKind: goal.domainKind,
          },
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
        system: DAILY_LESSON(ctx),
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
      const ctx = JSON.stringify({
        day: day.title,
        items: day.acceptance.map((a) => ({ itemId: a.id, kind: a.kind, question: a.question })),
        answers,
      });
      const full = await streamChat({
        system: QUIZ_GRADE(ctx),
        messages: [{ role: "user", content: "开始评分。" }],
        temperature: 0.3,
        task: "quiz-grade",
        onDelta: () => {},
      });
      const g = quizGradeSchema.parse(extractJson(full));
      setGrade(g);
      setMode("result");
      store.getState().incrementAttempts(goal.id, day.id);

      if (g.overall === "pass") {
        store.getState().setDayStatus(goal.id, day.id, "passed");
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
              verdict: "pass",
              feedback: it.feedback,
            };
          }),
        });
        // 知识点进入第二大脑 + 间隔复习队列
        store.getState().addKnowledge(
          day.knowledgePoints.map((k) => ({ text: k.text, domain: goal.topic })),
          "learn",
          `${goal.topic} · ${day.title}`
        );
        toast.success("验收通过 🎉 下一阶段已解锁，知识点已存入第二大脑。");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "评分失败，请重试");
    } finally {
      setGrading(false);
    }
  };

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
    toast("已强制跳过，该阶段标记为 skipped，知识点未入第二大脑。", { icon: "⚠️" });
  };

  return (
    <div className="min-w-0 space-y-5">
      {/* 今日头部 */}
      <Card className={readOnly ? "" : "border-accent/30"}>
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
            <h2 className="mt-2 text-lg font-bold text-white">{day.title}</h2>
            <p className="mt-1 text-xs text-ink-dim">{day.method}</p>
          </div>
          {!done && !readOnly && mode === "learn" && (
            <Button onClick={() => setMode("quiz")} variant="ok">
              <Swords className="size-4" /> 开始验收
            </Button>
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
          <p className="text-xs font-semibold text-ink-dim">📚 学习资源（选一个顺手的）</p>
          {day.resources.map((r, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              {r.url ? (
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[#22d3ee] hover:underline"
                >
                  {r.title} <ExternalLink className="size-3.5" />
                </a>
              ) : (
                <span className="text-ink">{r.title}</span>
              )}
              <span className="text-xs text-ink-dim">— {r.why}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* ===== 学习模式 ===== */}
      {mode === "learn" && (
        <>
          <Card>
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-2 text-sm font-bold text-white">
                <BookMarked className="size-4 text-[#b7adff]" /> 学习文档
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
              <p className="text-sm font-bold text-white">🧩 {day.example.title}</p>
              <p className="mt-1 text-xs text-ink-dim">{day.example.description}</p>
              {day.example.code && (
                <pre className="mt-3 overflow-x-auto rounded-xl border border-border bg-[#0d1017] p-4 text-xs leading-relaxed text-[#d8e0f0]">
                  <code>{day.example.code}</code>
                </pre>
              )}
            </Card>
          )}
        </>
      )}

      {/* ===== 验收模式 ===== */}
      {mode === "quiz" && !readOnly && (
        <Card className="border-warn/40">
          <p className="text-sm font-bold text-white">
            ⚔️ 验收关卡 —— 逐条通过才能解锁下一阶段
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
            "animate-rise",
            grade.overall === "pass" ? "border-ok/50" : "border-bad/50"
          )}
        >
          <div className="flex items-center gap-2">
            {grade.overall === "pass" ? (
              <Badge tone="ok">验收通过</Badge>
            ) : (
              <Badge tone="bad">未通过</Badge>
            )}
            <p className="text-sm font-bold text-white">{grade.summary}</p>
          </div>
          <div className="mt-4 space-y-3">
            {day.acceptance.map((a, i) => {
              const r = grade.items.find((it) => it.itemId === a.id);
              if (!r) return null;
              return (
                <div key={a.id} className="rounded-xl border border-border bg-surface-2/60 p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm text-ink">
                      <span className="mr-2 text-ink-dim">第{i + 1}题</span>
                      {a.question}
                    </p>
                    {r.verdict === "pass" ? (
                      <Check className="mt-0.5 size-4 shrink-0 text-ok" />
                    ) : (
                      <CircleX className="mt-0.5 size-4 shrink-0 text-bad" />
                    )}
                  </div>
                  {answers[a.id] && (
                    <p className="mt-2 whitespace-pre-wrap rounded-lg bg-black/20 p-2.5 text-xs text-ink-dim">
                      你的回答：{answers[a.id]}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-ink-dim">
                    <span className={r.verdict === "pass" ? "text-ok" : "text-bad"}>
                      {r.verdict === "pass" ? "✓ " : "✗ "}
                    </span>
                    {r.feedback}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="mt-4 rounded-xl border border-accent/30 bg-accent/10 p-3.5 text-sm text-[#c9c2ff]">
            {grade.reviewAdvice}
          </div>
          {grade.overall === "pass" ? (
            <p className="mt-4 text-center text-sm text-ink-dim">
              🎉 已解锁下一任务，左侧时间线可查看。
            </p>
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
          <p className="mb-3 text-sm font-bold text-white">📜 历史验收记录</p>
          <div className="space-y-3">
            {goal.quizLog
              .filter((q) => q.dayId === day.id)
              .map((q, i) => (
                <div key={i} className="rounded-xl border border-border bg-surface-2/60 p-3 text-xs text-ink-dim">
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

      {/* 强制跳过 */}
      {mode === "learn" && !done && !readOnly && (
        <button
          onClick={() => setSkipConfirm(true)}
          className="w-full cursor-pointer rounded-xl border border-dashed border-warn/30 py-2.5 text-xs text-warn/70 hover:bg-warn/5"
        >
          学不会也要跳过这个阶段？（强硬跳过会被记录）
        </button>
      )}
      <Modal open={skipConfirm} onClose={() => setSkipConfirm(false)} title="强制跳过确认">
        <p className="text-sm text-ink-dim">
          当前阶段的知识点<b className="text-ink">不会</b>存入第二大脑，也不会进入复习队列。
          后续阶段的内容可能依赖它 —— 这是你的选择，系统尊重并记录它。
        </p>
        <Input
          className="mt-4"
          placeholder='输入「跳过」确认'
          value={skipText}
          onChange={(e) => setSkipText(e.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setSkipConfirm(false)}>
            我再学学
          </Button>
          <Button variant="danger" onClick={forceSkip}>
            确认跳过
          </Button>
        </div>
      </Modal>
    </div>
  );
}
