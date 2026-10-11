"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, PageHeader, ProgressRing, StatusDot } from "@/components/ui";
import { useAppStore, useDueReviews } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { useAuth } from "@/lib/auth-client";
import Landing from "@/components/landing";
import { StudyHeatmap } from "@/components/learn/study-heatmap";
import { periodOf, PERIOD_GREETING } from "@/lib/period";
import { cn, streakFrom } from "@/lib/utils";
import {
  ArrowRight, BookOpen, Brain, Compass, Flame, GraduationCap, Play, Zap,
} from "lucide-react";

export default function Home() {
  const { user, checking } = useAuth();
  if (checking) return <div className="min-h-screen" />;
  if (!user) return <Landing />;
  return <Dashboard />;
}

function Dashboard() {
  const hydrated = useHydrated();
  const router = useRouter();
  const userName = useAppStore((s) => s.settings.userName);
  const goals = useAppStore((s) => s.goals);
  const books = useAppStore((s) => s.books);
  const knowledge = useAppStore((s) => s.knowledge);
  const due = useDueReviews();

  const activeGoal = goals.find((g) => g.status === "active");
  const readingBook = books.find((b) => b.status === "reading");
  const streak = streakFrom(knowledge.map((k) => k.masteredAt));

  const activeDay = activeGoal?.plan
    ? Object.values(activeGoal.plan.days).find((d) => d.status === "active")
    : null;
  const progress = activeGoal?.plan
    ? (() => {
        const days = Object.values(activeGoal.plan.days);
        const done = days.filter((d) => d.status !== "locked").length;
        return days.length ? done / days.length : 0;
      })()
    : 0;

  if (!hydrated) return <div className="h-64 animate-pulse rounded-2xl bg-surface/60" />;

  const seedSampleGoal = useAppStore((s) => s.seedSampleGoal);
  const isEmpty = goals.length === 0 && books.length === 0 && knowledge.length === 0;

  return (
    <div>
      <PageHeader
        title={userName ? `${userName}，继续。` : "继续。"}
        desc={`${PERIOD_GREETING[periodOf()]} 今天学什么、复习什么，都在这一页。`}
      />

      {isEmpty ? (
        <Card className="border-accent/25 bg-accent/[0.035]">
          <h2 className="text-lg font-bold text-ink">欢迎来到 Mentora</h2>
          <p className="mt-1 text-xs text-ink-dim">三步走完第一次完整闭环。不想从零开始？直接用下面的示例目标试。</p>
          <div className="mt-4 space-y-2.5 text-sm text-ink-dim">
            <p><b className="text-ink">① 说出你想学的。</b>教练问你一两个关键问题，就排出计划。<span className="ml-1 text-[11px] text-ink-dim/70">（找不到方向？教练页有「聊出方向」）</span></p>
            <p><b className="text-ink">② 每天一课。</b>做完产出、通过验收才放行，笔记自动进你的知识库。</p>
            <p><b className="text-ink">③ 验收通过的会流进第二大脑</b>，按遗忘曲线提醒复习，学习日历上留下你的格子。</p>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button onClick={() => router.push("/learn")}>
              <GraduationCap className="size-4" /> 开始第一个目标
            </Button>
            <Button variant="outline" onClick={() => router.push(`/learn/${seedSampleGoal()}`)}>
              <Play className="size-4" /> 用示例目标试一试
            </Button>
            <Button variant="ghost" onClick={() => router.push("/settings")}>
              先连接模型（或用演示模式）
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {/* 学习日历：可看见的成长（热力墙+回溯） */}
          <div className="md:col-span-2">
            <StudyHeatmap />
          </div>
          {/* 当前学习 */}
          <Card className="card-lift md:col-span-2">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
                <GraduationCap className="size-4" /> 学习进行时
              </p>
              {streak > 0 && (
                <Badge tone="warn">
                  <Flame className="size-3" /> 连续 {streak} 天
                </Badge>
              )}
            </div>
            {activeGoal ? (
              <div className="mt-4 flex items-center gap-5">
                <ProgressRing value={progress} size={72} label={`${Math.round(progress * 100)}%`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-ink">{activeGoal.topic}</h3>
                    <Badge tone="accent">进行中</Badge>
                  </div>
                  {activeDay ? (
                    <p className="mt-1 flex items-center gap-1.5 truncate text-sm text-ink-dim">
                      <StatusDot status="active" /> {activeDay.title}
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-ok">全部完成</p>
                  )}
                  <Button size="sm" className="mt-3" onClick={() => router.push(`/learn/${activeGoal.id}`)}>
                    {activeDay ? "继续今天的学习" : "查看成果"} <ArrowRight className="size-3.5" />
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-ink-dim">
                没有进行中的目标。
                <Link href="/learn" className="ml-1 text-accent hover:underline">
                  开一个新的 →
                </Link>
              </p>
            )}
          </Card>

          {/* 复习 */}
          <Card
            className={cn("card-lift cursor-pointer transition hover:border-accent/50", due.length > 0 && "border-accent/40")}
            onClick={() => router.push("/brain")}
          >
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
              <Zap className="size-4" /> 第二大脑
            </p>
            <p className="tabular mt-3 text-3xl font-extrabold text-ink">
              {knowledge.length} <span className="text-sm font-normal text-ink-dim">条知识</span>
            </p>
            {due.length > 0 ? (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-accent">
                <Badge tone="warn">{due.length} 条待复习</Badge> 点此去刷
              </p>
            ) : (
              <p className="mt-2 text-sm text-ink-dim">该刷的都刷完了。</p>
            )}
          </Card>

          {/* 读书 */}
          <Card className="card-lift cursor-pointer transition hover:border-accent/50" onClick={() => router.push(readingBook ? `/read/${readingBook.id}` : "/read")}>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
              <BookOpen className="size-4" /> 读书伙伴
            </p>
            {readingBook ? (
              <>
                <h3 className="mt-3 truncate text-lg font-bold text-ink">《{readingBook.title}》</h3>
                <p className="mt-1.5 text-sm text-ink-dim">
                  {readingBook.chapters.filter((c) => c.status === "done").length}/
                  {readingBook.chapters.length} 章 · 洞见 {readingBook.insights.length} 条
                </p>
                <p className="mt-3 text-sm text-accent">继续阅读 →</p>
              </>
            ) : (
              <>
                <p className="mt-3 text-sm text-ink-dim">书架空着。挑一本书，带着问题读。</p>
                <p className="mt-3 text-sm text-accent">去添加 →</p>
              </>
            )}
          </Card>

          {/* 人生伙伴 */}
          <Card
            className="cursor-pointer transition hover:border-accent/50 md:col-span-2"
            onClick={() => router.push("/council")}
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
                  <Compass className="size-4" /> 人生伙伴
                </p>
                <p className="mt-3 text-sm leading-relaxed text-ink-dim">
                  拿不定的事，扔过来。他们不说客套话。
                </p>
              </div>
              <Button variant="outline" className="shrink-0">
                <Brain className="size-4" /> 进入
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
