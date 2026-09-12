"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, PageHeader, ProgressRing, StatusDot } from "@/components/ui";
import { useAppStore, useDueReviews } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { cn, streakFrom } from "@/lib/utils";
import {
  ArrowRight, BookOpen, Brain, Compass, Flame, GraduationCap, Sparkles, Zap,
} from "lucide-react";

export default function Dashboard() {
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

  const isEmpty = goals.length === 0 && books.length === 0 && knowledge.length === 0;

  return (
    <div>
      <PageHeader
        icon={<Sparkles className="size-5" />}
        title={userName ? `${userName}，今天推进什么？` : "今天推进什么？"}
        desc="学习教练 × 第二大脑 × 读书伙伴 × 人生伙伴 —— 一套完整认知操作系统"
      />

      {isEmpty ? (
        <Card className="border-accent/40 bg-gradient-to-br from-accent/10 to-cyan-500/5">
          <h2 className="text-lg font-bold text-white">👋 欢迎来到 Mentora</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-dim">
            三步开始：
            <b className="text-ink"> ① 学习教练</b> 里输入你想学的东西，教练会用苏格拉底式追问帮你把模糊的愿望变成清晰的目标和计划；
            <b className="text-ink"> ②</b> 每天的学习文档 + 逐条验收，通过才解锁下一阶段，知识点自动沉淀到<b className="text-ink">第二大脑</b>并按 1/3/7/15 天复习；
            <b className="text-ink"> ③</b> 困惑和焦虑随时扔给<b className="text-ink">人生伙伴</b>——12 位智者的思维方式给你独立判断。
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button onClick={() => router.push("/learn")}>
              <GraduationCap className="size-4" /> 开始第一个目标
            </Button>
            <Button variant="outline" onClick={() => router.push("/settings")}>
              先连接模型（或用演示模式）
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {/* 当前学习 */}
          <Card className="md:col-span-2">
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
                    <h3 className="text-base font-bold text-white">{activeGoal.topic}</h3>
                    <Badge tone="accent">进行中</Badge>
                  </div>
                  {activeDay ? (
                    <p className="mt-1 flex items-center gap-1.5 truncate text-sm text-ink-dim">
                      <StatusDot status="active" /> {activeDay.title}
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-ok">全部完成 🎉</p>
                  )}
                  <Button size="sm" className="mt-3" onClick={() => router.push(`/learn/${activeGoal.id}`)}>
                    {activeDay ? "继续今天的学习" : "查看成果"} <ArrowRight className="size-3.5" />
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-ink-dim">
                没有进行中的目标。
                <Link href="/learn" className="ml-1 text-[#22d3ee] hover:underline">
                  开一个新的 →
                </Link>
              </p>
            )}
          </Card>

          {/* 复习 */}
          <Card
            className={cn("cursor-pointer transition hover:border-accent/50", due.length > 0 && "border-accent/40")}
            onClick={() => router.push("/brain")}
          >
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
              <Zap className="size-4" /> 第二大脑
            </p>
            <p className="mt-3 text-3xl font-extrabold text-white">
              {knowledge.length} <span className="text-sm font-normal text-ink-dim">条知识</span>
            </p>
            {due.length > 0 ? (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-[#b7adff]">
                <Badge tone="warn">{due.length} 条待复习</Badge> 点此去刷
              </p>
            ) : (
              <p className="mt-2 text-sm text-ink-dim">今日复习已完成，记忆曲线稳着呢</p>
            )}
          </Card>

          {/* 读书 */}
          <Card className="cursor-pointer transition hover:border-accent/50" onClick={() => router.push(readingBook ? `/read/${readingBook.id}` : "/read")}>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
              <BookOpen className="size-4" /> 读书伙伴
            </p>
            {readingBook ? (
              <>
                <h3 className="mt-3 truncate text-lg font-bold text-white">《{readingBook.title}》</h3>
                <p className="mt-1.5 text-sm text-ink-dim">
                  {readingBook.chapters.filter((c) => c.status === "done").length}/
                  {readingBook.chapters.length} 章 · 洞见 {readingBook.insights.length} 条
                </p>
                <p className="mt-3 text-sm text-[#22d3ee]">继续阅读 →</p>
              </>
            ) : (
              <>
                <p className="mt-3 text-sm text-ink-dim">书架空着。挑一本书，带着问题读。</p>
                <p className="mt-3 text-sm text-[#22d3ee]">去添加 →</p>
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
                  有焦虑、决策、自我怀疑？扔过来。「AI 会不会取代我」这种问题，它会先纠正你问法，再给你判断。
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
