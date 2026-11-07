"use client";

/* 学习人生页（借鉴 alice.fans 的"她的生活"）：把学习记录变成可回看的人生流——
 * 朋友圈式时间线（验收通过/跳过/圆桌/掌握里程碑）+ AI 教练定期发帖 + 里程碑相册格。
 * 纯前端聚合现有数据，零新存储；AI 教练帖按需生成（每次进页可刷新一条）。 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, BookOpen, Brain, Compass, Flame, GraduationCap, Play, Zap } from "lucide-react";
import { Badge, Button, Card, PageHeader, ProgressRing, Skeleton, StatusDot } from "@/components/ui";
import { StudyHeatmap } from "@/components/learn/study-heatmap";
import { useDueReviews } from "@/lib/store";
import { useAppStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { cn } from "@/lib/utils";

interface LifeEvent {
  at: string; // ISO
  kind: "pass" | "skip" | "fail" | "mastered" | "council" | "book";
  title: string;
  detail?: string;
}

export function LifeWorkspace() {
  const hydrated = useHydrated();
  const goals = useAppStore((s) => s.goals);
  const knowledge = useAppStore((s) => s.knowledge);
  const sessions = useAppStore((s) => s.sessions);
  const userName = useAppStore((s) => s.settings.userName);
  const router = useRouter();
  const due = useDueReviews();
  const books = useAppStore((s) => s.books);
  const activeGoal = goals.find((g) => g.status === "active");
  const readingBook = books.find((b) => b.status === "reading");
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
  const [post, setPost] = useState<string>("");
  const [postBusy, setPostBusy] = useState(false);

  const events = useMemo<LifeEvent[]>(() => {
    const out: LifeEvent[] = [];
    for (const g of goals) {
      for (const q of g.quizLog ?? []) {
        const day = g.plan?.days[q.dayId];
        out.push({
          at: new Date(q.date).toISOString(),
          kind: q.forced ? "skip" : q.passed ? "pass" : "fail",
          title: q.forced ? `跳过了「${day?.title ?? q.dayId}」` : q.passed ? `通过了「${day?.title ?? q.dayId}」的验收` : `「${day?.title ?? q.dayId}」验收未通过`,
          detail: g.topic,
        });
      }
    }
    for (const k of knowledge) {
      if (!k.masteredAt) continue;
      /* V26.1 §7.4：目录/总纲要/计划骨架不是"能力证据"，不进学习人生（结果层而非日志层） */
      const isSkeleton = /目录$|学习总纲要$/.test(k.title) || (k.tags ?? []).includes("MOC");
      if (isSkeleton) continue;
      out.push({ at: new Date(k.masteredAt).toISOString(), kind: "mastered", title: `掌握了「${k.title}」`, detail: k.domain });
    }
    for (const s of sessions) {
      if (s.createdAt) out.push({ at: new Date(s.createdAt).toISOString(), kind: "council", title: `圆桌：${s.title}`, detail: "人生伙伴" });
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : -1));
  }, [goals, knowledge, sessions]);

  const streak = useMemo(() => {
    const days = new Set(events.map((e) => e.at.slice(0, 10)));
    let n = 0;
    const d = new Date();
    for (;;) {
      const key = d.toISOString().slice(0, 10);
      if (days.has(key)) { n++; d.setDate(d.getDate() - 1); }
      else if (n === 0 && key === new Date().toISOString().slice(0, 10)) { d.setDate(d.getDate() - 1); }
      else break;
    }
    return n;
  }, [events]);

  const genPost = async () => {
    if (postBusy) return;
    setPostBusy(true);
    try {
      /* 文案与 prompt 都承诺「近 7 天」：真的按 7 天过滤，而不是取最新 12 条 */
      const weekAgo = Date.now() - 7 * 86400_000;
      const recent = events
        .filter((e) => new Date(e.at).getTime() >= weekAgo)
        .slice(0, 12)
        .map((e) => ({ date: e.at.slice(5, 10), what: e.title }));
      const { streamChat } = await import("@/lib/ai/client");
      const full = await streamChat({
        task: "life-post",
        args: { events: JSON.stringify(recent), streak },
        messages: [{ role: "user", content: "发一条。" }],
        temperature: 0.7,
        onDelta: () => {},
      });
      setPost(full.trim());
    } catch {
      setPost("今天教练没上线，先自己记录一段。");
    } finally {
      setPostBusy(false);
    }
  };

  /* 色板只用 globals.css @theme 里真实定义的 token。
   * 此前写的 text-info / bg-info / text-primary 在 @theme 里不存在，
   * Tailwind v4 不生成这些类，图标与标签实际是继承色（看起来"颜色没生效"）。 */
  const KIND_META: Record<LifeEvent["kind"], { label: string; cls: string }> = {
    pass: { label: "验收通过", cls: "text-ok" },
    skip: { label: "跳过", cls: "text-warn" },
    fail: { label: "验收未过", cls: "text-bad" },
    mastered: { label: "新掌握", cls: "text-accent" },
    council: { label: "圆桌", cls: "text-accent-2" },
    book: { label: "读书", cls: "text-ink-dim" },
  };

  if (!hydrated) return <Skeleton className="h-64 rounded-2xl bg-surface/60" />;

  return (
    <div>
      <PageHeader title="学习人生" desc={`${userName || "你"} 的学习足迹——不只是记录，是回看自己怎么走过来的。`} />

      {/* ===== 学习仪表盘（v22.0 从首页下沉到此）===== */}
      <div className="mb-5">
        <StudyHeatmap />
      </div>

      <div className="mb-5 grid gap-4 md:grid-cols-2">
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
              <button onClick={() => router.push("/learn")} className="ml-1 cursor-pointer text-accent hover:underline">
                开一个新的 →
              </button>
            </p>
          )}
        </Card>

        <Card className="card-lift cursor-pointer transition hover:border-accent/50" onClick={() => router.push("/brain")}>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
            <Zap className="size-4" /> 笔记与复习
          </p>
          <p className="tabular mt-3 text-3xl font-extrabold text-ink">
            {knowledge.length} <span className="text-sm font-normal text-ink-dim">条知识</span>
          </p>
          {due.length > 0 ? (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-accent">
              <Badge tone="warn">{due.length} 条待复习</Badge> 点此去刷
            </p>
          ) : (
            <p className="mt-2 text-[11px] leading-relaxed text-ink-dim">
              没有待复习。验收通过的知识点自动进入；导入与手写笔记可在笔记里点「加入复习」。
            </p>
          )}
        </Card>

        <Card
          className="card-lift cursor-pointer transition hover:border-accent/50"
          onClick={() => router.push(readingBook ? `/read/${readingBook.id}` : "/read")}
        >
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
            <BookOpen className="size-4" /> 读书伙伴
          </p>
          {readingBook ? (
            <>
              <h3 className="mt-3 truncate text-lg font-bold text-ink">《{readingBook.title}》</h3>
              <p className="mt-1.5 text-sm text-ink-dim">
                {readingBook.chapters.filter((c) => c.status === "done").length}/{readingBook.chapters.length} 章 · 洞见 {readingBook.insights.length} 条
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

        <Card className="cursor-pointer transition hover:border-accent/50 md:col-span-2" onClick={() => router.push("/council")}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
                <Compass className="size-4" /> 人生伙伴
              </p>
              <p className="mt-3 text-sm leading-relaxed text-ink-dim">拿不定的事，扔过来。他们不说客套话。</p>
            </div>
            <Button variant="outline" className="shrink-0">
              <Brain className="size-4" /> 进入
            </Button>
          </div>
        </Card>
      </div>

      {/* AI 教练的朋友圈动态 */}
      <Card className="mb-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-xl bg-ink text-[13px] font-bold text-white">M</div>
            <div>
              <p className="text-[13px] font-bold text-ink">Mentora 教练</p>
              <p className="text-[11px] text-ink-dim/70">你的学习教练 · 每次进来会更新动态</p>
            </div>
          </div>
          <Button variant="outline" size="sm" loading={postBusy} onClick={genPost}>
            {post ? "换一条" : "看教练怎么说"}
          </Button>
        </div>
        <div className="mt-3 whitespace-pre-wrap rounded-xl bg-surface-2/70 p-3.5 text-[13px] leading-relaxed text-ink">
          {post || "点「看教练怎么说」，教练会根据你最近 7 天的真实学习事件，发一条朋友圈式的动态。不编造、不空夸。"}
        </div>
        <p className="mt-2 text-[11px] text-ink-dim/60">连续学习 {streak} 天</p>
      </Card>

      {/* 里程碑相册格（最近 8 个验收通过） */}
      <Card className="mb-5">
        <p className="mb-3 text-sm font-bold text-ink">里程碑</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-8">
          {events.filter((e) => e.kind === "pass").slice(0, 8).map((e, i) => (
            <div
              key={i}
              title={`${e.title}（${e.at.slice(0, 10)}）`}
              className="flex aspect-square flex-col items-center justify-center rounded-xl border border-ok/25 bg-ok/[0.06] p-1 text-center"
            >
              <span className="line-clamp-2 text-[10px] leading-tight text-ok">{e.detail}</span>
              <span className="mt-0.5 text-[9px] text-ink-dim/60">{e.at.slice(5, 10)}</span>
            </div>
          ))}
          {events.filter((e) => e.kind === "pass").length === 0 && (
            <p className="col-span-full py-6 text-center text-xs text-ink-dim">还没有里程碑。第一次验收通过会出现在这里。</p>
          )}
        </div>
      </Card>

      {goals.length === 0 && books.length === 0 && knowledge.length === 0 && (
        <Card className="mb-5 border-accent/25 bg-accent/[0.035]">
          <h2 className="text-base font-bold text-ink">还没有开始</h2>
          <p className="mt-1 text-xs text-ink-dim">三步走完第一次完整闭环；也可以在首页直接问问题。</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => router.push("/learn")}>
              <GraduationCap className="size-4" /> 开始第一个目标
            </Button>
            <Button variant="outline" onClick={() => router.push("/")}>
              <Play className="size-4" /> 回首页问 Mentora
            </Button>
          </div>
        </Card>
      )}

      {/* 时间线 */}
      <Card>
        <p className="mb-3 text-sm font-bold text-ink">足迹</p>
        <div className="space-y-0">
          {events.slice(0, 40).map((e, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", e.kind === "pass" ? "bg-ok" : e.kind === "fail" ? "bg-bad" : e.kind === "mastered" ? "bg-accent" : e.kind === "council" ? "bg-accent-2" : "bg-ink-dim/30")} />
                {i < Math.min(events.length, 40) - 1 && <span className="w-px flex-1 bg-border" />}
              </div>
              <div className="pb-4">
                <p className="text-[13px] text-ink">
                  <span className={cn("mr-2 text-[11px] font-semibold", KIND_META[e.kind].cls)}>{KIND_META[e.kind].label}</span>
                  {e.title}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-dim/60">{e.at.slice(0, 10)}{e.detail ? ` · ${e.detail}` : ""}</p>
              </div>
            </div>
          ))}
          {events.length === 0 && (
            <p className="py-10 text-center text-sm text-ink-dim">还没有足迹。去学习教练开始第一个目标。</p>
          )}
        </div>
      </Card>
    </div>
  );
}
