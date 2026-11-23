"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, PageHeader, Skeleton, Button } from "@/components/ui";
import { StudyHeatmap } from "@/components/learn/study-heatmap";
import { useAppStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { ArrowRight, BookOpen, Check, FileText, GraduationCap, MessagesSquare, SkipForward, X } from "lucide-react";
import { cn, addDays, todayISO } from "@/lib/utils";
interface LifeEvent {
  id: string;
  href: string;
  at: string; // ISO
  kind: "pass" | "skip" | "fail" | "mastered" | "council" | "book";
  title: string;
  detail?: string;
}

/* quizLog.date / knowledge.masteredAt / session.createdAt 一律是 UTC 日或 ISO 字符串
 * （utils.ts 不变量）。但 store.ts 的 sanitizeBackup 对 quizLog 只校验「是数组」、
 * 不校验元素 date 字段（备份文件/云端快照共用同一入口），坏日期可原样进 store；
 * new Date(坏值).toISOString() 会抛 RangeError，在渲染期 useMemo 里炸掉整个 /life 页。
 * 与 study-heatmap.tsx 的 dayKey 同口径：取不到合法时间就跳过该条，
 * 单条脏数据绝不毁掉整页。 */
function safeISO(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function LifeWorkspace() {
  const hydrated = useHydrated();
  const goals = useAppStore(s => s.goals);
  const knowledge = useAppStore(s => s.knowledge);
  const sessions = useAppStore(s => s.sessions);
  const books = useAppStore(s => s.books);
  const [limit, setLimit] = useState(5);
  const events = useMemo<LifeEvent[]>(() => {
    const out: LifeEvent[] = [];
    for (const g of goals) {
      for (const [index, q] of (g.quizLog ?? []).entries()) {
        const at = safeISO(q.date);
        if (!at) continue;
        const day = g.plan?.days[q.dayId];
        out.push({
          id: `quiz:${g.id}:${index}`,
          href: `/learn/${encodeURIComponent(g.id)}`,
          at,
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
      const at = safeISO(k.masteredAt);
      if (!at) continue;
      out.push({ id: `knowledge:${k.id}`, href: `/brain?note=${encodeURIComponent(k.id)}`, at, kind: "mastered", title: `沉淀了「${k.title}」`, detail: k.domain });
    }
    for (const s of sessions) {
      const at = safeISO(s.createdAt);
      if (at) out.push({ id: `council:${s.id}`, href: `/council?session=${encodeURIComponent(s.id)}`, at, kind: "council", title: `对话：${s.title}`, detail: "人生伙伴" });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  }, [goals, knowledge, sessions]);

  const today = todayISO();
  const weekStart = addDays(-6, today);
  const recentCount = events.filter(e => e.at.slice(0,10) >= weekStart && e.at.slice(0,10) <= today).length;
  const activeGoals = goals.filter(g => g.status === "active");
  const reading = books.find(b => b.status === "reading" && (b.verification === "verified" || (b.verification === "user_material" && b.pastedText?.trim())));
  const meta = {
    pass: { label: "验收通过", icon: Check, tone: "bg-ok/10 text-ok" },
    fail: { label: "继续巩固", icon: X, tone: "bg-warn/10 text-warn" },
    skip: { label: "跳过", icon: SkipForward, tone: "bg-surface-2 text-ink-dim" },
    mastered: { label: "笔记沉淀", icon: FileText, tone: "bg-accent/10 text-accent" },
    council: { label: "对话", icon: MessagesSquare, tone: "bg-surface-2 text-ink-dim" },
    book: { label: "阅读", icon: BookOpen, tone: "bg-accent/10 text-accent" },
  };
  if (!hydrated) return <Skeleton className="h-64" />;
  return <div className="mx-auto w-full max-w-6xl">
    <PageHeader title="成长记录" desc="看见积累，也知道下一步从哪里继续。" right={<Link href="/learn" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-surface px-4 text-sm text-ink">回到学习 <ArrowRight className="size-4" /></Link>} />
    <div className="mb-6 grid grid-cols-3 divide-x divide-border rounded-2xl border border-border bg-surface py-4 sm:py-5" aria-label="学习概览">
      {[
        { label: "近 7 天足迹", value: recentCount, unit: "条" },
        { label: "累计验收通过", value: events.filter(e => e.kind === "pass").length, unit: "次" },
        { label: "进行中的目标", value: activeGoals.length, unit: "个" },
      ].map(item => <div key={item.label} className="min-w-0 px-3 sm:px-6"><p className="text-xs leading-5 text-ink-dim">{item.label}</p><p className="mt-2 text-2xl font-semibold tracking-tight text-ink tabular-nums sm:text-3xl">{item.value}<span className="ml-1 text-xs font-normal text-ink-dim">{item.unit}</span></p></div>)}
    </div>
    <div className="growth-layout" data-testid="growth-layout">
      <Card id="growth-history">
        <div className="mb-2 flex items-baseline justify-between gap-3"><h2 className="text-base font-semibold text-ink">最近足迹</h2><span className="text-xs text-ink-dim">{events.length} 条记录</span></div>
        <p className="mb-4 text-xs text-ink-dim">每一步都有来处，点击回看。</p>
        <ul className="divide-y divide-border">
          {events.slice(0, limit).map(e => {
            const style = meta[e.kind];
            const Icon = style.icon;
            return <li key={e.id}>
              <Link href={e.href} className="group flex min-h-20 items-start gap-3 rounded-xl py-4 transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent sm:gap-4">
                <span className={cn("mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl", style.tone)}><Icon className="size-4" /></span>
                <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-dim"><span>{style.label}</span><time dateTime={e.at}>{e.at.slice(0,10)}</time></span><span className="growth-event-title mt-1.5 text-sm font-medium leading-relaxed text-ink" title={e.title}>{e.title}</span><span className="growth-event-detail mt-1 text-xs text-ink-dim">{e.detail}</span></span>
                <ArrowRight className="mt-5 size-4 shrink-0 text-ink-dim/50 transition group-hover:text-accent" />
              </Link>
            </li>;
          })}
        </ul>
        {!events.length && <div className="my-3 rounded-xl bg-surface-2 px-5 py-9 text-center"><GraduationCap className="mx-auto mb-3 size-7 text-accent" /><p className="text-sm font-medium text-ink">从一次学习开始，留下你的第一步</p><p className="mt-2 text-xs leading-relaxed text-ink-dim">验收、笔记和对话，会在这里汇成你的足迹。</p><Link className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-accent" href="/learn">开始学习 <ArrowRight className="size-4" /></Link></div>}
        {events.length > limit && <Button variant="ghost" className="mt-3 w-full border border-border" onClick={() => setLimit(n => n + 10)}>查看更多记录 · 还有 {events.length-limit} 条</Button>}
      </Card>
      <aside className="min-w-0 space-y-5">
        <Card>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><GraduationCap className="size-4 text-accent" /> 接着学</h2>
          {activeGoals.slice(0,2).map(g => {
            const days = Object.values(g.plan?.days ?? {});
            const passed = days.filter(d => d.status === "passed").length;
            const skipped = days.filter(d => d.status === "skipped").length;
            const current = days.find(d => d.status === "active");
            const percent = days.length ? Math.round((passed+skipped)/days.length*100) : 0;
            return <div key={g.id} className="mt-4 border-t border-border pt-4 first:border-0">
              <p className="line-clamp-2 text-sm font-semibold text-ink [overflow-wrap:anywhere]" title={g.topic}>{g.topic}</p>
              <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-dim">{current?.title ?? (!g.plan ? "完善计划，开始第一课" : percent === 100 ? "计划已完成，可以回看成果" : "打开计划，选择下一课")}</p>
              {days.length > 0 && <><div role="progressbar" aria-label={`${g.topic}计划完成进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent" style={{width:`${percent}%`}} /></div><p className="mt-2 text-xs text-ink-dim">通过 {passed}/{days.length} 课{skipped > 0 ? ` · 跳过 ${skipped} 课` : ""}</p></>}
              <Link className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-accent" href={`/learn/${encodeURIComponent(g.id)}`}>{current ? "继续学习" : "打开学习计划"}<ArrowRight className="size-4" /></Link>
            </div>;
          })}
          {!activeGoals.length && <p className="mt-3 text-sm leading-relaxed text-ink-dim">暂时没有进行中的目标。<Link href="/learn" className="mt-3 inline-flex min-h-11 items-center text-accent">找到想学的东西 →</Link></p>}
          {activeGoals.length > 2 && <Link href="/learn" className="mt-3 block text-xs text-accent">查看全部 {activeGoals.length} 个目标 →</Link>}
          {reading && <Link className="mt-4 flex min-h-14 items-center gap-3 rounded-xl bg-surface-2 p-3 text-sm text-ink" href={`/read/${encodeURIComponent(reading.id)}`}><BookOpen className="size-4 shrink-0 text-accent" /><span className="min-w-0"><span className="block text-xs text-ink-dim">继续阅读</span><span className="line-clamp-1">{reading.title}</span></span></Link>}
        </Card>
        <details className="rounded-2xl border border-border bg-surface p-5"><summary className="min-h-7 cursor-pointer text-sm font-medium text-ink">学习日历<span className="ml-2 text-xs font-normal text-ink-dim">按需展开</span></summary><div className="mt-4"><StudyHeatmap /></div></details>
      </aside>
    </div>
  </div>;
}
